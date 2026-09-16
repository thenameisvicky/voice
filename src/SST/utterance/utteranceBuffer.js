import { SST_CONFIG } from "../config.js";

export class UtteranceBuffer {
    constructor() {
        this.sampleRate = 16000;
        this.preSpeechBufferSamples =
            this.sampleRate *
            SST_CONFIG.preSpeechBufferMs /
            1000;

        this.preSpeechBuffer = [];
        this.utteranceBuffer = [];
        this.collecting = false;
    }

    process({ event, frame }) {

        if (!this.collecting) {
            this.preSpeechBuffer.push(frame);
            this.trimPreSpeechBuffer();

            if (event?.type === "START") {
                this.collecting = true;
                this.utteranceBuffer.push(
                    ...this.preSpeechBuffer
                );
                this.preSpeechBuffer = [];
                return null;
            }
            return null;
        }

        this.utteranceBuffer.push(frame);

        if (event?.type === "END") {
            const speech =
                this.flattenFrames(
                    this.utteranceBuffer
                );
            this.utteranceBuffer = [];
            this.collecting = false;
            return speech;
        }
        return null;
    }

    trimPreSpeechBuffer() {

        let totalSamples = 0;
        for (const frame of this.preSpeechBuffer) {
            totalSamples += frame.length;
        }

        if (totalSamples <= this.preSpeechBufferSamples) {
            return;
        }

        while (
            this.preSpeechBuffer.length > 0 &&
            totalSamples > this.preSpeechBufferSamples
        ) {
            const removedFrame =
                this.preSpeechBuffer.shift();
            totalSamples -= removedFrame.length;
        }
    }

    flattenFrames(frames) {
        let totalSamples = 0;

        for (const frame of frames) {
            totalSamples += frame.length;
        }

        const audio =
            new Int16Array(totalSamples);

        let offset = 0;
        for (const frame of frames) {
            audio.set(frame, offset);
            offset += frame.length;
        }
        return audio;
    }
}