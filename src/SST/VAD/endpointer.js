class VAD {
    constructor(runtime, config) {
        this.runtime = runtime;
        this.config = config;
        this.state = "NOT_SPEAKING";
    }
    process(pcm) {
        const output = this.runtime.process(pcm);
    }
}