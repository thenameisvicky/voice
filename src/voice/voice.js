export class Voice {
    constructor({ audioFramer, vad, endpointer, batchTranscriber, reasoner, synthesizer, onEvent, utteranceBuffer, streamTranscriber }) {
        this.audioFramer = audioFramer;
        this.vad = vad;
        this.endpointer = endpointer;
        this.batchTranscriber = batchTranscriber;
        this.reasoner = reasoner;
        this.synthesizer = synthesizer;
        this.onEvent = onEvent;
        this.utteranceBuffer = utteranceBuffer;
        this.streamTranscriber = streamTranscriber
    }

    async voice(audioChunk) {

        const pcmChunk = new Int16Array(
            audioChunk.buffer,
            audioChunk.byteOffset,
            audioChunk.byteLength / 2
        );

        const frames = this.audioFramer.process(pcmChunk);

        for (const frame of frames) {
            const voiceActivity = await this.vad.process(frame);
            this.onEvent?.({ type: "vad", probability: voiceActivity.probability });
            const event = this.endpointer.process({ probability: voiceActivity["probability"], frameSamples: voiceActivity["frameSamples"] });

            const speechChunk = this.utteranceBuffer.process({ event: event, frame: frame });

            if (speechChunk) {
                const transcript = await this.batchTranscriber.transcribe(speechChunk);
                const response = await this.reasoner.reason(transcript);
                this.onEvent?.({
                    type: "transcript",
                    probability: voiceActivity.probability,
                    text: response
                });
            }
        }
    }

    async streamingVoice(audioChunk) {
        const pcmChunk = new Int16Array(
            audioChunk.buffer,
            audioChunk.byteOffset,
            audioChunk.byteLength / 2
        );

        const frames = this.audioFramer.process(pcmChunk);

        for (const frame of frames) {
            const voiceActivity = await this.vad.process(frame);
            this.onEvent?.({ type: "vad", probability: voiceActivity.probability });
            const event = this.endpointer.process({ probability: voiceActivity["probability"], frameSamples: voiceActivity["frameSamples"] });
            console.log(`[STREAMING][VOICE][EVENTS] - ${event?.type}`);

            if (event?.type == "START") {
                this.streamTranscriber.start();
            }

            if (event?.type == "END") {
                const full = await this.streamTranscriber.finalize(frame);
                if (full) {
                    this.onEvent?.({
                        type: "transcript",
                        probability: voiceActivity.probability,
                        text: full
                    });
                }
                continue;
            }

            const partial = await this.streamTranscriber.pushAudio(frame)
            if (partial) {
                this.onEvent?.({
                    type: "transcript",
                    probability: voiceActivity.probability,
                    text: partial
                });
            }
        }
    }
}