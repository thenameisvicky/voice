export class UtteranceBuffer {
    constructor() {
        this.current = null;
    }

    begin() {
        this.cancel();

        const utterance = {
            id: crypto.randomUUID(),
            status: "GENERATING",
            queue: [],
        };

        this.current = utterance;
        return utterance.id;
    }

    enqueue(id, audio) {
        const utterance = this.current;

        if (!utterance || utterance.id !== id) {
            return false;
        }

        if (
            utterance.status === "CANCELLED" ||
            utterance.status === "COMPLETED"
        ) {
            return false;
        }

        utterance.queue.push(audio);
        utterance.status = "READY";

        return true;
    }

    takeNext(id) {
        const utterance = this.current;

        if (!utterance || utterance.id !== id) {
            return null;
        }

        if (utterance.status === "CANCELLED") {
            return null;
        }

        const audio = utterance.queue.shift() ?? null;

        if (audio !== null) {
            utterance.status = "PLAYING";
        }

        return audio;
    }

    complete(id) {
        const utterance = this.current;

        if (!utterance || utterance.id !== id) {
            return false;
        }

        if (utterance.status === "CANCELLED") {
            return false;
        }

        utterance.queue.length = 0;
        utterance.status = "COMPLETED";

        return true;
    }

    cancel(id = this.current?.id) {
        const utterance = this.current;

        if (!utterance || utterance.id !== id) {
            return false;
        }

        utterance.queue.length = 0;
        utterance.status = "CANCELLED";

        return true;
    }

    getStatus(id) {
        if (!this.current || this.current.id !== id) {
            return null;
        }

        return this.current.status;
    }
}