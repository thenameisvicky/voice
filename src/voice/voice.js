import { buildSystemPrompt } from "../LLM/config.js";
import { INFERENCE_CONFIG } from "../inference/config.js";
import { Model } from "../LLM/model/model.js";
import { Reasoner } from "../LLM/reasoner/reasoner.js";
import { toolDefinitions, ORDER_CONFIRMATION, createToolExecutor } from "../LLM/reasoner/agentTools.js";
import { transfers as defaultTransfers } from "../telephony/callTransfer.js";
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
import { SarvamRuntime } from "../TTS/runtime/sarvam.js";

const SAMPLE_RATE = 16000;

const audioMs = (samples) => (samples.length / SAMPLE_RATE) * 1000;

export class Voice {
    constructor({ audioFramer, vad, endpointer, batchTranscriber, reasoner, synthesizer, onEvent, utteranceBuffer, streamTranscriber, onAudio, onHangup, onBargeIn = null, bargeInMs = SST_CONFIG.bargeInMs, callId }) {
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
        this.onBargeIn = onBargeIn;
        this.bargeInMs = bargeInMs;
        this.callId = callId;
        this.hangup = false;
        this.speechMs = 0;
        this.bargedIn = false;
    }

    trackBargeIn(event, probability, frameSamples) {
        if (!this.onBargeIn || !event) return;

        if (event.type === "END") {
            this.speechMs = 0;
            this.bargedIn = false;
            return;
        }

        if (event.type === "START") {
            this.speechMs = this.endpointer.minSpeechDurationMs ?? 0;
        } else if (this.endpointer.state === "SPEAKING" && probability >= (this.endpointer.startThreshold ?? 0.5)) {
            this.speechMs += (frameSamples / SAMPLE_RATE) * 1000;
        }

        if (!this.bargedIn && this.speechMs >= this.bargeInMs) {
            this.bargedIn = true;
            this.onBargeIn();
        }
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
            this.trackBargeIn(event, voiceActivity.probability, voiceActivity.frameSamples ?? frame.length);

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
            const hangupReason = reasoned?.hangupReason ?? (hangup ? "goodbye" : null);

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

            telemetry.recordModelUsage(callId, this.synthesizer.model ?? "tts", {
                stage: STAGES.TTS,
                audioMs: replyAudioMs,
                chars: response.length
            });

            this.onEvent?.({ type: "response", text: response });

            this.onAudio?.(result.audioBuffer, { hangup, hangupReason });

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
                this.onHangup?.({ afterMs: replyAudioMs ?? 4000, reason: hangupReason });
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

    static async createVoice({
        onEvent,
        onAudio,
        onHangup = null,
        onBargeIn = null,
        customer = null,
        callId = null,
        channel = "browser",
        transferContext = null,
        transfer = null
    }) {
        const framer = new AudioFramer(512);
        const vad = new VADInference();
        const endpointer = new Endpointer(SST_CONFIG);
        const utteranceBuffer = new UtteranceBuffer();
        const llm = INFERENCE_CONFIG.llm;
        const tts = INFERENCE_CONFIG.tts;
        const batchTranscriber = new BatchTranscriber({ url: INFERENCE_CONFIG.asr.url });
        const streamTranscriber = new StreamTranscriber(batchTranscriber);
        const synthesizer = createTts(tts);
        const runtime = new Runtime({
            url: llm.url,
            model: llm.model,
            fallbackModels: llm.fallbackModels,
            apiKey: llm.apiKey || "",
            extraHeaders: llm.extraHeaders,
            sendTools: llm.sendTools,
            timeoutMs: llm.timeoutMs,
            retryMax: llm.retryMax,
            temperature: llm.temperature,
            maxTokens: llm.maxTokens,
            frequencyPenalty: llm.frequencyPenalty,
            presencePenalty: llm.presencePenalty,
            localCompat: llm.localCompat,
            reasoningEffort: llm.reasoningEffort,
            provider: llm.provider
        });
        if (INFERENCE_CONFIG.mode === "provider" && !runtime.apiKey) {
            console.error(
                llm.provider === "openrouter"
                    ? "[LLM] No OpenRouter key. Set OPENROUTER_API_KEY or LLM_API_KEY before starting the server."
                    : "[LLM] No API key. Set GROQ_API_KEY or LLM_API_KEY before starting the server."
            );
        }
        const model = new Model({ runtime });
        const transferApi = transfer ?? defaultTransfers;
        const reasoner = new Reasoner({
            model,
            systemPrompt: buildSystemPrompt({
                customer,
                departments: transferApi.listDepartments()
            }),
            maxHistoryMessages: llm.maxHistoryMessages,
            tools: toolDefinitions(transferApi),
            executeTool: createToolExecutor({
                customer,
                callId,
                channel,
                transfer: transferApi
            }),
            maxToolRounds: llm.maxToolRounds,
            confirmation: ORDER_CONFIRMATION,
            customer,
            callId,
            transferContext
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
            onBargeIn: onBargeIn,
            callId: callId
        });

        await vad.init();
        if (tts.provider === "kokoro-local") {
            await initializeStrategy("en");
        }

        return { voice, synthesizer };
    };
};

function createTts(tts) {
    if (tts.provider === "sarvam") {
        const runtime = new SarvamRuntime({
            url: tts.url,
            model: tts.model,
            speaker: tts.speaker,
            language: tts.language,
            sampleRate: tts.sampleRate,
            apiKey: tts.apiKey || undefined
        });

        if (!runtime.apiKey) {
            console.error("[TTS] No Sarvam key. Hardcode it on SarvamRuntime like the Groq key on Runtime.");
        }

        return {
            provider: "sarvam",
            model: tts.model,
            synthesize: (text, options) => runtime.synthesize(text, options)
        };
    }

    return {
        provider: "kokoro-local",
        model: "Kokoro-82M-v1.0-ONNX",
        synthesize
    };
}