use crate::{display::DisplayAnimation, screen::ScreenSession, wasm_audio::AudioSession};
use leptos::prelude::*;
use musical_lights_core::{
    audio::{BARK_EDGES, BarkBank, DISPLAY_BANDS},
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
    animation: Rc<RefCell<Option<DisplayAnimation>>>,
}

#[component]
pub fn DancingLights() -> impl IntoView {
    let colors = Gradient::<DISPLAY_BANDS>::new_rainbow(90.0, 58.0).rgb_colors;
    let (audio, set_audio) = signal([0.0; DISPLAY_BANDS]);
    let (listening, set_listening) = signal(false);
    let (starting, set_starting) = signal(false);
    let (error, set_error) = signal(None::<String>);
    let (sample_rate, set_sample_rate) = signal(0.0);
    let (frame_rate, set_frame_rate) = signal(None::<f64>);
    let (wake_status, set_wake_status) = signal(String::from("Keeping screen awake…"));
    let (fullscreen, set_fullscreen) = signal(false);
    let (fullscreen_available, set_fullscreen_available) = signal(false);
    let (screen_error, set_screen_error) = signal(String::new());
    let screen = StoredValue::new_local(None::<ScreenSession>);
    let card = NodeRef::<leptos::html::Section>::new();
    card.on_load(move |element| {
        let session = ScreenSession::new(&element, move |awake, full, available, error| {
            set_wake_status.set(awake);
            set_fullscreen.set(full);
            set_fullscreen_available.set(available);
            set_screen_error.set(error);
        });
        screen.set_value(Some(session));
    });
    on_cleanup(move || {
        screen.update_value(|session| {
            session.take();
        })
    });
    let owner = StoredValue::new_local(SessionOwner {
        alive: Rc::new(Cell::new(true)),
        session: Rc::new(RefCell::new(None)),
        animation: Rc::new(RefCell::new(None)),
    });
    on_cleanup(move || {
        owner.with_value(|owner| {
            owner.alive.set(false);
            if let Some(session) = owner.session.borrow_mut().take() {
                session.stop();
            }
            if let Some(animation) = owner.animation.borrow_mut().take() {
                animation.stop();
            }
        })
    });
    let start = move |_| {
        if starting.get_untracked() || listening.get_untracked() {
            return;
        }
        set_error.set(None);
        set_frame_rate.set(None);
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
        let Some(clock) = web_sys::window().and_then(|window| window.performance()) else {
            set_error.set(Some("The browser display clock is unavailable.".into()));
            return;
        };
        let owner = owner.get_value();
        let alive = owner.alive.clone();
        let animation = match DisplayAnimation::new(move |values, fps| {
            if !alive.get() {
                return;
            }
            if audio.get_untracked() != values {
                set_audio.set(values);
            }
            if let Some(fps) = fps {
                set_frame_rate.set(Some(fps));
            }
        }) {
            Ok(animation) => animation,
            Err(error) => {
                set_error.set(Some(format!("Display: {error:?}")));
                return;
            }
        };
        *owner.animation.borrow_mut() = Some(animation.clone());
        let mut error_until_ms = 0.0;
        set_sample_rate.set(rate);
        set_starting.set(true);
        *owner.session.borrow_mut() = Some(session.clone());
        let alive = owner.alive.clone();
        leptos::task::spawn_local(async move {
            let result = session
                .start(move |samples| {
                    if !alive.get() {
                        return;
                    }
                    let now_ms = clock.now();
                    let values = match bank.push_samples(&samples) {
                        Ok(frame) => {
                            if now_ms >= error_until_ms && error.get_untracked().is_some() {
                                set_error.set(None);
                            }
                            frame.bands().0
                        }
                        Err(error) => {
                            error_until_ms = now_ms + 350.0;
                            set_error.set(Some(error.to_string()));
                            [0.0; DISPLAY_BANDS]
                        }
                    };
                    animation.push(values);
                })
                .await;
            // A route can close while getUserMedia is still awaiting permission.
            // Its result releases any stream acquired after that close.
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
                    if let Some(animation) = owner.animation.borrow_mut().take() {
                        animation.stop();
                    }
                    set_frame_rate.set(None);
                    set_error.set(Some(format!("Microphone: {error:?}")));
                }
            }
        });
    };
    view! {
        <section class="audio-card" aria-label="Live audio spectrum" node_ref=card>
            <div class="audio-controls">
                <div class="button-row">
                    <Show when=move || !listening.get() fallback=move || view! {
                        <button class="primary" on:click=move |_| {
                            owner.with_value(|owner| {
                                if let Some(session) = owner.session.borrow_mut().take() { session.stop(); }
                                if let Some(animation) = owner.animation.borrow_mut().take() { animation.stop(); }
                            });
                            set_listening.set(false);
                            set_frame_rate.set(None);
                            set_error.set(None);
                            set_audio.set([0.0; DISPLAY_BANDS]);
                        }>"Stop listening"</button>
                    }>
                        <button class="primary" on:click=start disabled=move || starting.get()>
                            {move || if starting.get() { "Starting microphone…" } else { "Start listening" }}
                        </button>
                    </Show>
                    <button class="fullscreen-button" disabled=move || !fullscreen_available.get()
                        aria-pressed=move || fullscreen.get().to_string()
                        title=move || if fullscreen_available.get() { "Expand the visualizer" } else { "Fullscreen is unavailable in this browser" }
                        on:click=move |_| screen.with_value(|session| {
                            if let Some(session) = session { session.toggle_fullscreen(); }
                        })>
                        {move || if fullscreen.get() { "Exit fullscreen" } else { "Fullscreen" }}
                    </button>
                </div>
                <p class="mic-status" role="status">
                    {move || if starting.get() { "Waiting for microphone" } else if listening.get() {
                        "Listening · Mic on"
                    } else { "Microphone off" }}
                </p>
            </div>
            <div class="spectrum-panel">
                <div class="meter-guide" aria-hidden="true"><span>"LOUD"</span><span>"QUIET"</span></div>
                <div id="dancinglights" role="group" aria-label="Audio spectrum, bass to treble">
                    {BARK_EDGES.windows(2).enumerate().map(|(i, edges)| {
                        let label = format!("{}–{} Hz", edges[0], edges[1]);
                        let tooltip = label.clone();
                        let color = colors[i];
                        // The shared LED gradient uses linear sRGB channels.
                        let style = format!(
                            "--band-color: color(srgb-linear {} {} {});",
                            f32::from(color.r) / 255.0,
                            f32::from(color.g) / 255.0,
                            f32::from(color.b) / 255.0,
                        );
                        view! {
                        <div class="meter" role="meter" aria-label=label tabindex="0" style=style
                            aria-valuemin="0" aria-valuemax="100"
                            aria-valuenow=move || (audio.get()[i] * 100.0).round() as u32>
                            <div class="meter-fill" style:transform=move || format!("scaleY({})", audio.get()[i])></div>
                            <span class="frequency-tooltip" role="tooltip">{tooltip}</span>
                        </div>
                    }}).collect_view()}
                </div>
                <div class="spectrum-labels" aria-hidden="true"><span>"BASS"</span><span>"MIDRANGE"</span><span>"TREBLE"</span></div>
            </div>
            <p class="control-note">{move || if listening.get() {
                format!("Sample rate: {} Hz", sample_rate.get())
            } else { "Allow microphone access to begin. No recording.".into() }}
                <span class="display-status">
                <span class="wake-status" title="Keeps the screen on while this page is visible">{move || wake_status.get()}</span>
                <span class="frame-rate" aria-label="Frame rate" title="Frames per second">
                    {move || frame_rate.get().map_or_else(|| "— FPS".into(), |fps| format!("{fps:.0} FPS"))}
                </span>
                </span>
            </p>
            <p class="audio-error" role="alert">{move || error.get()}</p>
            <p class="screen-error" role="status">{move || screen_error.get()}</p>
        </section>
    }
}
