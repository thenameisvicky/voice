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

export class Runtime {
    constructor({
        url,
        model,
        apiKey = "",
        timeoutMs = 30000,
        retryMax = 1,
        temperature = 0.7,
        maxTokens = 128,
        frequencyPenalty = 0,
        presencePenalty = 0,
        localCompat = false,
        reasoningEffort = "",
        fetchImpl = fetch
    }) {
        this.url = url;
        this.model = model;
        this.apiKey = apiKey;
        this.timeoutMs = timeoutMs;
        this.retryMax = Math.max(0, Number(retryMax) || 0);
        this.temperature = temperature;
        this.maxTokens = maxTokens;
        this.frequencyPenalty = frequencyPenalty;
        this.presencePenalty = presencePenalty;
        this.localCompat = localCompat;
        this.reasoningEffort = reasoningEffort;
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
                await sleep(error.retryAfterMs ?? 400 * (attempt + 1));
            }
        }

        throw lastError;
    }

    async requestOnce(messages, options, attempt) {
        const requestedAt = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        const headers = { "Content-Type": "application/json" };
        if (this.apiKey) {
            headers.Authorization = `Bearer ${this.apiKey}`;
        }

        const body = {
            model: this.model,
            messages,
            temperature: options.temperature ?? this.temperature,
            max_tokens: options.maxTokens ?? this.maxTokens,
            stream: false
        };

        if (options.tools?.length) {
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

        if (!response.ok) {
            const errorText = await response.text();
            const code = response.status === 429
                ? "rate_limit"
                : response.status === 401 || response.status === 403
                    ? "auth"
                    : "provider";
            const providerError = new LlmProviderError(
                code,
                `LLM runtime error ${response.status}: ${errorText.slice(0, 400)}`,
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

        const data = await response.json();

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

        telemetry.recordModelUsage(options.callId, this.model, {
            stage: STAGES.LLM,
            promptTokens: data.usage?.prompt_tokens,
            completionTokens: data.usage?.completion_tokens,
            totalTokens: data.usage?.total_tokens,
            durationMs,
            ttftMs: null,
            retries: attempt
        });

        return data.choices?.[0]?.message ?? { content: "" };
    }

    recordFailure(callId, error, extra = {}) {
        telemetry.recordError(callId, STAGES.LLM, error);
        telemetry.recordModelUsage(callId, this.model, {
            stage: STAGES.LLM,
            promptTokens: 0,
            completionTokens: 0,
            durationMs: extra.durationMs ?? null,
            ttftMs: null,
            retries: extra.attempt ?? 0
        });
    }
}
