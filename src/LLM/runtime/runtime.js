export class Runtime {
    constructor({
        url,
        model,
        temperature = 0.7,
        maxTokens = 128,
        frequencyPenalty = 0,
        presencePenalty = 0
    }) {
        this.url = url;
        this.model = model;
        this.temperature = temperature;
        this.maxTokens = maxTokens;
        this.frequencyPenalty = frequencyPenalty;
        this.presencePenalty = presencePenalty;
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
                frequency_penalty: this.frequencyPenalty,
                presence_penalty: this.presencePenalty,
                stream: false,
                chat_template_kwargs: {
                    enable_thinking: false
                }
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