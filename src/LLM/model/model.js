function messageContent(message) {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((part) => part?.text ?? part?.content ?? "").join("");
    }
    return "";
}

export class Model {

    constructor({ runtime }) {
        this.runtime = runtime;
    }

    async generate(messages, options = {}) {
        const message = await this.runtime.generate(messages, options);
        const toolCall = message.tool_calls?.[0];

        if (toolCall) {
            let args;

            try {
                args = JSON.parse(toolCall.function?.arguments || "{}");
            } catch {
                args = null;
            }

            return {
                type: "tool_call",
                name: toolCall.function?.name,
                arguments: args,
                id: toolCall.id,
                raw: message
            };
        }

        return {
            type: "final",
            content: messageContent(message)
        };
    }
}
