import { isFreeOpenRouterModel } from "../config.js";
import { QUEUE_SOURCES, STAGES } from "../../telemetry/config.js";
import telemetry from "../../telemetry/telemetry.js";

export class LlmProviderError extends Error {
    constructor(code, message, { status = 0, retryAfterMs = null } = {}) {
        super(message);
        this.name = "LlmProviderError";
        this.code = code;
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(response) {
    const header = response.headers?.get?.("retry-after");
    if (!header) return 400;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(header);
    return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : 400;
}

function backoffMs(error, attempt) {
    const base = error.retryAfterMs ?? 400 * (2 ** attempt);
    return base + Math.floor(Math.random() * 200);
}

function normalizeMessages(messages, sendTools) {
    if (sendTools) return messages;

    return messages.map((message) => {
        if (message.role === "tool") {
            return {
                role: "user",
                content: `Tool ${message.name || "result"}: ${message.content || ""}`
            };
        }

        if (message.role === "assistant" && message.tool_calls) {
            const name = message.tool_calls[0]?.function?.name;
            return {
                role: "assistant",
                content: message.content || (name ? `Calling ${name}` : "")
            };
        }

        return {
            role: message.role,
            content: typeof message.content === "string" ? message.content : ""
        };
    });
}

function classifyHttpError(status, errorText) {
    if (status === 429) return "rate_limit";
    if (status === 401 || status === 403) return "auth";
    if (status === 404 || /model.*(not found|unavailable|does not exist|invalid)/i.test(errorText || "")) {
        return "model_unavailable";
    }
    return "provider";
}

function readErrorText(data, fallback) {
    const message = data?.error?.message || data?.error?.code || fallback || "";
    const raw = data?.error?.metadata?.raw;
    return raw && typeof raw === "string" && raw !== message ? `${message} (${raw})` : message;
}

export class Runtime {
    constructor({
        url,
        model,
        apiKey = "",
        fallbackModels = [],
        extraHeaders = {},
        sendTools = true,
        timeoutMs = 30000,
        retryMax = 1,
        temperature = 0.7,
        maxTokens = 128,
        frequencyPenalty = 0,
        presencePenalty = 0,
        localCompat = false,
        reasoningEffort = "",
        provider = "local",
        fetchImpl = fetch
    }) {
        this.url = url;
        this.model = model;
        this.fallbackModels = Array.isArray(fallbackModels) ? fallbackModels : [];
        this.apiKey = apiKey;
        this.extraHeaders = extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {};
        this.sendTools = sendTools !== false;
        this.timeoutMs = timeoutMs;
        this.retryMax = Math.max(0, Number(retryMax) || 0);
        this.temperature = temperature;
        this.maxTokens = maxTokens;
        this.frequencyPenalty = frequencyPenalty;
        this.presencePenalty = presencePenalty;
        this.localCompat = localCompat;
        this.reasoningEffort = reasoningEffort;
        this.provider = provider;
        this.fetchImpl = fetchImpl;
    }

    async generate(messages, options = {}) {
        let lastError = null;

        for (let attempt = 0; attempt <= this.retryMax; attempt++) {
            try {
                return await this.requestOnce(messages, options, attempt);
            } catch (error) {
                lastError = error;
                const retryable =
                    error instanceof LlmProviderError &&
                    (error.code === "timeout" || error.code === "rate_limit" || error.status >= 500);
                if (!retryable || attempt === this.retryMax) {
                    throw error;
                }
                await sleep(backoffMs(error, attempt));
            }
        }

        throw lastError;
    }

    assertOpenRouterModel() {
        if (this.provider !== "openrouter") return;
        const paid = [this.model, ...this.fallbackModels].find((id) => !isFreeOpenRouterModel(id));
        if (!paid) return;
        throw new LlmProviderError(
            "model_unavailable",
            `Refusing paid OpenRouter model "${paid}". OPENROUTER_MODEL and OPENROUTER_FALLBACK_MODELS must be :free models.`,
            { status: 400 }
        );
    }

    async requestOnce(messages, options, attempt) {
        this.assertOpenRouterModel();

        const requestedAt = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        const headers = {
            "Content-Type": "application/json",
            ...this.extraHeaders
        };
        if (this.apiKey) {
            headers.Authorization = `Bearer ${this.apiKey}`;
        }

        const body = {
            model: this.model,
            messages: normalizeMessages(messages, this.sendTools),
            temperature: options.temperature ?? this.temperature,
            max_tokens: options.maxTokens ?? this.maxTokens,
            stream: false
        };

        if (this.provider === "openrouter" && this.fallbackModels.length) {
            body.models = [this.model, ...this.fallbackModels];
        }

        if (this.sendTools && options.tools?.length) {
            body.tools = options.tools;
        }

        if (this.localCompat) {
            body.frequency_penalty = this.frequencyPenalty;
            body.presence_penalty = this.presencePenalty;
            body.chat_template_kwargs = { enable_thinking: false };
        } else if (this.reasoningEffort) {
            body.reasoning_effort = this.reasoningEffort;
        }

        let response;

        try {
            response = await this.fetchImpl(this.url, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                signal: controller.signal
            });
        } catch (error) {
            const durationMs = Date.now() - requestedAt;
            const timedOut = error?.name === "AbortError";
            const providerError = new LlmProviderError(
                timedOut ? "timeout" : "network",
                timedOut
                    ? `LLM timed out after ${this.timeoutMs}ms`
                    : `LLM network error: ${error?.message ?? error}`,
                { status: timedOut ? 408 : 0 }
            );
            this.recordFailure(options.callId, providerError, { durationMs, attempt });
            throw providerError;
        } finally {
            clearTimeout(timer);
        }

        const durationMs = Date.now() - requestedAt;
        const rawText = await response.text();
        let data = null;

        if (rawText) {
            try {
                data = JSON.parse(rawText);
            } catch {
                data = null;
            }
        }

        if (!response.ok) {
            const errorText = readErrorText(data, rawText).slice(0, 400);
            const code = classifyHttpError(response.status, errorText);
            const providerError = new LlmProviderError(
                code,
                `LLM runtime error ${response.status}: ${errorText}`,
                { status: response.status, retryAfterMs: retryAfterMs(response) }
            );
            console.error(`[LLM] ${providerError.message}`);
            this.recordFailure(options.callId, providerError, {
                durationMs,
                attempt,
                status: response.status
            });
            throw providerError;
        }

        if (!data || typeof data !== "object") {
            const providerError = new LlmProviderError(
                "provider",
                "LLM returned a malformed response",
                { status: response.status }
            );
            this.recordFailure(options.callId, providerError, {
                durationMs,
                attempt,
                status: response.status
            });
            throw providerError;
        }

        const message = data.choices?.[0]?.message;
        if (!message) {
            const providerError = new LlmProviderError(
                "provider",
                "LLM response had no message",
                { status: response.status }
            );
            this.recordFailure(options.callId, providerError, {
                durationMs,
                attempt,
                status: response.status
            });
            throw providerError;
        }

        if (data.timings) {
            const servedMs =
                Number(data.timings.prompt_ms ?? 0) +
                Number(data.timings.predicted_ms ?? 0);
            telemetry.recordQueueWait(
                options.callId,
                QUEUE_SOURCES.LLM_SERVER,
                Date.now() - requestedAt - servedMs
            );
        }

        const servedModel = data.model || this.model;
        if (this.provider === "openrouter" && data.model && !String(data.model).startsWith(this.model.replace(/:free$/, ""))) {
            console.log(`[LLM] Served by fallback ${data.model}`);
        }

        telemetry.recordModelUsage(options.callId, servedModel, {
            stage: STAGES.LLM,
            provider: this.provider,
            promptTokens: data.usage?.prompt_tokens,
            completionTokens: data.usage?.completion_tokens,
            totalTokens: data.usage?.total_tokens,
            durationMs,
            ttftMs: null,
            retries: attempt,
            status: response.status
        });

        return message;
    }

    recordFailure(callId, error, extra = {}) {
        telemetry.recordError(callId, STAGES.LLM, error);
        telemetry.recordModelUsage(callId, this.model, {
            stage: STAGES.LLM,
            provider: this.provider,
            promptTokens: 0,
            completionTokens: 0,
            durationMs: extra.durationMs ?? null,
            ttftMs: null,
            retries: extra.attempt ?? 0,
            status: extra.status ?? error.status ?? 0,
            errorCode: error.code
        });
    }
}
