export class Endpointer {
    constructor(config = {}) {
        this.startThreshold = config.startThreshold ?? 0.5;
        this.endThreshold = config.endThreshold ?? 0.3;
        this.minSpeechDurationMs =
            config.minSpeechDurationMs ?? 100;
        this.minSilenceDurationMs =
            config.minSilenceDurationMs ?? 300;
        this.state = "NOT_SPEAKING";
        this.speechDurationMs = 0;
        this.silenceDurationMs = 0;
        this.totalSamples = 0;
    }

    process({ probability, frameSamples }) {
        const frameDurationMs =
            frameSamples / 16000 * 1000;
        this.totalSamples += frameSamples;
        if (this.state === "NOT_SPEAKING") {
            this.silenceDurationMs = 0;
            if (probability >= this.startThreshold) {
                this.speechDurationMs += frameDurationMs;
                if (
                    this.speechDurationMs >=
                    this.minSpeechDurationMs
                ) {
                    this.state = "SPEAKING";

                    this.silenceDurationMs = 0;

                    return {
                        type: "START",
                        timestampSamples: this.totalSamples
                    };
                }
            } else {
                this.speechDurationMs = 0;
            }
            return {
                type: "IDLE",
                timestampSamples: this.totalSamples
            };
        }

        if (this.state === "SPEAKING") {
            if (probability <= this.endThreshold) {
                this.silenceDurationMs += frameDurationMs;
                if (
                    this.silenceDurationMs >=
                    this.minSilenceDurationMs
                ) {
                    this.state = "NOT_SPEAKING";
                    this.speechDurationMs = 0;
                    this.silenceDurationMs = 0;

                    return {
                        type: "END",
                        timestampSamples: this.totalSamples
                    };
                }
            } else {
                this.silenceDurationMs = 0;
            }

            return {
                type: "IDLE",
                timestampSamples: this.totalSamples
            };
        }

        return null;
    }

    reset() {
        this.state = "NOT_SPEAKING";
        this.speechDurationMs = 0;
        this.silenceDurationMs = 0;
        this.totalSamples = 0;
    }
}