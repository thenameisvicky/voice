import { buildSystemPrompt } from "../LLM/config.js";
import { INFERENCE_CONFIG } from "../inference/config.js";
import { Model } from "../LLM/model/model.js";
import { Reasoner } from "../LLM/reasoner/reasoner.js";
import { TOOL_DEFINITIONS, ORDER_CONFIRMATION, createToolExecutor } from "../LLM/reasoner/agentTools.js";
import { Runtime } from "../LLM/runtime/runtime.js";
import { SST_CONFIG } from "../SST/config.js";
import telemetry from "../telemetry/telemetry.js";
import { STAGES } from "../telemetry/config.js";
import { BatchTranscriber } from "../SST/transcriber/batch.js";
import { StreamTranscriber } from "../SST/transcriber/stream.js";
import { UtteranceBuffer } from "../SST/utterance/utteranceBuffer.js";
import { Endpointer } from "../SST/VAD/endpointer.js";
import { AudioFramer } from "../SST/VAD/framer.js";
import { VADInference } from "../SST/VAD/inference.js";
import { initializeStrategy } from "../TTS/strategy/index.js";
import { synthesize } from "../TTS/synthesizer/synthesizer.js";

const SAMPLE_RATE = 16000;

const audioMs = (samples) => (samples.length / SAMPLE_RATE) * 1000;

export class Voice {
    constructor({ audioFramer, vad, endpointer, batchTranscriber, reasoner, synthesizer, onEvent, utteranceBuffer, streamTranscriber, onAudio, onHangup, callId }) {
        this.audioFramer = audioFramer;
        this.vad = vad;
        this.endpointer = endpointer;
        this.batchTranscriber = batchTranscriber;
        this.reasoner = reasoner;
        this.synthesizer = synthesizer;
        this.onEvent = onEvent;
        this.utteranceBuffer = utteranceBuffer;
        this.streamTranscriber = streamTranscriber;
        this.onAudio = onAudio;
        this.onHangup = onHangup;
        this.callId = callId;
        this.hangup = false;
    }

    async voice(audioChunk) {
        if (this.hangup) return;

        const pcmChunk = new Int16Array(
            audioChunk.buffer,
            audioChunk.byteOffset,
            audioChunk.byteLength / 2
        );

        const frames = this.audioFramer.process(pcmChunk);

        for (const frame of frames) {
            telemetry.startSpan(this.callId, STAGES.VAD, { frameSamples: frame.length });
            const voiceActivity = await this.vad.process(frame);
            telemetry.endSpan(this.callId, STAGES.VAD, {
                ok: true,
                probability: voiceActivity.probability
            });

            this.onEvent?.({ type: "vad", probability: voiceActivity.probability });
            const event = this.endpointer.process({ probability: voiceActivity["probability"], frameSamples: voiceActivity["frameSamples"] });

            const speechChunk = this.utteranceBuffer.process({ event: event, frame: frame });

            if (speechChunk) {
                await this.turn(speechChunk, voiceActivity.probability);
            }
        }
    }

    async turn(speechChunk, probability) {
        const callId = this.callId;
        const userAudioMs = audioMs(speechChunk);

        telemetry.startTurn(callId, { userAudioMs });

        try {
            telemetry.startSpan(callId, STAGES.ASR, {
                audioMs: userAudioMs,
                samples: speechChunk.length
            });

            let transcript;

            try {
                transcript = await this.batchTranscriber.transcribe(speechChunk);
            } catch (error) {
                telemetry.endSpan(callId, STAGES.ASR, { error, audioMs: userAudioMs });
                throw error;
            }

            telemetry.endSpan(callId, STAGES.ASR, {
                ok: true,
                audioMs: userAudioMs,
                transcript,
                chars: transcript?.length ?? 0
            });

            if (!transcript?.trim()) {
                telemetry.endTurn(callId, { ok: true, userAudioMs, reason: "empty transcript" });
                return;
            }

            this.onEvent?.({ type: "transcript", probability, text: transcript });

            const reasoned = await this.reasoner.reason(transcript);
            const response = typeof reasoned === "string" ? reasoned : reasoned?.content;
            const hangup = Boolean(reasoned?.hangup);

            if (typeof response !== "string" || !response.trim()) {
                telemetry.endTurn(callId, {
                    ok: false,
                    transcript,
                    userAudioMs,
                    reason: "no reply produced"
                });
                return;
            }

            telemetry.startSpan(callId, STAGES.TTS, { chars: response.length });

            let result;

            try {
                result = await this.synthesizer.synthesize(response, { language: "en" });
            } catch (error) {
                telemetry.endSpan(callId, STAGES.TTS, { error, chars: response.length });
                throw error;
            }

            const replyAudioMs = result.audio?.audio && result.audio?.sampling_rate
                ? (result.audio.audio.length / result.audio.sampling_rate) * 1000
                : null;

            telemetry.endSpan(callId, STAGES.TTS, {
                ok: true,
                audioMs: replyAudioMs,
                chars: response.length
            });

            telemetry.recordModelUsage(callId, "Kokoro-82M-v1.0-ONNX", {
                stage: STAGES.TTS,
                audioMs: replyAudioMs,
                chars: response.length
            });

            this.onEvent?.({ type: "response", text: response });

            this.onAudio?.(result.audioBuffer, { hangup });

            telemetry.endTurn(callId, {
                ok: true,
                transcript,
                response,
                userAudioMs,
                replyAudioMs,
                replyChars: response.length
            });

            if (hangup) {
                this.hangup = true;
                this.onHangup?.({ afterMs: replyAudioMs ?? 4000 });
            }
        } catch (error) {
            telemetry.recordError(callId, STAGES.TURN, error);
            telemetry.endTurn(callId, { ok: false, userAudioMs, reason: String(error?.message ?? error) });
            throw error;
        }
    }

    async streamingVoice(audioChunk) {
        const pcmChunk = new Int16Array(
            audioChunk.buffer,
            audioChunk.byteOffset,
            audioChunk.byteLength / 2
        );

        const frames = this.audioFramer.process(pcmChunk);

        for (const frame of frames) {
            const voiceActivity = await this.vad.process(frame);
            this.onEvent?.({ type: "vad", probability: voiceActivity.probability });
            const event = this.endpointer.process({ probability: voiceActivity["probability"], frameSamples: voiceActivity["frameSamples"] });
            console.log(`[STREAMING][VOICE][EVENTS] - ${event?.type}`);

            if (event?.type == "START") {
                this.streamTranscriber.start();
            }

            if (event?.type == "END") {
                const full = await this.streamTranscriber.finalize(frame);
                if (full) {
                    this.onEvent?.({
                        type: "transcript",
                        probability: voiceActivity.probability,
                        text: full
                    });
                }
                continue;
            }

            const partial = await this.streamTranscriber.pushAudio(frame)
            if (partial) {
                this.onEvent?.({
                    type: "transcript",
                    probability: voiceActivity.probability,
                    text: partial
                });
            }
        }
    }

    static async createVoice({ onEvent, onAudio, onHangup = null, customer = null, callId = null }) {
        const framer = new AudioFramer(512);
        const vad = new VADInference();
        const endpointer = new Endpointer(SST_CONFIG);
        const utteranceBuffer = new UtteranceBuffer();
        const llm = INFERENCE_CONFIG.llm;
        const batchTranscriber = new BatchTranscriber({ url: INFERENCE_CONFIG.asr.url });
        const streamTranscriber = new StreamTranscriber(batchTranscriber);
        const synthesizer = { synthesize };
        const runtime = new Runtime({
            url: llm.url,
            model: llm.model,
            apiKey: llm.apiKey || undefined,
            timeoutMs: llm.timeoutMs,
            retryMax: llm.retryMax,
            temperature: llm.temperature,
            maxTokens: llm.maxTokens,
            frequencyPenalty: llm.frequencyPenalty,
            presencePenalty: llm.presencePenalty,
            localCompat: llm.localCompat,
            reasoningEffort: llm.reasoningEffort
        });
        if (INFERENCE_CONFIG.mode === "provider" && !runtime.apiKey) {
            console.error("[LLM] No API key. Set GROQ_API_KEY or LLM_API_KEY before starting the server.");
        }
        const model = new Model({ runtime });
        const reasoner = new Reasoner({
            model,
            systemPrompt: buildSystemPrompt({ customer }),
            maxHistoryMessages: llm.maxHistoryMessages,
            tools: TOOL_DEFINITIONS,
            executeTool: createToolExecutor({ customer }),
            maxToolRounds: llm.maxToolRounds,
            confirmation: ORDER_CONFIRMATION,
            customer,
            callId
        });
        const voice = new Voice({
            audioFramer: framer,
            vad: vad,
            endpointer: endpointer,
            onEvent: onEvent,
            utteranceBuffer: utteranceBuffer,
            batchTranscriber: batchTranscriber,
            reasoner: reasoner,
            streamTranscriber: streamTranscriber,
            synthesizer: synthesizer,
            onAudio: onAudio,
            onHangup: onHangup,
            callId: callId
        });

        await vad.init();
        await initializeStrategy("en");

        return { voice, synthesizer };
    };
};