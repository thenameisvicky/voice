export class AudioFramer {
    constructor(frameSamplesCount) {
        this.frameSamplesCount = frameSamplesCount;
        this.buffer = [];
    }

    process(pcmChunk) {
        this.buffer.push(...pcmChunk);
        const out = []
        while (this.buffer.length >= this.frameSamplesCount) {
            const outFrame = this.buffer.splice(0, this.frameSamplesCount);
            out.push(outFrame);
        }
        return out;
    }
}