import { CALL_OUTRO } from "../config.js";
import { LlmProviderError } from "../runtime/runtime.js";
import { TRANSFER_TOOL } from "./agentTools.js";
import { STAGES } from "../../telemetry/config.js";
import telemetry from "../../telemetry/telemetry.js";

const AFFIRMATIVE = /\b(yes|yeah|yep|sure|okay|ok|confirm(ed)?|go ahead|place (the |my )?order|correct|that'?s right|do it)\b/i;
const NEGATIVE = /\b(no|not|don'?t|cancel|wait|stop|change)\b/i;
const GOODBYE = /\b(bye|goodbye|good bye|good night|that's all|thats all|that is all|nothing else|i'?m done|hang up|end (the )?call)\b/i;

const CLAIMS_ORDER = /\b(invoice|order (is |has been )?(placed|confirmed|created)|placed your order)\b/i;
const CLAIMS_TRANSFER = /\b(transferred you|you're (now )?connected|you are (now )?connected|speaking (to|with) (a |the )?(human|agent)|i('ve| have) (connected|transferred))\b/i;

const TRANSFER_NOT_STARTED_REPLY =
    "I haven't transferred the call yet. I can connect you to a team if you want.";

const TRANSFER_CONFIRM_REPLY =
    "I can transfer you. Please say yes to confirm.";

const NOT_PLACED_REPLY =
    "I haven't placed the order yet. Tell me what you'd like and I'll read you the total first.";

const CONFIRM_REPLY =
    "I haven't placed the order yet. Shall I place it? Please say yes to confirm.";

const INVOICE_OUTRO = "I've put a draft invoice on your account. Thank you, have a nice day.";

const MONGO_OBJECT_ID = /\b[a-fA-F0-9]{24}\b/g;

const isAffirmative = (text) => AFFIRMATIVE.test(text) && !NEGATIVE.test(text);
const isGoodbye = (text) => GOODBYE.test(text);

export function sanitizeSpokenText(text) {
    return String(text || "")
        .replace(/\p{Extended_Pictographic}|️/gu, "")
        .replace(MONGO_OBJECT_ID, "")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/`+/g, "")
        .replace(/^\s*[-•]\s+/gm, "")
        .replace(/\*/g, "")
        .replace(/\s{2,}/g, " ")
        .replace(/\s+([,.!?])/g, "$1")
        .trim();
}

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
        callId = null,
        transferContext = null
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
            pendingAction: null,
            catalog: [],
            transfer: transferContext
                ? {
                    status: transferContext.status,
                    department: transferContext.department ?? null,
                    label: transferContext.label ?? null,
                    reason: transferContext.reason ?? null
                }
                : {
                    status: "none",
                    department: null,
                    label: null,
                    reason: null
                },
            order: {
                customerId: customer?.id ?? null,
                lines: [],
                total_rupees: null,
                status: "empty",
                shortage: null
            }
        };
        this.hangup = false;
        this.hangupReason = null;
        this.confirmedTransfer = false;
        this.outro = null;
        this.invoiceCommitted = false;
        this.committedInvoice = null;
    }

    reply(content, hangup = this.hangup) {
        content = sanitizeSpokenText(content);

        this.memory.messages.push({
            role: "assistant",
            content
        });

        console.log(`[REASONER][LLM] - ${content}`);
        return {
            content,
            hangup: Boolean(hangup),
            hangupReason: hangup ? this.hangupReason : null
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

        if (isGoodbye(text)) {
            await this.runTool("end_call", { reason: "goodbye" });
        } else if (pending && isAffirmative(text)) {
            this.confirmedTransfer = pending.tool === TRANSFER_TOOL;
            await this.runTool(pending.tool, pending.args);
            this.confirmedTransfer = false;
        } else if (pending && NEGATIVE.test(text)) {
            if (pending.tool === this.confirmation?.commitTool) {
                this.memory.order.status = "rejected";
            }
        }

        if (this.hangup) {
            return this.reply(this.outro || CALL_OUTRO, true);
        }

        for (let round = 0; round < this.maxToolRounds; round++) {
            const messages = [
                { role: "system", content: `${this.systemPrompt}${this.orderContext()}` },
                ...this.memory.messages.slice(-this.maxHistoryMessages)
            ];

            telemetry.startSpan(this.memory.callId, STAGES.LLM, {
                round,
                messages: messages.length,
                toolsOffered: this.tools.length
            });

            let response;

            try {
                response = await this.model.generate(messages, {
                    tools: this.tools,
                    callId: this.memory.callId
                });
            } catch (error) {
                telemetry.endSpan(this.memory.callId, STAGES.LLM, { error, round });
                console.error(`[REASONER][LLM][ERROR] ${error.code || error.name}: ${error.message}`);
                if (error instanceof LlmProviderError) {
                    const spoken = error.code === "rate_limit"
                        ? "The assistant is busy right now. Please try again in a moment."
                        : error.code === "model_unavailable"
                            ? "The assistant model is unavailable right now. Please try again."
                            : "Sorry, I had trouble thinking just now. Please say that again.";
                    return this.reply(spoken, false);
                }
                throw error;
            }

            telemetry.endSpan(this.memory.callId, STAGES.LLM, {
                ok: true,
                round,
                responseType: response.type,
                toolName: response.name ?? null,
                chars: response.content?.length ?? 0
            });

            if (response.type === "final") {
                let content = sanitizeSpokenText(response.content ?? "");

                if (CLAIMS_TRANSFER.test(content) && this.memory.transfer?.status !== "connected") {
                    console.warn(`[REASONER][GUARD] - Blocked unverified transfer claim: ${content}`);
                    content = this.memory.pendingAction?.tool === TRANSFER_TOOL
                        ? TRANSFER_CONFIRM_REPLY
                        : TRANSFER_NOT_STARTED_REPLY;
                }

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

                return this.reply(content, false);
            }

            if (response.type === "tool_call") {
                await this.runTool(response.name, response.arguments, response);

                if (this.hangup) {
                    return this.reply(this.outro || CALL_OUTRO, true);
                }

                continue;
            }
        }

        return this.reply("Sorry, I couldn't complete that request.", false);
    }

    orderContext() {
        const order = this.memory.order;
        const transfer = this.transferContext();
        if (!order?.lines?.length && !order?.shortage) return transfer;

        const lines = (order.lines || []).map((line) =>
            `${line.name} x ${line.quantity}${line.partial ? " (partial)" : ""} [item_id ${line.item_id}]`
        );
        const parts = ["", "## Pending order"];
        if (lines.length) parts.push(lines.join("; "));
        if (order.total_rupees != null) parts.push(`Quoted total: ${order.total_rupees} rupees.`);
        if (order.shortage) {
            parts.push(
                `Stock shortfall: ${order.shortage.name} requested ${order.shortage.requested}, available ${order.shortage.available} ${order.shortage.unit || ""}.`
            );
        }
        parts.push(`Status: ${order.status}.`);
        return `\n${parts.join("\n")}${transfer}`;
    }

    transferContext() {
        const transfer = this.memory.transfer;
        if (!transfer || transfer.status === "none") return "";

        const parts = ["", "## Transfer"];
        if (transfer.label || transfer.department) {
            parts.push(`Department: ${transfer.label || transfer.department}.`);
        }
        parts.push(`Status: ${transfer.status}.`);
        if (transfer.reason) parts.push(`Reason: ${transfer.reason}.`);
        if (transfer.status === "initiated" || transfer.status === "connecting") {
            parts.push("The transfer has only been requested. Do not say the caller is already connected.");
        }
        if (transfer.status === "failed" || transfer.status === "timeout") {
            parts.push("The previous transfer did not connect. Keep helping the caller here.");
        }
        return `\n${parts.join("\n")}`;
    }

    conversationSummary(explicit) {
        const bits = [];
        if (this.memory.customer?.name) bits.push(`Customer ${this.memory.customer.name}.`);

        const lines = this.memory.order?.lines || [];
        if (lines.length) {
            bits.push(
                `Pending order: ${lines.map((line) => `${line.name} x ${line.quantity}`).join(", ")}` +
                (this.memory.order.total_rupees != null ? `, ${this.memory.order.total_rupees} rupees.` : ".")
            );
        }

        const recent = this.memory.messages
            .filter((message) => message.role === "user" && message.content)
            .slice(-3)
            .map((message) => message.content)
            .join(" ");
        if (recent) bits.push(`Recent request: ${recent}`);
        if (explicit) bits.push(String(explicit));

        return bits.join(" ").replace(/\s+/g, " ").trim().slice(0, 320);
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

        const callId = this.memory.callId;

        let result;

        if (this.confirmation && name === this.confirmation.commitTool && this.invoiceCommitted) {
            result = {
                ok: true,
                duplicate: true,
                invoice_number: this.committedInvoice?.invoice_number ?? null,
                total_rupees: this.committedInvoice?.total_rupees ?? null,
                status: this.committedInvoice?.status ?? null
            };
        } else if (args === null) {
            result = { ok: false, error: "Tool arguments were not valid JSON." };
        } else if (!this.executeTool) {
            result = { ok: false, error: `Unknown tool ${name}` };
        } else {
            console.log(`[REASONER][TOOL] - ${name} ${JSON.stringify(args)}`);

            telemetry.startSpan(callId, STAGES.TOOL, { name });

            try {
                const safeArgs = name === TRANSFER_TOOL
                    ? {
                        department: args?.department,
                        reason: args?.reason,
                        summary: this.conversationSummary(args?.summary)
                    }
                    : args;
                result = await this.executeTool(name, safeArgs, {
                    confirmed: name === TRANSFER_TOOL ? this.confirmedTransfer === true : undefined
                });
            } catch (error) {
                console.error(`[REASONER][TOOL][ERROR] - ${name}`, error);
                result = { ok: false, error: "The tool failed. Try again later." };
            }

            telemetry.endSpan(callId, STAGES.TOOL, {
                ok: true,
                name,
                toolOk: result?.ok === true,
                error: result?.ok === false ? result.error : undefined
            });

            console.log(`[REASONER][TOOL][RESULT] - ${name} ${JSON.stringify(result)}`);
        }

        if (this.confirmation && name === this.confirmation.commitTool && !result?.duplicate) {
            telemetry.recordBusinessAction(callId, name, {
                ok: result?.ok === true,
                invoiceNumber: result?.invoice_number ?? null,
                totalRupees: result?.total_rupees ?? null,
                error: result?.error ?? null
            });

            if (result?.ok === true) {
                this.invoiceCommitted = true;
                this.committedInvoice = result;
                this.memory.order.status = "committed";
                this.hangup = true;
                this.hangupReason = "goodbye";
                this.outro = INVOICE_OUTRO;
            }
        }

        if (name === "end_call" && result?.ok === true) {
            this.hangup = true;
            this.hangupReason = "goodbye";
            this.outro = result.message || CALL_OUTRO;
        }

        if (name === TRANSFER_TOOL) {
            if (result?.needs_confirmation) {
                this.memory.transfer = {
                    status: "needs_confirmation",
                    department: result.department,
                    label: result.label,
                    reason: null
                };
                this.memory.pendingAction = {
                    tool: TRANSFER_TOOL,
                    args: {
                        department: result.department,
                        reason: result.reason ?? args?.reason,
                        summary: args?.summary
                    }
                };
            } else if (result?.status === "initiated") {
                this.memory.transfer = {
                    status: "initiated",
                    department: result.department,
                    label: result.label,
                    reason: null
                };
                this.hangup = true;
                this.hangupReason = "transfer";
                this.outro = result.message || "I'm connecting you now.";
            } else if (result?.ok === false) {
                this.memory.transfer = {
                    status: result.code || "failed",
                    department: result.department ?? this.memory.transfer.department,
                    label: result.label ?? this.memory.transfer.label,
                    reason: result.error ?? null
                };
            }
        }

        this.memory.messages.push({
            role: "tool",
            tool_call_id: id,
            name,
            content: JSON.stringify(result)
        });

        if (name === "search_catalog" && result?.ok && Array.isArray(result.items)) {
            this.memory.catalog = result.items;
        }

        if (name === this.confirmation?.quoteTool) {
            if (result?.ok) {
                this.memory.order = {
                    ...this.memory.order,
                    lines: result.items || [],
                    total_rupees: result.total_rupees ?? null,
                    status: "quoted",
                    shortage: null
                };
                this.memory.pendingAction = {
                    tool: this.confirmation.commitTool,
                    args: this.confirmation.commitArgs(args, result)
                };
            } else if (result?.code === "insufficient_stock") {
                this.memory.order = {
                    ...this.memory.order,
                    lines: result.items || this.memory.order.lines,
                    status: "shortage",
                    shortage: result.shortage || null
                };
                telemetry.recordBusinessAction(callId, "stockout", {
                    ok: false,
                    product: result.shortage?.name ?? null,
                    requested: result.shortage?.requested ?? null,
                    available: result.shortage?.available ?? null,
                    alternatives: (result.alternatives || []).map((item) => item.name)
                });
            }
        }

        return result;
    }
}
