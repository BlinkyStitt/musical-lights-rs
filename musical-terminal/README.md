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
