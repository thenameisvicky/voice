export class Reasoner {
    constructor({
        model,
        systemPrompt
    }) {
        this.model = model;
        this.systemPrompt = systemPrompt;
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
            ...this.messages
        ];

        const response =
            await this.model.generate(messages);
        this.messages.push({
            role: "assistant",
            content: response
        });
        
        return response;
    }
}