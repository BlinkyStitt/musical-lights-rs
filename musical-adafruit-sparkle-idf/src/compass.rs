//! Existing sensor-board state and UART tasks, separate from the net application.
use crate::sensor_uart::{UartFromSensors, UartToSensors};
use musical_lights_core::{
    compass::{Coordinate, Magnetometer},
    errors::MyError,
    logging::{error, info, warn},
    message::{Message, PeerId},
    orientation::Orientation,
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread::sleep,
    time::{Duration, Instant},
};
const MAX_PEERS: usize = 4;
/// TODO: add a lot more to this
/// TODO: max capacity on the HashMap?
/// TODO: include self in the main peer_coordinate map?
/// TODO: add a color pallet here?
#[derive(Clone, Default, Debug)]
pub struct State {
    pub orientation: Orientation,
    pub magnetometer: Option<Magnetometer>,
    /// TODO: should this be a bearing along with the coordinate?
    pub self_coordinate: Option<Coordinate>,
    pub self_id: Option<PeerId>,
    /// TODO: max peers is so that we dont run out of ram. what does this do when its full though?
    /// TODO: do we want their coordinates, or something else like our bearing to them?
    pub peer_coordinate: heapless::index_map::FnvIndexMap<PeerId, Coordinate, MAX_PEERS>,
    /// the SystemTime is the time from the GPS and the Instant is when we received it.
    /// TODO: There's probably a small offset needed. make a helper for adding them?
    /// TODO: think more about this
    pub time: Option<(std::time::SystemTime, Instant)>,
}

/// TODO: should state be in a RwLock? should it be a watch channel instead that we send things to and some other task does work on it?
pub fn read_from_sensors_task(
    message_to_sensors: flume::Sender<Message>,
    pong_received: &'static AtomicBool,
    state: &'static Mutex<State>,
    uart_from_sensors: &mut UartFromSensors<'static>,
) -> eyre::Result<()> {
    let process_message = |msg| {
        info!("received msg: {msg:?}");

        match msg {
            Message::Ping => {
                // i don't think we actually see pings on this side, but it works for now
                message_to_sensors
                    .send(Message::Pong)
                    .expect("failed to respond with pong");
            }
            Message::Pong => {
                // TODO: should this just be part of the state instead? Really not sure about Ordering
                pong_received.store(true, Ordering::SeqCst);
            }
            Message::Orientation(orientation) => {
                let mut state = state.lock().map_err(|_| MyError::PoisonLock)?;
                state.orientation = orientation;
            }
            Message::Magnetometer(mag) => {
                let mut state = state.lock().map_err(|_| MyError::PoisonLock)?;
                state.magnetometer = Some(mag);
            }
            Message::GpsTime(gps_time) => {
                warn!("not sure what to do with gps time. maybe instead connect to the pulse-per-second line? but we don't have many pins available");
            }
            Message::PeerCoordinate(peer_id, coordinate) => {
                let mut state = state.lock().map_err(|_| MyError::PoisonLock)?;
                if let Err((peer_id, peer_coord)) =
                    state.peer_coordinate.insert(peer_id, coordinate)
                {
                    error!("too many peers: {peer_id:?} @ {peer_coord:?}");
                };
            }
            Message::SelfCoordinate(coordinate) => {
                // TODO: on startup, the key needs to be passed to the sensor board so it can sign radio messages
                let mut state = state.lock().map_err(|_| MyError::PoisonLock)?;
                state.self_coordinate = Some(coordinate);
            }
        }

        // TODO: should we send state into a watch channel? or is a mutex enough? arcswap maybe?
        Ok::<_, MyError>(())
    };

    // TODO: no idea what the timeout should be
    // TODO: i think maybe we should use the async reader? we don't want a timeout
    if let Err(err) = uart_from_sensors.read_loop(process_message, 10) {
        error!("failed reading from uart");
        error!("{err:?}");
    };

    // TODO: once the read loop exits, what should we do? it exits when it isn't connected

    // TODO: ONLY in debug mode, run a mock loop. otherwise just set the state to something useful
    uart_from_sensors.mock_loop(process_message)?;

    Ok(())
}

pub fn send_to_sensors_task(
    message_to_sensors: flume::Receiver<Message>,
    pong_received: &'static AtomicBool,
    uart_to_sensors: &mut UartToSensors<'static>,
) -> eyre::Result<()> {
    // send a ping on an interval until we get a pong. then continue
    while !pong_received.load(Ordering::SeqCst) {
        info!("sending ping");
        uart_to_sensors.write(&Message::Ping)?;
        sleep(Duration::from_millis(100));
    }

    // listen on a channel to see if we need to send anything more. i don't think we will
    loop {
        let message = message_to_sensors.recv()?;

        info!("writing to uart");

        // TODO: if writing to the uart fails, we should just log the error but don't crash the app
        uart_to_sensors.write(&message)?;
    }
}
