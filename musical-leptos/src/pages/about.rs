use leptos::prelude::*;

/// About page
#[component]
pub fn About() -> impl IntoView {
    view! {
        <article class="about-page">
        <p class="eyebrow">"LIGHTS THROUGH THE YEARS"</p>
        <h1>"About Musical Lights"</h1>

        <p>This website is the latest Rust/WASM version of my musical-lights projects.</p>

        <section aria-labelledby="research-heading">
        <h2 id="research-heading">"Research behind the lights"</h2>
        <p>"The bars estimate human-perceived loudness within the mix. These papers inform the loudness calculations, attack accents, and visual smoothing."</p>
        <ul>
            <li>
                <a href="https://www.cp.jku.at/research/papers/Boeck_Widmer_DAFx_2013.pdf">"Maximum Filter Vibrato Suppression for Onset Detection"</a>
                " — Sebastian Böck and Gerhard Widmer, DAFx 2013 (PDF). Helps avoid treating a wavering pitch as repeated note attacks. We adapt its SuperFlux feature for the white accents."
            </li>
            <li>
                <a href="https://aes.org/publications/elibrary-page/?id=10272">"A Model for the Prediction of Thresholds, Loudness, and Partial Loudness"</a>
                " — Brian C. J. Moore, Brian R. Glasberg, and Thomas Baer, 1997. Its partial-loudness equations underpin our estimates of how loud each frequency region sounds in the presence of the rest of the mix."
            </li>
            <li>
                <a href="https://aes.org/publications/elibrary-page/?id=11081">"A Model of Loudness Applicable to Time-Varying Sounds"</a>
                " — Brian R. Glasberg and Brian C. J. Moore, 2002. Informs how perceived loudness builds and fades over time. We use its short-term integration; our fixed analysis window is an adaptation."
            </li>
            <li>
                <a href="https://gery.casiez.net/1euro/">"1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in Interactive Systems"</a>
                " — Géry Casiez, Nicolas Roussel, and Daniel Vogel, CHI 2012. Reduces visual jitter while limiting lag during faster changes. We adapt it to share smoothing across the bands."
            </li>
        </ul>
        <p>"Flash thresholds and timing are choices made for this app. The AES pages provide abstracts; full papers may require access."</p>

        <h3>"Standards and reference implementations"</h3>
        <ul>
            <li><a href="https://www.iso.org/standard/63077.html">"ISO 532-1:2017: Zwicker loudness method"</a>" — the separate total and specific-loudness calculation."</li>
            <li><a href="https://github.com/Eomys/MoSQITo/tree/v1.2.1">"MoSQITo 1.2.1"</a>" — source of adapted ISO-model tables and equations, and an independent numerical comparison."</li>
            <li><a href="https://github.com/deeuu/loudness/tree/82de790f79c5b358040861e8bdb906a55009b117">"Dominic Ward's loudness library"</a>" — source of adapted partial-loudness stages and a pinned validation reference."</li>
            <li><a href="https://www.hsluv.org/math/">"HSLuv mathematics"</a>" — the perceptual color coordinates used for the palette."</li>
            <li><a href="https://www.w3.org/TR/webaudio/">"Web Audio specification"</a>" — browser audio processing and output timestamps for synchronized listening reviews."</li>
        </ul>
        <p><a href="https://github.com/BlinkyStitt/musical-lights-rs/blob/main/docs/loudness.md#research-and-sources">"Implementation notes and earlier Bark-scale references"</a></p>
        </section>

        <h2>Old Arduino Code</h2>

        <ol>
            <li><a href="https://www.youtube.com/shorts/PEfV9YJbhIA">EL Jacket</a></li>
            <li><a href="https://www.youtube.com/watch?v=ImKlL52tjEg">EL Jacket V2</a></li>
            <li><a href="https://www.youtube.com/watch?v=M8pkG5HjOQM">DJ Screen</a></li>
            <li><a href="https://www.youtube.com/watch?v=A6t1pDLEqTk">Simple LED Strip</a></li>
            <li><a href="https://www.youtube.com/watch?v=ELDt1dZbY2g">Musical Hat 120 and EL Backpack</a></li>
            <li><a href="https://twitter.com/BlinkyStitt/status/1160077236013166597">Musical Hat 512</a></li>
            <li><a href="https://www.youtube.com/live/AweudehId5Q?si=L2YLegHnOBYSixC2&t=5157">Merbots at Chewbacchus 2024</a></li>
        </ol>

        <h2>Links</h2>

        <ul>
            <li><a href="https://twitter.com/BlinkyStitt/">BlinkyStitt @ Twitter</a></li>
            <li><a href="https://warpcast.com/flashprofits.eth">FlashProfits.eth @ Farcaster</a></li>
            <li><a href="https://github.com/BlinkyStitt/musical-lights-rs/tree/main/musical-leptos">GitHub repository for this Website</a></li>
        </ul>
        </article>
    }
}
