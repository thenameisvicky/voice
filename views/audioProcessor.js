class AudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        this.inputSampleRate = sampleRate;
        this.outputSampleRate = 16000;

        this.resampleRatio =
            this.inputSampleRate / this.outputSampleRate;

        this.inputBuffer = [];
        this.resamplePosition = 0;

        this.port.onmessage = (event) => {
            if (event.data === "stop") {
                this.inputBuffer = [];
                this.resamplePosition = 0;
            }
        };
    }

    process(inputs) {
        const input = inputs[0];

        if (!input || !input[0]) {
            return true;
        }

        const channel = input[0];

        for (let i = 0; i < channel.length; i++) {
            this.inputBuffer.push(channel[i]);
        }

        if (this.inputBuffer.length >= 2048) {
            const pcm16 = this.resampleAndConvert(
                this.inputBuffer
            );

            this.inputBuffer = [];

            if (pcm16.length > 0) {
                this.port.postMessage(
                    pcm16.buffer,
                    [pcm16.buffer]
                );
            }
        }
        return true;
    }

    resampleAndConvert(floatSamples) {
        const ratio = this.resampleRatio;

        const outputLength = Math.floor(
            floatSamples.length / ratio
        );

        const pcm16 = new Int16Array(outputLength);

        for (let i = 0; i < outputLength; i++) {
            const position = i * ratio;

            const index = Math.floor(position);
            const fraction = position - index;

            const sample1 = floatSamples[index] || 0;
            const sample2 = floatSamples[index + 1] || sample1;

            const sample =
                sample1 +
                (sample2 - sample1) * fraction;

            const clamped = Math.max(-1, Math.min(1, sample));

            pcm16[i] =
                clamped < 0
                    ? clamped * 32768
                    : clamped * 32767;
        }
        return pcm16;
    }
}

registerProcessor("audio-processor", AudioProcessor);