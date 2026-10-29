export class Reasoner {
    constructor({
        model,
        systemPrompt,
        maxHistoryMessages = 6
    }) {
        this.model = model;
        this.systemPrompt = systemPrompt;
        this.maxHistoryMessages = maxHistoryMessages;
        this.messages = [];
    }

    async reason(text) {
        this.messages.push({
            role: "user",
            content: text
        });
        const messages = [
            {
                role: "system",
                content: this.systemPrompt
            },
            ...this.messages.slice(-this.maxHistoryMessages)
        ];

        // Emojis are read out (or garbled) by TTS; strip them before they
        // reach speech or history.
        const response =
            (await this.model.generate(messages))
                .replace(/\p{Extended_Pictographic}|️/gu, "")
                .replace(/\s{2,}/g, " ")
                .trim();
        this.messages.push({
            role: "assistant",
            content: response
        });
        console.log(`[REASONER][LLM] - ${response}`);
        return response;
    }
}