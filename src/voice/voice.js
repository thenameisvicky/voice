class Voice {
    constructor({ vad, transcriber, reasoner, synthesizer }) {
        this.vad = vad;
        this.transcriber = transcriber;
        this.reasoner = reasoner;
        this.synthesizer = synthesizer;
    }
}