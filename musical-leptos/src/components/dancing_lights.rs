use crate::{display::DisplayPacer, wasm_audio::AudioSession};
use leptos::prelude::*;
use musical_lights_core::audio::{BARK_EDGES, BarkBank, DISPLAY_BANDS};
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
    let (paused, set_paused) = signal(false);
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
        let Some(clock) = web_sys::window().and_then(|window| window.performance()) else {
            set_error.set(Some("The browser display clock is unavailable.".into()));
            return;
        };
        let mut display = DisplayPacer::new(clock.now());
        let mut block_error = None;
        set_sample_rate.set(rate);
        set_starting.set(true);
        set_paused.set(false);
        let owner = owner.get_value();
        *owner.session.borrow_mut() = Some(session.clone());
        let alive = owner.alive.clone();
        leptos::task::spawn_local(async move {
            let result = session
                .start(move |samples| {
                    if !alive.get() {
                        return;
                    }
                    let values = match bank.push_samples(&samples) {
                        Ok(frame) => frame.bands().0,
                        Err(error) => {
                            block_error = Some(error.to_string());
                            [0.0; DISPLAY_BANDS]
                        }
                    };
                    if let Some(values) = display.push(values, clock.now()) {
                        // Error text follows the same limited cadence as the
                        // meters and clears after a valid display window.
                        set_error.set(block_error.take());
                        if !paused.get_untracked() {
                            set_audio.set(values);
                        }
                    }
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
                    set_error.set(Some(format!("Microphone: {error:?}")));
                }
            }
        });
    };
    view! {
        <section class="audio-card" aria-labelledby="spectrum-title">
            <div class="card-heading">
                <div><p class="eyebrow">"LIVE SPECTRUM"</p><h2 id="spectrum-title">"See what you hear"</h2></div>
                <p class="mic-status" role="status">
                    {move || if starting.get() { "Waiting for microphone" } else if listening.get() {
                        if paused.get() { "Display paused · Mic on" } else { "Listening · Mic on" }
                    } else { "Microphone off" }}
                </p>
            </div>
            <div class="audio-controls">
                <div class="button-row">
                    <Show when=move || !listening.get() fallback=move || view! {
                        <button class="primary" on:click=move |_| {
                            owner.with_value(|owner| {
                                if let Some(session) = owner.session.borrow_mut().take() { session.stop(); }
                            });
                            set_listening.set(false);
                            set_paused.set(false);
                            set_error.set(None);
                            set_audio.set([0.0; DISPLAY_BANDS]);
                        }>"Stop listening"</button>
                    }>
                        <button class="primary" on:click=start disabled=move || starting.get()>
                            {move || if starting.get() { "Starting microphone…" } else { "Start listening" }}
                        </button>
                    </Show>
                    <button class="secondary" disabled=move || !listening.get()
                        aria-pressed=move || paused.get().to_string()
                        on:click=move |_| set_paused.update(|value| *value = !*value)>
                        {move || if paused.get() { "Resume display" } else { "Pause display" }}
                    </button>
                </div>
                <p class="control-note">{move || if listening.get() {
                    format!("Sample rate: {} Hz · Smooth display", sample_rate.get())
                } else { "Allow microphone access to begin. No recording.".into() }}</p>
            </div>
            <div class="spectrum-panel">
                <div class="meter-guide" aria-hidden="true"><span>"HIGH"</span><span>"LOW"</span></div>
                <div id="dancinglights" role="group" aria-label="Audio spectrum, bass to treble">
                    {BARK_EDGES.windows(2).enumerate().map(|(i, edges)| {
                        let label = format!("{}–{} Hz", edges[0], edges[1]);
                        view! {
                        <div class="meter" role="meter" aria-label=label.clone() title=label
                            aria-valuemin="0" aria-valuemax="100"
                            aria-valuenow=move || (audio.get()[i] * 100.0).round() as u32>
                            <div class="meter-fill" style:transform=move || format!("scaleY({})", audio.get()[i])></div>
                        </div>
                    }}).collect_view()}
                </div>
                <div class="spectrum-labels" aria-hidden="true"><span>"BASS"</span><span>"MIDRANGE"</span><span>"TREBLE"</span></div>
            </div>
            <p class="audio-error" role="alert">{move || error.get()}</p>
        </section>
    }
}
