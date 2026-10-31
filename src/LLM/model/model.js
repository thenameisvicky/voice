export function parseToolCallFromContent(content) {
    const text = String(content || "").trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();

    if (!text.startsWith("{")) return null;

    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.name === "string") {
            return {
                name: parsed.name,
                arguments: parsed.arguments && typeof parsed.arguments === "object"
                    ? parsed.arguments
                    : {}
            };
        }
    } catch {
        return null;
    }

    return null;
}

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
            const rawArgs = toolCall.function?.arguments;

            try {
                args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : (rawArgs || {});
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

        const spokenTool = parseToolCallFromContent(messageContent(message));
        if (spokenTool) {
            return {
                type: "tool_call",
                name: spokenTool.name,
                arguments: spokenTool.arguments,
                id: `call_${Date.now()}`,
                raw: message
            };
        }

        return {
            type: "final",
            content: messageContent(message)
        };
    }
}
