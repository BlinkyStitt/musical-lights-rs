use leptos::*;

/// About page
#[component]
pub fn About() -> impl IntoView {
    view! {
        <h1>Musical Lights</h1>

        <p>UnderConstruction.gif</p>

        <p>This website is the latest Rust/WASM version of my musical-lights projects.</p>

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
    }
}
