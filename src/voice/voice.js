export class Voice {
    constructor({ audioFramer, vad, endpointer, transcriber, reasoner, synthesizer, onEvent, utteranceBuffer }) {
        this.audioFramer = audioFramer;
        this.vad = vad;
        this.endpointer = endpointer;
        this.transcriber = transcriber;
        this.reasoner = reasoner;
        this.synthesizer = synthesizer;
        this.onEvent = onEvent;
        this.utteranceBuffer = utteranceBuffer;
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
            const event = this.endpointer.process({ probability: voiceActivity["probability"], frameSamples: voiceActivity["frameSamples"] });

            this.onEvent?.({
                type: event?.type,
                probability: voiceActivity.probability
            });

            const speechChunk = this.utteranceBuffer.process({ event: event, frame: frame });

            if (speechChunk) {
                const durationMs =
                    speechChunk.length / 16000 * 1000;

                console.log(
                    `[VOICE][SPEECH] - ${speechChunk.length} samples (${durationMs.toFixed(0)}ms)`
                );
            }
        }
    }
}