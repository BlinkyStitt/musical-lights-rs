# Musical Lights in your Terminal

No embedded hardware? No problem. Run the code from your computer!

## Mac Setup

    ```sh
    brew install sdl2

    export LIBRARY_PATH="/opt/homebrew/lib:$LIBRARY_PATH"
    export CPATH="/opt/homebrew/include:$CPATH"
    ```

## Audio Visualizer

    ```sh
    cargo run --release
    ```

## Pacman Example

    ```sh
    cargo run --example pacman
    ```

## Misc Thoughts

i don't think an fft is the right thing to use. its for processing constant tones, not "transients". and musical notes are transients.

we need a bunch of low and high pass filters. but can we do like a bunch of lows and then subtract them from eachother to calculate each? or do we need a bunch of low then high pass. esp32 might not be good enough for that but we'll see.
