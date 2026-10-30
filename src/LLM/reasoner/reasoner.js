const AFFIRMATIVE = /\b(yes|yeah|yep|sure|okay|ok|confirm(ed)?|go ahead|place (the |my )?order|correct|that'?s right|do it)\b/i;
const NEGATIVE = /\b(no|not|don'?t|cancel|wait|stop|change)\b/i;

const CLAIMS_ORDER = /\b(invoice|order (is |has been )?(placed|confirmed|created)|placed your order)\b/i;

const NOT_PLACED_REPLY =
    "I haven't placed the order yet. Tell me what you'd like and I'll read you the total first.";

const CONFIRM_REPLY =
    "I haven't placed the order yet. Shall I place it? Please say yes to confirm.";

const isAffirmative = (text) => AFFIRMATIVE.test(text) && !NEGATIVE.test(text);

export class Reasoner {
    constructor({
        model,
        systemPrompt,
        maxHistoryMessages = 20,
        tools = [],
        executeTool = null,
        maxToolRounds = 4,
        confirmation = null,
        customer = null,
        callId = null
    }) {
        this.model = model;
        this.systemPrompt = systemPrompt;
        this.maxHistoryMessages = maxHistoryMessages;
        this.tools = executeTool ? tools : [];
        this.executeTool = executeTool;
        this.maxToolRounds = maxToolRounds;
        this.confirmation = executeTool ? confirmation : null;
        this.memory = {
            callId: callId,
            customer: {
                id: customer?.id ?? null,
                name: customer?.name ?? null
            },
            language: "en",
            messages: [],
            metadata: {
                startedAt: Date.now(),
                lastActivity: Date.now()
            },
            pendingAction: null
        };
    }

    async reason(text) {
        this.memory.metadata.lastActivity = Date.now();

        this.memory.messages.push({
            role: "user",
            content: text
        });

        const pending = this.memory.pendingAction;
        this.memory.pendingAction = null;

        if (pending && isAffirmative(text)) {
            await this.runTool(pending.tool, pending.args);
        }

        for (let round = 0; round < this.maxToolRounds; round++) {
            const messages = [
                { role: "system", content: this.systemPrompt },
                ...this.memory.messages.slice(-this.maxHistoryMessages)
            ];

            const response = await this.model.generate(messages, {
                tools: this.tools
            });

            if (response.type === "final") {
                let content = (response.content ?? "")
                    .replace(/\p{Extended_Pictographic}|️/gu, "")
                    .replace(/\s{2,}/g, " ")
                    .trim();

                if (this.confirmation && CLAIMS_ORDER.test(content)) {
                    const hasCommittedInvoice = this.memory.messages.some(
                        (message) =>
                            message.role === "tool" &&
                            message.name === this.confirmation.commitTool &&
                            (() => {
                                try {
                                    return JSON.parse(message.content)?.ok === true;
                                } catch {
                                    return false;
                                }
                            })()
                    );

                    if (!hasCommittedInvoice) {
                        console.warn(`[REASONER][GUARD] - Blocked unverified order claim: ${content}`);
                        content = this.memory.pendingAction ? CONFIRM_REPLY : NOT_PLACED_REPLY;
                    }
                }

                this.memory.messages.push({
                    role: "assistant",
                    content
                });

                console.log(`[REASONER][LLM] - ${content}`);
                return content;
            }

            if (response.type === "tool_call") {
                await this.runTool(response.name, response.arguments, response);
                continue;
            }
        }

        return "Sorry, I couldn't complete that request.";
    }

    async runTool(name, args, response = null) {
        const id = response?.id ?? `call_${Date.now()}`;
        const raw = response?.raw ?? {
            role: "assistant",
            content: "",
            tool_calls: [{
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(args ?? {}) }
            }]
        };

        this.memory.messages.push({
            role: "assistant",
            content: raw.content ?? "",
            tool_calls: raw.tool_calls
        });

        let result;

        if (args === null) {
            result = { ok: false, error: "Tool arguments were not valid JSON." };
        } else if (!this.executeTool) {
            result = { ok: false, error: `Unknown tool ${name}` };
        } else {
            console.log(`[REASONER][TOOL] - ${name} ${JSON.stringify(args)}`);

            try {
                result = await this.executeTool(name, args);
            } catch (error) {
                console.error(`[REASONER][TOOL][ERROR] - ${name}`, error);
                result = { ok: false, error: "The tool failed. Try again later." };
            }

            console.log(`[REASONER][TOOL][RESULT] - ${name} ${JSON.stringify(result)}`);
        }

        this.memory.messages.push({
            role: "tool",
            tool_call_id: id,
            name,
            content: JSON.stringify(result)
        });

        if (this.confirmation && name === this.confirmation.quoteTool && result?.ok) {
            this.memory.pendingAction = {
                tool: this.confirmation.commitTool,
                args: this.confirmation.commitArgs(args)
            };
        }

        return result;
    }
}
