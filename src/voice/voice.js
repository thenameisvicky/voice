export class Voice {
    constructor({ audioFramer, vad, endpointer, transcriber, reasoner, synthesizer }) {
        this.audioFramer = audioFramer;
        this.vad = vad;
        this.endpointer = endpointer;
        this.transcriber = transcriber;
        this.reasoner = reasoner;
        this.synthesizer = synthesizer;
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
            const event = this.endpointer.process({ probability: voiceActivity["probablity"], frameSamples: voiceActivity["frameSamples"] });
            console.log(`[VOICE][EVENT] - ${event?.type} | ${event?.timestampSamples}`);
        }
    }
}