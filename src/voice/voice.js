import { LLM_CONFIG, buildSystemPrompt } from "../LLM/config.js";
import { Model } from "../LLM/model/model.js";
import { Reasoner } from "../LLM/reasoner/reasoner.js";
import { TOOL_DEFINITIONS, ORDER_CONFIRMATION, createToolExecutor } from "../LLM/reasoner/agentTools.js";
import { Runtime } from "../LLM/runtime/runtime.js";
import { SST_CONFIG } from "../SST/config.js";
import { BatchTranscriber } from "../SST/transcriber/batch.js";
import { StreamTranscriber } from "../SST/transcriber/stream.js";
import { UtteranceBuffer } from "../SST/utterance/utteranceBuffer.js";
import { Endpointer } from "../SST/VAD/endpointer.js";
import { AudioFramer } from "../SST/VAD/framer.js";
import { VADInference } from "../SST/VAD/inference.js";
import { initializeStrategy } from "../TTS/strategy/index.js";
import { synthesize } from "../TTS/synthesizer/synthesizer.js";

export class Voice {
    constructor({ audioFramer, vad, endpointer, batchTranscriber, reasoner, synthesizer, onEvent, utteranceBuffer, streamTranscriber, onAudio }) {
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
    }

    async voice(audioChunk) {

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

            const speechChunk = this.utteranceBuffer.process({ event: event, frame: frame });

            if (speechChunk) {
                const transcript = await this.batchTranscriber.transcribe(speechChunk);
                if (!transcript?.trim()) continue;

                this.onEvent?.({
                    type: "transcript",
                    probability: voiceActivity.probability,
                    text: transcript,
                });

                const response = await this.reasoner.reason(transcript);
                if (typeof response !== "string" || !response.trim()) {
                    continue;
                }

                const result = await this.synthesizer.synthesize(response, {
                    language: "en",
                });

                this.onEvent?.({
                    type: "response",
                    text: response,
                });

                this.onAudio?.(result.audioBuffer);
            }
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

    static async createVoice({ onEvent, onAudio, customer = null, callId = null }) {
        const framer = new AudioFramer(512);
        const vad = new VADInference();
        const endpointer = new Endpointer(SST_CONFIG);
        const utteranceBuffer = new UtteranceBuffer();
        const batchTranscriber = new BatchTranscriber({ url: "http://127.0.0.1:8080/v1/audio/transcriptions" });
        const streamTranscriber = new StreamTranscriber(batchTranscriber);
        const synthesizer = { synthesize };
        const runtime = new Runtime({
            url: LLM_CONFIG.url,
            model: LLM_CONFIG.model,
            temperature: LLM_CONFIG.temperature,
            maxTokens: LLM_CONFIG.maxTokens,
            frequencyPenalty: LLM_CONFIG.frequencyPenalty,
            presencePenalty: LLM_CONFIG.presencePenalty
        });
        const model = new Model({ runtime });
        const reasoner = new Reasoner({
            model,
            systemPrompt: buildSystemPrompt({ customer }),
            maxHistoryMessages: LLM_CONFIG.maxHistoryMessages,
            tools: TOOL_DEFINITIONS,
            executeTool: createToolExecutor({ customer }),
            maxToolRounds: LLM_CONFIG.maxToolRounds,
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
            onAudio: onAudio
        });

        await vad.init();
        await initializeStrategy("en");

        return { voice, synthesizer };
    };
};