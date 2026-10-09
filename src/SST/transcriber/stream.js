export class StreamTranscriber {
    constructor(transcriberInstance) {
        this.batchTranscriber = transcriberInstance;
        this.startTranscribe = false;
        this.audioState = {
            audioBuffer: [],
            fullAudio: [],
            decodeWindowStart: 0,
            windowSize: 16000 * 500 / 1000,
            step: 16000 * 300 / 1000
        }

        this.transcriptionState = {
            partialHypothesis: "",
            finalTranscript: ""
        }
    }

    start() {
        this.startTranscribe = true
    }

    async pushAudio(audio) {
        if (this.startTranscribe !== true) {
            return null
        }

        this.audioState.audioBuffer.push(...audio);
        this.audioState.fullAudio.push(...audio);
        if (this.audioState.audioBuffer.length >= this.audioState.decodeWindowStart + this.audioState.windowSize) {
            return this.decode();
        }
        return null;
    }

    async decode() {
        const partialTranscript = await this.batchTranscriber.transcribe(this.audioState.audioBuffer.slice(this.audioState.decodeWindowStart, this.audioState.decodeWindowStart + this.audioState.windowSize));
        this.audioState.decodeWindowStart += this.audioState.step;
        this.transcriptionState.partialHypothesis = partialTranscript;
        return this.transcriptionState.partialHypothesis;
    }

    async finalize() {
        this.transcriptionState.finalTranscript = await this.batchTranscriber.transcribe(this.audioState.fullAudio);
        this.audioState.fullAudio = [];
        this.audioState.audioBuffer = [];
        this.startTranscribe = false;
        this.audioState.decodeWindowStart = 0;
        return this.transcriptionState.finalTranscript
    }
}