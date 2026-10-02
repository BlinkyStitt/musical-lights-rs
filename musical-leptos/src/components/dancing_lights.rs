use crate::{
    display::DisplayAnimation,
    physics::PhysicsAnimation,
    screen::ScreenSession,
    wasm_audio::{AudioSession, AudioUpdate},
};
use leptos::prelude::*;
use musical_lights_core::{
    audio::visual::{BARK_EDGES, DISPLAY_BANDS, DisplayFrame},
    lights::{Gradient, screen_color},
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

#[derive(Clone)]
struct SessionOwner {
    alive: Rc<Cell<bool>>,
    session: Rc<RefCell<Option<AudioSession>>>,
    animation: Rc<RefCell<Option<DisplayAnimation>>>,
    physics: Rc<RefCell<Option<PhysicsAnimation>>>,
}

impl SessionOwner {
    fn stop(&self) {
        if let Some(session) = self.session.borrow_mut().take() {
            session.stop();
        }
        if let Some(animation) = self.animation.borrow_mut().take() {
            animation.stop();
        }
        if let Some(physics) = self.physics.borrow().as_ref() {
            physics.clear_audio();
        }
    }
}

// Keep the error state available while its detailed notice expires. Identical
// repeated callbacks must not restart the timer; clearing the source rearms it.
fn transient_notice(
    message: impl Fn() -> Option<String> + Send + Sync + 'static,
) -> ReadSignal<Option<String>> {
    let (visible, set_visible) = signal(None::<String>);
    let previous = StoredValue::new(None::<String>);
    let timer = StoredValue::new(None::<TimeoutHandle>);
    let cancel = move || {
        timer.update_value(|timer| {
            if let Some(timer) = timer.take() {
                timer.clear();
            }
        })
    };
    on_cleanup(cancel);
    Effect::new(move |_| {
        let message = message();
        if previous.get_value() == message {
            return;
        }
        previous.set_value(message.clone());
        cancel();
        set_visible.set(message.clone());
        if message.is_some() {
            match set_timeout(
                move || {
                    set_visible.set(None);
                    timer.set_value(None);
                },
                Duration::from_secs(4),
            ) {
                Ok(handle) => timer.set_value(Some(handle)),
                Err(error) => log::warn!("Could not schedule notice expiry: {error:?}"),
            }
        }
    });
    visible
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub enum VisualizationMode {
    #[default]
    Home,
    Advanced,
}

#[component]
fn SettingSwitch(
    label: &'static str,
    class: &'static str,
    checked: Signal<bool>,
    #[prop(default = Signal::derive(|| false))] disabled: Signal<bool>,
    on_change: Callback<bool>,
) -> impl IntoView {
    view! {
        <label class="setting-switch">
            <input type="checkbox" tabindex="0" class=class prop:checked=move || checked.get()
                disabled=move || disabled.get()
                on:change=move |event| on_change.run(event_target_checked(&event))/>
            <span>{label}</span>
        </label>
    }
}

#[component]
pub fn DancingLights(
    #[prop(default = VisualizationMode::Home)] mode: VisualizationMode,
) -> impl IntoView {
    let advanced = mode == VisualizationMode::Advanced;
    let mut palette = Gradient::<DISPLAY_BANDS>::new_rainbow(100.0, 58.0);
    // Keep the established hue order, but use the full display gamut rather
    // than equal-lightness, muted fills. Height alone represents loudness.
    for color in &mut palette.colors {
        let peak = color.red.max(color.green).max(color.blue);
        color.red /= peak;
        color.green /= peak;
        color.blue /= peak;
    }
    let colors = palette.colors;
    let frequency_edges = BARK_EDGES;
    let (active_sample, set_active_sample) = signal(0usize);
    let sample_nodes = StoredValue::new(std::array::from_fn::<_, DISPLAY_BANDS, _>(|_| {
        NodeRef::<leptos::html::Div>::new()
    }));
    let navigate_sample = move |event: web_sys::KeyboardEvent| {
        if event.alt_key() || event.ctrl_key() || event.meta_key() || event.shift_key() {
            return;
        }
        let index = active_sample.get_untracked();
        let next = match event.key().as_str() {
            "ArrowLeft" => index.saturating_sub(1),
            "ArrowRight" => (index + 1).min(DISPLAY_BANDS - 1),
            "Home" => 0,
            "End" => DISPLAY_BANDS - 1,
            _ => return,
        };
        event.prevent_default();
        if let Some(sample) = sample_nodes.with_value(|nodes| nodes[next].get_untracked())
            && let Err(error) = sample.focus()
        {
            log::warn!("Could not focus spectrum sample: {error:?}");
        }
    };
    let (selected_band, set_selected_band) = signal(None::<usize>);
    let tooltip_timer = StoredValue::new(None::<TimeoutHandle>);
    let clear_tooltip_timer = move || {
        tooltip_timer.update_value(|timer| {
            if let Some(timer) = timer.take() {
                timer.clear();
            }
        });
    };
    on_cleanup(clear_tooltip_timer);
    let show_band = move |index, transient| {
        clear_tooltip_timer();
        set_selected_band.set(Some(index));
        if transient {
            match set_timeout(
                move || {
                    set_selected_band.set(None);
                    tooltip_timer.set_value(None);
                },
                Duration::from_secs(3),
            ) {
                Ok(timer) => tooltip_timer.set_value(Some(timer)),
                Err(error) => {
                    set_selected_band.set(None);
                    log::warn!("Could not schedule frequency readout: {error:?}");
                }
            }
        }
    };
    let hide_band = move |index| {
        if selected_band.get_untracked() == Some(index) {
            clear_tooltip_timer();
            set_selected_band.set(None);
        }
    };
    let keyboard_sample_focused = move || {
        sample_nodes.with_value(|nodes| {
            nodes[active_sample.get_untracked()]
                .get_untracked()
                .is_some_and(|sample| sample.matches(":focus-visible").unwrap_or(false))
        })
    };
    let (audio, set_audio) = signal(DisplayFrame::<DISPLAY_BANDS>::default());
    let (scrolling, set_scrolling) = signal(true);
    let source_band = |band: usize| band;
    let (listening, set_listening) = signal(false);
    let (generated, set_generated) = signal(false);
    let (capture_status, set_capture_status) =
        signal(String::from("Uncalibrated · estimated perceived loudness"));
    let (input_channel, set_input_channel) = signal(1u32);
    let (reference_level, set_reference_level) = signal(94.0f64);
    let (calibrating, set_calibrating) = signal(false);
    let (clipped, set_clipped) = signal(0u64);
    let (starting, set_starting) = signal(false);
    let (error, set_error) = signal(None::<String>);
    let error_notice = transient_notice(move || error.get());
    let (audio_stopped, set_audio_stopped) = signal(false);
    let (sample_rate, set_sample_rate) = signal(0.0);
    let (_, set_frame_rate) = signal(None::<f64>);
    let (wake_status, set_wake_status) = signal(String::from("Keeping screen awake…"));
    let (fullscreen, set_fullscreen) = signal(false);
    let (screen_error, set_screen_error) = signal(String::new());
    let screen_notice = transient_notice(move || {
        let text = screen_error.get();
        (!text.is_empty()).then_some(text)
    });
    let screen = StoredValue::new_local(None::<ScreenSession>);
    let card = NodeRef::<leptos::html::Section>::new();
    card.on_load(move |element| {
        let session = ScreenSession::new(
            &element,
            move |awake, full, error| {
                set_wake_status.set(awake);
                set_fullscreen.set(full);
                set_screen_error.set(error);
            },
            move |band| match band {
                Some(index) => show_band(index as usize, true),
                None => {
                    clear_tooltip_timer();
                    set_selected_band.set(None);
                }
            },
        );
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
        physics: Rc::new(RefCell::new(None)),
    });
    let canvas_layer = NodeRef::<leptos::html::Span>::new();
    canvas_layer.on_load(move |element| {
        let frame_owner = owner.get_value();
        let physics = PhysicsAnimation::new(&element, palette, move |now, reset_clock| {
            if let Some(animation) = frame_owner.animation.borrow().as_ref() {
                if reset_clock {
                    animation.reset_clock();
                } else {
                    animation.tick(now);
                }
            }
        });
        owner.with_value(|owner| *owner.physics.borrow_mut() = Some(physics));
    });
    on_cleanup(move || {
        owner.with_value(|owner| {
            owner.alive.set(false);
            owner.stop();
            owner.physics.borrow_mut().take();
        })
    });
    let start = move || {
        if starting.get_untracked() || listening.get_untracked() {
            return;
        }
        set_error.set(None);
        set_audio_stopped.set(false);
        set_clipped.set(0);
        set_calibrating.set(false);
        set_frame_rate.set(None);
        let session = match AudioSession::new() {
            Ok(session) => session,
            Err(error) => {
                set_audio_stopped.set(true);
                set_error.set(Some(format!("Audio context: {error:?}")));
                return;
            }
        };
        let rate = session.sample_rate();
        let owner = owner.get_value();
        let alive = owner.alive.clone();
        let physics = owner.physics.clone();
        let animation = match DisplayAnimation::new(
            session.clone(),
            move || scrolling.get_untracked() && listening.get_untracked(),
            move |values, fps, enabled| {
                if !alive.get() {
                    return;
                }
                if let Some(physics) = physics.borrow().as_ref() {
                    physics.push(values, enabled);
                }
                if audio.get_untracked() != values {
                    set_audio.set(values);
                }
                if let Some(fps) = fps {
                    set_frame_rate.set(Some(fps));
                }
            },
        ) {
            Ok(animation) => animation,
            Err(error) => {
                session.stop();
                owner.stop();
                set_audio_stopped.set(true);
                set_error.set(Some(format!("Display: {error:?}")));
                return;
            }
        };
        *owner.animation.borrow_mut() = Some(animation.clone());
        set_sample_rate.set(rate);
        set_starting.set(true);
        *owner.session.borrow_mut() = Some(session.clone());
        let alive = owner.alive.clone();
        let failure_owner = owner.clone();
        leptos::task::spawn_local(async move {
            let result = session
                .start(
                    input_channel.get_untracked().saturating_sub(1),
                    move |update| {
                        if !alive.get() {
                            return;
                        }
                        match update {
                            AudioUpdate::Frame { snapshot, clipped } => {
                                animation.push(snapshot);
                                set_clipped.set(clipped);
                            }
                            AudioUpdate::Status(status) => {
                                set_capture_status.set(status);
                                set_calibrating.set(false);
                            }
                            AudioUpdate::Error(message) => {
                                set_audio_stopped.set(true);
                                set_error.set(Some(message));
                                set_calibrating.set(false);
                                set_listening.set(false);
                                set_starting.set(false);
                                set_audio.set(DisplayFrame::<DISPLAY_BANDS>::default());
                                set_frame_rate.set(None);
                                let owner = failure_owner.clone();
                                // Release the message closure after it returns.
                                leptos::task::spawn_local(async move {
                                    owner.stop();
                                });
                            }
                        }
                    },
                )
                .await;
            // A route can close while getUserMedia is still awaiting permission.
            // Its result releases any stream acquired after that close.
            if !owner.alive.get() {
                return;
            }
            set_starting.set(false);
            match result {
                Ok(()) => {
                    set_generated.set(session.is_generated());
                    set_capture_status.set(session.status());
                    set_listening.set(true);
                }
                Err(error) => {
                    set_listening.set(false);
                    owner.stop();
                    set_frame_rate.set(None);
                    set_audio_stopped.set(true);
                    set_error.set(Some(format!("Audio: {error:?}")));
                }
            }
        });
    };
    view! {
        <section class="audio-card" data-mode=if advanced { "advanced" } else { "home" } aria-label="Live audio spectrum" node_ref=card>
            <div class="audio-controls">
                <div class="button-row">
                    <SettingSwitch label="Phone motion" class="motion-button"
                        checked=Signal::derive(|| false) on_change=Callback::new(|_| {})/>
                    <SettingSwitch label="Listening" class="listening-toggle"
                        checked=listening.into() disabled=starting.into()
                        on_change=Callback::new(move |enabled| {
                            if enabled { start(); } else {
                                owner.with_value(|owner| owner.stop());
                                set_listening.set(false);
                                set_frame_rate.set(None);
                                set_error.set(None);
                                set_audio_stopped.set(false);
                                set_audio.set(DisplayFrame::<DISPLAY_BANDS>::default());
                            }
                        })/>
                    <button class="fullscreen-button" tabindex="0"
                        aria-pressed=move || fullscreen.get().to_string()
                        title=move || if fullscreen.get() { "Exit fullscreen" } else { "Show only the lights; click Exit fullscreen to return" }
                        on:click=move |_| screen.with_value(|session| {
                            if let Some(session) = session { session.toggle_fullscreen(); }
                        })>
                        {move || if fullscreen.get() { "Exit fullscreen" } else { "Fullscreen" }}
                    </button>
                </div>
            </div>
            <div class="spectrum-panel">
                <p class="fullscreen-hint">"Click Exit fullscreen"</p>
                <div class="frequency-tooltip" id="frequency-readout" role="tooltip"
                    hidden=move || selected_band.get().is_none()
                    style=move || selected_band.get().map(|index| {
                        let color = screen_color(colors[source_band(index)]);
                        format!("--band-color: color(srgb {} {} {});", color.red, color.green, color.blue)
                    })>
                    <span class="frequency-swatch" aria-hidden="true"></span>
                    <span>{move || selected_band.get().map(|index| format!("≈ {}–{} Hz", frequency_edges[source_band(index)], frequency_edges[source_band(index) + 1]))}</span>
                </div>
                <div id="dancinglights" role="group" aria-label="Audio spectrum, source frequency bands" on:keydown=navigate_sample>
                    {(0..DISPLAY_BANDS).map(|group| {
                        let style = move || {
                            let color = screen_color(palette.colors[source_band(group)]);
                            format!("--band-color: color(srgb {} {} {});", color.red, color.green, color.blue)
                        };
                        view! {
                            <div class="bark-group" role="group"
                                aria-label=move || { let band = source_band(group); format!("Band {}, {}–{} Hz", band + 1, frequency_edges[band], frequency_edges[band + 1]) } style=style>
                                <div class="meter" role="meter"
                                    aria-label=move || { let band = source_band(group); format!("≈ {}–{} Hz", frequency_edges[band], frequency_edges[band + 1]) }
                                    node_ref=sample_nodes.with_value(|nodes| nodes[group])
                                    tabindex=move || if active_sample.get() == group { "0" } else { "-1" }
                                    aria-describedby=move || (selected_band.get() == Some(group)).then_some("frequency-readout")
                                    on:pointerenter=move |event| { if event.pointer_type() == "mouse" && !keyboard_sample_focused() { show_band(group, false); } }
                                    on:pointerleave=move |event| { if event.pointer_type() == "mouse" && !keyboard_sample_focused() { hide_band(group); } }
                                    on:focus=move |event| {
                                        set_active_sample.set(group);
                                        if event_target::<web_sys::Element>(&event).matches(":focus-visible").unwrap_or(false) { show_band(group, false); }
                                    }
                                    on:blur=move |_| hide_band(group)
                                    aria-valuemin="0" aria-valuemax="100"
                                    aria-valuenow=move || audio.with(|frame| (frame.levels[group] * 100.0).round() as u32)>
                                    <div class="meter-track"></div>
                                </div>
                            </div>
                        }
                    }).collect_view()}
                    <span class="meter-guide" aria-hidden="true"><span>"LOUD"</span><span>"QUIET"</span></span>
                    <span class="balloon-layer" aria-hidden="true" node_ref=canvas_layer></span>
                </div>
                <div class="spectrum-labels" aria-hidden="true"><span>"BASS"</span><span>"MIDRANGE"</span><span>"TREBLE"</span></div>
            </div>
            <div class="display-note">
                <p class="mic-status" role="status">
                    {move || if starting.get() { "Starting audio" } else if listening.get() {
                        if generated.get() { "Digital audio · Mic off" } else { "Listening · Mic on" }
                    } else { "Microphone off · silent sine preview" }}
                </p>
                <p class="control-note">{move || if listening.get() {
                    format!("Sample rate: {} Hz", sample_rate.get())
                } else { "Turn on Listening to begin.".into() }}</p>
                <p class="display-status">
                <Show when=move || !advanced>
                    <SettingSwitch label="Scroll lights" class="scroll-lights"
                    checked=scrolling.into() on_change=Callback::new(move |value| set_scrolling.set(value))/>
                </Show>
                    <span class="wake-status" title="Keeps the screen on while this page is visible">{move || wake_status.get()}</span>

                </p>
            </div>
            <Show when=move || !advanced>
                <p class="reduced-motion-note">"Reduced Motion disables automatic scrolling."</p>
            </Show>
            <Show when=move || advanced>
                <details class="display-controls settings-section" open>
                    <summary>"Display"</summary>
                <SettingSwitch label="Scroll lights" class="scroll-lights"
                    checked=scrolling.into() on_change=Callback::new(move |value| set_scrolling.set(value))/>
                    <p class="reduced-motion-note">"Reduced Motion disables automatic scrolling."</p>
                    <label class="control-row">"Camera angle (degrees)"<input class="camera-rotation" type="range" min="-40" max="40" value="0"/></label>
                    <button class="display-reset" on:click=move |_| set_scrolling.set(true)>"Reset display"</button>
                </details>
            <p class="calibration-status">{move || capture_status.get()}</p>
            <details class="calibration-controls settings-section" open>
                <summary>"Input & calibration"</summary>
                <label class="control-row">"Source"<select class="input-source" disabled=move || listening.get() || starting.get()>
                    <option value="microphone">"Microphone"</option>
                    <option value="generated">"Test tones"</option>
                </select></label>
                <p class="capture-information"></p>

                <p>"Bars estimate perceived loudness within the mix, with one automatically adjusting display scale. White borders accent detected attacks. Keep microphone gain fixed. Use a known, steady reference sound. Calibration measures three seconds of input."</p>
                <label class="control-row">"Input channel "<input type="number" min="1" step="1" prop:value=move || input_channel.get() disabled=move || listening.get() || starting.get() on:input=move |event| { if let Ok(value) = event_target_value(&event).parse::<u32>() { set_input_channel.set(value.max(1)); } }/></label>
                <label class="control-row">"Reference level (dB SPL) "<input type="number" step="0.1" prop:value=move || reference_level.get() on:input=move |event| { if let Ok(value) = event_target_value(&event).parse::<f64>() { set_reference_level.set(value); } }/></label>
                <button disabled=move || !listening.get() || generated.get() || calibrating.get() on:click=move |_| {
                    owner.with_value(|owner| {
                        if let Some(session) = owner.session.borrow().as_ref() {
                            match session.calibrate(reference_level.get_untracked()) {
                                Ok(()) => { set_calibrating.set(true); set_capture_status.set("Measuring reference for three seconds…".into()); },
                                Err(error) => set_error.set(Some(format!("Calibration: {error:?}"))),
                            }
                        }
                    });
                }>"Measure reference"</button>
                <button class="input-reset" disabled=move || listening.get() || starting.get() on:click=move |_| {
                    set_input_channel.set(1); set_reference_level.set(94.0);
                }>"Reset fields"</button>
                <button class="forget-calibration" disabled=move || !listening.get() || generated.get() on:click=move |_| {
                    owner.with_value(|owner| {
                        if let Some(session) = owner.session.borrow().as_ref() { session.forget_calibration(); }
                        owner.stop();
                    });
                    set_listening.set(false); set_frame_rate.set(None);
                    set_capture_status.set("Uncalibrated · estimated perceived loudness".into());
                    set_audio.set(DisplayFrame::<DISPLAY_BANDS>::default());
                }>"Forget this calibration and stop"</button>
                <p>{move || if clipped.get() > 0 { format!("Input reached full scale {} times. Check input gain.", clipped.get()) } else { String::new() }}</p>
            </details>
                <details class="physics-controls settings-section"></details>
                <details class="diagnostics-controls settings-section"></details>
            </Show>
            <p class="physics-status" role="status"></p>
            <p class="audio-error" role="alert">{move || error_notice.get()}</p>
            <p class="audio-stopped" role="status">{move || if audio_stopped.get() && error_notice.get().is_none() {
                if fullscreen.get() { "Audio stopped. Exit fullscreen to restart." } else { "Audio stopped. Turn on Listening to restart." }
            } else { "" }}</p>
            <p class="screen-error" role="status">{move || screen_notice.get()}</p>
        </section>
    }
}
