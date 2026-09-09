export class Voice {
    constructor({ audioFramer, vad, transcriber, reasoner, synthesizer }) {
        this.audioFramer = audioFramer;
        this.vad = vad;
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
            const prob = await this.vad.process(frame);
            console.log(`[VOICE] probability - ${prob.toFixed(3)}`);
        }
    }
}