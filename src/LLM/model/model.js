export class Model {

    constructor({ runtime }) {
        this.runtime = runtime;
    }

    async generate(messages, options = {}) {

        return this.runtime.generate(
            messages,
            options
        );
    }
}