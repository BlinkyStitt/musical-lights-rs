// Browser transport only. Copy decoded 48 kHz PCM on integer sample boundaries;
// native buffer-source start times can introduce fractional-sample interpolation.
class PCMPlaybackProcessor extends AudioWorkletProcessor {
    constructor({ processorOptions: { pcm, repeat } }) {
        super();
        if (!(pcm instanceof Float32Array) || !pcm.length || sampleRate !== 48000) throw Error('Invalid playback PCM');
        this.pcm = pcm;
        this.cursor = 0;
        this.repeat = Boolean(repeat);
        this.paused = false;
        this.ended = false;
        this.sequence = 0;
        this.pending = true;
        this.port.onmessage = ({ data }) => {
            this.sequence = data.sequence;
            if (data.type === 'restart') { this.cursor = 0; this.paused = false; this.ended = false; }
            else if (data.type === 'pause') this.paused = true;
            else if (data.type === 'resume') this.paused = false;
            else if (data.type === 'repeat') this.repeat = Boolean(data.repeat);
            else return;
            this.pending = true;
        };
    }
    publish(frame) {
        this.port.postMessage({ type: 'transport', sequence: this.sequence, frame,
            positionFrame: this.cursor, repeat: this.repeat,
            state: this.ended ? 'ended' : this.paused ? 'paused' : 'playing' });
    }
    process(_inputs, outputs) {
        const output = outputs[0][0];
        if (this.pending) { this.publish(currentFrame); this.pending = false; }
        // Keep one connected mono source during pauses and after completion.
        // Transport commands never replace nodes or stop the analysis clock.
        for (let i = 0; i < output.length; i++) {
            output[i] = this.paused || this.ended ? 0 : this.pcm[this.cursor++];
            if (this.cursor === this.pcm.length && !this.ended) {
                if (this.repeat) this.cursor = 0;
                else { this.ended = true; this.publish(currentFrame + i + 1); }
            }
        }
        return true;
    }
}
registerProcessor('pcm-playback', PCMPlaybackProcessor);
