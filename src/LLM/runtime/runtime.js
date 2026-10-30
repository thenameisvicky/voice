import { QUEUE_SOURCES, STAGES } from "../../telemetry/config.js";
import telemetry from "../../telemetry/telemetry.js";

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
        const requestedAt = Date.now();

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
                ...(options.tools?.length ? { tools: options.tools } : {}),
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
            totalTokens: data.usage?.total_tokens
        });

        return data.choices?.[0]?.message ?? { content: "" };
    }
}