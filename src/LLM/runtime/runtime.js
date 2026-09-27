export class Runtime {
    constructor({
        url,
        model,
        temperature = 0.7,
        maxTokens = 128
    }) {
        this.url = url;
        this.model = model;
        this.temperature = temperature;
        this.maxTokens = maxTokens;
    }

    async generate(messages, options = {}) {
        const response = await fetch(this.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: this.model,
                messages,
                temperature:
                    options.temperature ??
                    this.temperature,

                max_tokens:
                    options.maxTokens ??
                    this.maxTokens,

                stream: false
            })
        });

        if (!response.ok) {
            const errorText =
                await response.text();
            throw new Error(
                `LLM runtime error ${response.status}: ${errorText}`
            );
        }

        const data =
            await response.json();
        return data.choices?.[0]?.message?.content ?? "";
    }
}