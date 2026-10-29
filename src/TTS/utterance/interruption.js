export class InterruptionController {
    constructor(utteranceBuffer) {
        this.utteranceBuffer = utteranceBuffer;
    }

    interrupt(utteranceId) {
        return this.utteranceBuffer.cancel(utteranceId);
    }

    isCancelled(utteranceId) {
        return (
            this.utteranceBuffer.getStatus(utteranceId) === "CANCELLED"
        );
    }
}