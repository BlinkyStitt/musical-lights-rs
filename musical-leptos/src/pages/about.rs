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
        <p>"All displays use the same continuous ISO 532-1 loudness model. Its 28 internal filters produce a specific-loudness pattern across 24 Bark. Each bar integrates one Bark. A tone can excite adjacent hearing regions. Visual gain, smoothing, and lighting do not change measured loudness."</p>
        <ul>
            <li><a href="https://www.iso.org/standard/63077.html">"ISO 532-1:2017, Zwicker method"</a>" — the authoritative time-varying loudness calculation."</li>
            <li><a href="https://github.com/Eomys/MoSQITo/tree/v1.2.1">"MoSQiTo 1.2.1"</a>" — adapted tables and equations, and independent numerical comparison. Apache-2.0."</li>
            <li><a href="https://journals.sagepub.com/doi/10.1177/2331216514550620">"Development and Current Status of the Cambridge Loudness Models"</a>" — Moore, 2014. Explains auditory filtering, excitation spread, and specific versus partial loudness."</li>
            <li><a href="https://www.research.ed.ac.uk/en/publications/a-tutorial-on-audio-transient-detection/">"A Tutorial on Audio Transient Detection"</a>" — Bello and colleagues, 2005. Informs our causal log-loudness attack features; thresholds and flashes are application choices."</li>
            <li><a href="https://www.ee.columbia.edu/~dpwe/pubs/Ellis07-beattrack.pdf">"Beat Tracking by Dynamic Programming"</a>" — Ellis, 2007. Informs the causal autocorrelation tempo estimator; we do not implement the complete beat tracker."</li>
            <li><a href="https://gery.casiez.net/1euro/">"1 Euro Filter"</a>" — Casiez, Roussel, and Vogel, 2012. Visual smoothing with an application-specific shared coefficient across bands."</li>
            <li><a href="https://www.hsluv.org/math/">"HSLuv mathematics"</a>" — the perceptual color coordinates used for the palette."</li>
            <li><a href="https://www.w3.org/TR/webaudio/">"Web Audio specification"</a>" — browser processing, block requests, and output timestamps."</li>
        </ul>
        <p>"Uncalibrated sones are estimates. dBFS measures digital level, not hearing risk. Numerical tests, browser checks, and physical-device checks provide different evidence."</p>
        <p><a href="https://github.com/BlinkyStitt/musical-lights-rs/blob/main/docs/loudness.md#scientific-sources-and-implementation-roles">"Method, controls, research, and implementation limits"</a></p>
        </section>

        <section aria-labelledby="stars-heading">
        <h2 id="stars-heading">"Stars behind the lights"</h2>
        <p>"The background shows real catalog stars around Orion. Their positions, relative brightness and color indices come from "
        <a href="https://github.com/astronexus/HYG-Database/tree/c7f7f883fe678cc7680169a50ccd7dcc49b060ce/hyg">"David Nash’s HYG Database 4.1"</a>
        ". Music adds a tempo shimmer and attack twinkles. This is a fixed view of the sky, not the current local horizon."</p>
        <p>"The selected catalog data is adapted under "<a href="https://creativecommons.org/licenses/by-sa/4.0/">"CC BY-SA 4.0"</a>"."</p>
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
