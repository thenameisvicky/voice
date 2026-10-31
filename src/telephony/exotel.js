import { Voice } from "../voice/voice.js";
import { lookupCustomer } from "../LLM/reasoner/agentTools.js";
import { INFERENCE_CONFIG } from "../inference/config.js";
import telemetry from "../telemetry/telemetry.js";
import { QUEUE_SOURCES, STAGES } from "../telemetry/config.js";
import { transfers } from "./callTransfer.js";
import { broadcast } from "./liveFeed.js";

export function wavToPcm16(wav) {
    if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
        throw new Error("Not a WAV buffer");
    }

    let sampleRate = null;
    let offset = 12;

    while (offset + 8 <= wav.length) {
        const id = wav.toString("ascii", offset, offset + 4);
        const size = wav.readUInt32LE(offset + 4);
        const body = offset + 8;

        if (id === "fmt ") {
            const format = wav.readUInt16LE(body);
            const channels = wav.readUInt16LE(body + 2);
            const bits = wav.readUInt16LE(body + 14);

            if (format !== 1 || channels !== 1 || bits !== 16) {
                throw new Error(`Unsupported WAV: format=${format} channels=${channels} bits=${bits}`);
            }

            sampleRate = wav.readUInt32LE(body + 4);
        }

        if (id === "data") {
            if (!sampleRate) throw new Error("WAV data before fmt chunk");

            const samples = new Int16Array(size / 2);
            for (let i = 0; i < samples.length; i++) {
                samples[i] = wav.readInt16LE(body + i * 2);
            }
            return { samples, sampleRate };
        }

        offset = body + size + (size % 2);
    }

    throw new Error("WAV has no data chunk");
}

export function resample(samples, inRate, outRate) {
    if (inRate === outRate) return samples;

    let input = samples;

    if (outRate < inRate) {
        input = lowPass(samples, (0.45 * outRate) / inRate, 63);
    }

    const ratio = inRate / outRate;
    const output = new Int16Array(Math.floor(input.length / ratio));

    for (let i = 0; i < output.length; i++) {
        const position = i * ratio;
        const index = Math.floor(position);
        const fraction = position - index;
        const a = input[index];
        const b = input[index + 1] ?? a;
        output[i] = Math.round(a + (b - a) * fraction);
    }

    return output;
}

function lowPass(samples, cutoff, taps) {
    const half = (taps - 1) / 2;
    const kernel = new Float32Array(taps);
    let sum = 0;

    for (let n = 0; n < taps; n++) {
        const x = n - half;
        const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
        const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (taps - 1));
        kernel[n] = sinc * hamming;
        sum += kernel[n];
    }

    const output = new Int16Array(samples.length);

    for (let i = 0; i < samples.length; i++) {
        let acc = 0;
        for (let k = 0; k < taps; k++) {
            const j = i + k - half;
            if (j >= 0 && j < samples.length) acc += samples[j] * kernel[k];
        }
        output[i] = Math.max(-32768, Math.min(32767, Math.round(acc / sum)));
    }

    return output;
}

export function toBase64Chunks(samples, chunkBytes) {
    const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    const chunks = [];

    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
        const chunk = Buffer.alloc(chunkBytes);
        bytes.copy(chunk, 0, offset, Math.min(offset + chunkBytes, bytes.length));
        chunks.push(chunk.toString("base64"));
    }

    return chunks;
}

export function base64ToPcm16(payload) {
    const bytes = Buffer.from(payload, "base64");
    const samples = new Int16Array(Math.floor(bytes.length / 2));
    for (let i = 0; i < samples.length; i++) {
        samples[i] = bytes.readInt16LE(i * 2);
    }
    return samples;
}

export function handleExotelConnection(ws) {
    let streamSid = null;
    let sampleRate = 8000;
    let voiceReady = null;
    let turn = 0;
    let callId = null;

    let hangingUp = false;
    let hangupTimer = null;

    let queue = Promise.resolve();

    const pendingMarks = new Set();
    let playbackStartedAt = 0;
    let chunkReceivedAt = 0;

    const send = (message) => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify(message));
    };

    const hangup = () => {
        if (hangingUp && ws.readyState !== ws.OPEN) return;
        hangingUp = true;
        if (hangupTimer) clearTimeout(hangupTimer);
        hangupTimer = null;
        console.log("[EXOTEL] Hanging up");
        if (ws.readyState === ws.OPEN) ws.close();
    };

    const sendAudio = (wav, { hangupAfter } = {}) => {
        const { samples, sampleRate: wavRate } = wavToPcm16(wav);
        const pcm = resample(samples, wavRate, sampleRate);

        for (const payload of toBase64Chunks(pcm, 3200)) {
            send({ event: "media", stream_sid: streamSid, media: { payload } });
        }

        turn += 1;
        const markName = hangupAfter ? "hangup" : `turn-${turn}-end`;
        send({ event: "mark", stream_sid: streamSid, mark: { name: markName } });
        if (pendingMarks.size === 0) playbackStartedAt = Date.now();
        pendingMarks.add(markName);

        console.log(`[EXOTEL] Sent ${(pcm.length / sampleRate).toFixed(2)}s audio (turn ${turn}${hangupAfter ? ", then hangup" : ""})`);
    };

    // Caller talked over Yuga: drop the audio Exotel still has buffered. Goodbye and transfer audio is never cut.
    // Speech queued from before this reply started does not count, or a backlog would cut the fresh reply.
    const bargeIn = () => {
        if (hangingUp || pendingMarks.size === 0) return;
        if (chunkReceivedAt < playbackStartedAt) return;
        pendingMarks.clear();
        send({ event: "clear", stream_sid: streamSid });
        console.log("[EXOTEL] Caller interrupted, playback cleared");
    };

    const start = async ({ callSid, from, to, accountSid }) => {
        const customer = await lookupCustomer(from).catch((error) => {
            console.error("[EXOTEL] Customer lookup failed:", error);
            return null;
        });

        console.log(`[EXOTEL] Customer: ${customer
            ? `${customer.name || "unnamed"} (${customer.id})${customer.created ? " [created]" : ""}`
            : "not verified"}`);

        telemetry.startTrace(callId, {
            channel: "exotel",
            from,
            to,
            streamSid,
            sampleRate,
            direction: "inbound",
            exotelCallSid: callSid,
            accountSid,
            customer: customer?.name ?? null,
            customerId: customer?.id ?? null,
            inferenceMode: INFERENCE_CONFIG.mode,
            llmProvider: INFERENCE_CONFIG.llm.provider,
            asrProvider: INFERENCE_CONFIG.asr.provider,
            ttsProvider: INFERENCE_CONFIG.tts.provider
        });

        const transferContext = transfers.onVoicebotStart(callSid);
        const pipeline = await Voice.createVoice({
            onEvent: (event) => {
                if (event.type === "transcript" || event.type === "response") {
                    console.log(`[EXOTEL][${event.type.toUpperCase()}] - ${event.text}`);
                    broadcast({ callId, event: event.type, text: event.text });
                }
            },
            onAudio: (wav, { hangup: hangupAfter } = {}) => sendAudio(wav, { hangupAfter }),
            onBargeIn: bargeIn,
            onHangup: ({ afterMs } = {}) => {
                hangingUp = true;
                const waitMs = Math.max(2500, (afterMs ?? 4000) + 800);
                hangupTimer = setTimeout(hangup, waitMs);
            },
            customer,
            callId: callSid,
            channel: "exotel",
            transferContext
        });

        const greetingText = transferContext?.speakOnReturn
            || (customer?.name
                ? `Hello ${customer.name}, this is Yuga. How can I help you today?`
                : "Hello, this is Yuga. How can I help you today?");

        telemetry.startSpan(callId, STAGES.TTS, { chars: greetingText.length, greeting: true });
        const greeting = await pipeline.synthesizer.synthesize(greetingText, { language: "en" });
        telemetry.endSpan(callId, STAGES.TTS, {
            ok: true,
            chars: greetingText.length,
            audioMs: greeting.audio?.sampling_rate
                ? (greeting.audio.audio.length / greeting.audio.sampling_rate) * 1000
                : null
        });

        sendAudio(greeting.audioBuffer);
        broadcast({ callId, event: "start" });
        broadcast({ callId, event: "response", text: greetingText });

        return pipeline.voice;
    };

    ws.on("message", (data, isBinary) => {
        if (isBinary) return;

        let message;
        try {
            message = JSON.parse(data.toString());
        } catch {
            console.error("[EXOTEL] Non-JSON message ignored");
            return;
        }

        switch (message.event) {
            case "connected":
                console.log("[EXOTEL] Connected");
                break;

            case "start": {
                streamSid = message.stream_sid ?? message.start?.stream_sid;
                sampleRate = Number(message.start?.media_format?.sample_rate) || 8000;
                callId = message.start?.call_sid ?? `exotel-${streamSid ?? Date.now()}`;

                console.log(
                    `[EXOTEL] Call ${message.start?.call_sid} from ${message.start?.from} ` +
                    `(${sampleRate} Hz, stream ${streamSid})`
                );

                voiceReady = start({
                    callSid: callId,
                    from: message.start?.from,
                    to: message.start?.to ?? null,
                    accountSid: message.start?.account_sid ?? null
                });
                voiceReady.catch((error) => {
                    console.error("[EXOTEL] Pipeline init failed:", error);
                    ws.close();
                });
                break;
            }

            case "media": {
                if (hangingUp || !voiceReady || !message.media?.payload) break;

                const payload = message.media.payload;
                const enqueuedAt = Date.now();

                queue = queue
                    .then(async () => {
                        telemetry.recordQueueWait(
                            callId,
                            QUEUE_SOURCES.MEDIA,
                            Date.now() - enqueuedAt
                        );

                        const voice = await voiceReady;
                        chunkReceivedAt = enqueuedAt;
                        const pcm = resample(base64ToPcm16(payload), sampleRate, 16000);
                        await voice.voice(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
                    })
                    .catch((error) => {
                        console.error("[EXOTEL] Voice error:", error);
                        telemetry.recordError(callId, "pipeline", error);
                    });
                break;
            }

            case "mark":
                pendingMarks.delete(message.mark?.name);
                console.log(`[EXOTEL] Played ${message.mark?.name}`);
                if (message.mark?.name === "hangup") hangup();
                break;

            case "dtmf":
                console.log(`[EXOTEL] DTMF ${message.dtmf?.digit}`);
                break;

            case "stop":
                console.log(`[EXOTEL] Stop (${message.stop?.reason})`);
                if (callId && !transfers.shouldKeepTrace(callId) && !transfers.isInProgress(callId)) {
                    telemetry.applyTelephonyUpdate(callId, {
                        callSid: callId,
                        status: message.stop?.reason || "completed",
                        endedAt: Date.now(),
                        source: "exotel-stream-stop"
                    });
                }
                ws.close();
                break;
        }
    });

    const finish = () => {
        if (hangupTimer) {
            clearTimeout(hangupTimer);
            hangupTimer = null;
        }
        if (!callId) return;
        if (transfers.shouldKeepTrace(callId)) {
            console.log(`[EXOTEL] Keeping telemetry open for transfer ${callId}`);
            return;
        }
        telemetry.endTrace(callId);
        callId = null;
    };

    ws.on("close", () => {
        console.log("[EXOTEL] Disconnected");
        if (callId) broadcast({ callId, event: "end" });
        finish();
    });

    ws.on("error", (error) => {
        console.error("[EXOTEL] WS error:", error);
        if (callId) telemetry.recordError(callId, "transport", error);
    });
}
