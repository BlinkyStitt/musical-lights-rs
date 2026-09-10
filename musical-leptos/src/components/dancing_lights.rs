use crate::wasm_audio::AudioSession;
use leptos::prelude::*;
use log::warn;
use musical_lights_core::{
    audio::{BarkBank, DISPLAY_BANDS},
    lights::Gradient,
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

#[derive(Clone)]
struct SessionOwner {
    alive: Rc<Cell<bool>>,
    session: Rc<RefCell<Option<AudioSession>>>,
}

#[component]
pub fn DancingLights() -> impl IntoView {
    let (audio, set_audio) = signal([0.0; DISPLAY_BANDS]);
    let (listening, set_listening) = signal(false);
    let (starting, set_starting) = signal(false);
    let (error, set_error) = signal(None::<String>);
    let (sample_rate, set_sample_rate) = signal(0.0);
    let owner = StoredValue::new_local(SessionOwner {
        alive: Rc::new(Cell::new(true)),
        session: Rc::new(RefCell::new(None)),
    });
    on_cleanup(move || {
        owner.with_value(|owner| {
            owner.alive.set(false);
            if let Some(session) = owner.session.borrow_mut().take() {
                session.stop();
            }
        })
    });
    let gradient = Gradient::<DISPLAY_BANDS>::new_rainbow(100.0, 75.0);
    let colors: Vec<_> = gradient
        .rgb_colors
        .iter()
        .map(|c| format!("#{:02X}{:02X}{:02X}", c.r, c.g, c.b))
        .collect();
    let start = move |_| {
        if starting.get_untracked() || listening.get_untracked() {
            return;
        }
        set_error.set(None);
        let session = match AudioSession::new() {
            Ok(session) => session,
            Err(error) => {
                set_error.set(Some(format!("Audio context: {error:?}")));
                return;
            }
        };
        let rate = session.sample_rate();
        let mut bank = match BarkBank::new(rate) {
            Ok(bank) => bank,
            Err(error) => {
                set_error.set(Some(error.to_string()));
                return;
            }
        };
        set_sample_rate.set(rate);
        set_starting.set(true);
        let owner = owner.get_value();
        *owner.session.borrow_mut() = Some(session.clone());
        let alive = owner.alive.clone();
        leptos::task::spawn_local(async move {
            let result = session
                .start(move |samples| {
                    if !alive.get() {
                        return;
                    }
                    match samples {
                        Some(samples) => match bank.push_samples(&samples) {
                            Ok(bins) => set_audio.set(bins.0),
                            Err(error) => {
                                set_audio.set([0.0; DISPLAY_BANDS]);
                                set_error.set(Some(error.to_string()));
                            }
                        },
                        None => set_audio.set([0.0; DISPLAY_BANDS]),
                    }
                })
                .await;
            // A route can close while getUserMedia is still awaiting permission.
            // Dropping its result releases any stream acquired after that close.
            if !owner.alive.get() {
                return;
            }
            set_starting.set(false);
            match result {
                Ok(()) => set_listening.set(true),
                Err(error) => {
                    if let Some(session) = owner.session.borrow_mut().take() {
                        session.stop();
                    }
                    set_error.set(Some(format!("Microphone: {error:?}")));
                }
            }
        });
    };
    view! {
        <button on:click=start disabled=move || starting.get() || listening.get()>
            {move || if starting.get() { "Starting microphone…" } else { "Start Dancing (Microphone Access Required)" }}
        </button>
        <Show when=move || listening.get()>
            <button on:click=move |_| {
                owner.with_value(|owner| {
                    if let Some(session) = owner.session.borrow_mut().take() { session.stop(); }
                });
                set_listening.set(false);
                set_audio.set([0.0; DISPLAY_BANDS]);
            }>"Stop listening"</button>
            <p>"Sample Rate: " {move || sample_rate.get()} " Hz"</p>
        </Show>
        <p role="alert">{move || error.get()}</p>
        <div id="dancinglights">
            {move || audio.get().into_iter().enumerate()
                .map(|(i, value)| audio_list_item(&colors[i], (value * 8.0) as u8)).collect_view()}
        </div>
    }
}

/// TODO: i think this should be a component, but references make that unhappy
pub fn audio_list_item(color: &str, x: u8) -> impl IntoView + use<> {
    let text = match x {
        0 => "󠀠",
        1 => "M",
        2 => "ME",
        3 => "MER",
        4 => "MERB",
        5 => "MERBO",
        6 => "MERBOT",
        7 => "MERBOTS ",
        8 => "MERBOTS!",
        _ => {
            // TODO: we used to have the index here. i think we want that back
            warn!("unexpected length for {}! {}", color, x);
            "ERROR!!!!"
        }
    };

    // TODO: show the frequency on hover
    view! {
        <div style={format!("background-color: {}; color: white;", color)}>{text}</div>
    }
}
