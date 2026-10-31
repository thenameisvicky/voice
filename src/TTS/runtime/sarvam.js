import "../../env.js";
import { SARVAM_TTS } from "../config.js";
import { toWavBuffer } from "../synthesizer/synthesizer.js";

const MAX_CHARS = 500;

const LANGUAGE_CODES = {
    en: "en-IN",
    hi: "hi-IN",
    ta: "ta-IN",
    te: "te-IN",
    kn: "kn-IN",
    ml: "ml-IN",
    mr: "mr-IN",
    bn: "bn-IN",
    gu: "gu-IN",
    pa: "pa-IN",
    od: "od-IN",
    or: "od-IN"
};

function sarvamLanguage(code) {
    const value = String(code || "en-IN");
    if (value.includes("-")) return value;
    return LANGUAGE_CODES[value.toLowerCase()] ?? "en-IN";
}

export class SarvamTtsError extends Error {
    constructor(message, { status = 0 } = {}) {
        super(message);
        this.name = "SarvamTtsError";
        this.status = status;
    }
}

function chunkText(text, max = MAX_CHARS) {
    const source = String(text || "").trim();
    if (source.length <= max) return [source];

    const parts = [];
    let remaining = source;

    while (remaining.length > max) {
        let cut = remaining.lastIndexOf(". ", max);
        if (cut < max * 0.4) cut = remaining.lastIndexOf(" ", max);
        if (cut < 1) cut = max;
        parts.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
    }

    if (remaining) parts.push(remaining);
    return parts;
}

function decodeWav(wav) {
    if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
        return null;
    }

    let sampleRate = null;
    let offset = 12;

    while (offset + 8 <= wav.length) {
        const id = wav.toString("ascii", offset, offset + 4);
        const size = wav.readUInt32LE(offset + 4);
        const body = offset + 8;

        if (id === "fmt ") {
            sampleRate = wav.readUInt32LE(body + 4);
        }

        if (id === "data") {
            if (!sampleRate) return null;
            const samples = new Float32Array(size / 2);
            for (let i = 0; i < samples.length; i++) {
                samples[i] = wav.readInt16LE(body + i * 2) / 32768;
            }
            return { audio: samples, sampling_rate: sampleRate };
        }

        offset = body + size + (size % 2);
    }

    return null;
}

function concatAudio(chunks) {
    if (chunks.length === 1) return chunks[0];

    const sampleRate = chunks[0].sampling_rate;
    const length = chunks.reduce((total, chunk) => total + chunk.audio.length, 0);
    const audio = new Float32Array(length);
    let offset = 0;

    for (const chunk of chunks) {
        if (chunk.sampling_rate !== sampleRate) {
            throw new SarvamTtsError("Sarvam returned mixed sample rates");
        }
        audio.set(chunk.audio, offset);
        offset += chunk.audio.length;
    }

    return { audio, sampling_rate: sampleRate };
}

export const SARVAM_API_KEY = process.env.SARVAM_API_KEY || "";

export class SarvamRuntime {
    constructor({
        url = SARVAM_TTS.url,
        model = SARVAM_TTS.model,
        speaker = SARVAM_TTS.speaker,
        language = SARVAM_TTS.language,
        sampleRate = SARVAM_TTS.sampleRate,
        apiKey = process.env.SARVAM_API_KEY || "",
        timeoutMs = 30000,
        fetchImpl = fetch
    } = {}) {
        this.url = url;
        this.model = model;
        this.speaker = speaker;
        this.language = language;
        this.sampleRate = sampleRate;
        this.apiKey = apiKey;
        this.timeoutMs = timeoutMs;
        this.fetchImpl = fetchImpl;
    }

    async synthesize(text, options = {}) {
        if (typeof text !== "string" || !text.trim()) {
            throw new TypeError("TTS text must be a non-empty string.");
        }

        if (!this.apiKey) {
            throw new SarvamTtsError("Sarvam API key is missing. Hardcode it on SarvamRuntime like Groq.");
        }

        const pieces = [];
        for (const part of chunkText(text)) {
            pieces.push(await this.requestOnce(part, options));
        }

        const audio = concatAudio(pieces);

        return {
            language: options.language ?? this.language,
            audio,
            audioBuffer: toWavBuffer(audio)
        };
    }

    async requestOnce(text, options) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        let response;

        try {
            response = await this.fetchImpl(this.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "api-subscription-key": this.apiKey
                },
                body: JSON.stringify({
                    text,
                    target_language_code: sarvamLanguage(options.language ?? this.language),
                    speaker: options.voice ?? this.speaker,
                    model: this.model,
                    speech_sample_rate: this.sampleRate,
                    pace: 1,
                    enable_preprocessing: true
                }),
                signal: controller.signal
            });
        } catch (error) {
            const timedOut = error?.name === "AbortError";
            throw new SarvamTtsError(
                timedOut
                    ? `Sarvam TTS timed out after ${this.timeoutMs}ms`
                    : `Sarvam TTS network error: ${error?.message ?? error}`,
                { status: timedOut ? 408 : 0 }
            );
        } finally {
            clearTimeout(timer);
        }

        const bodyText = await response.text();

        if (!response.ok) {
            const error = new SarvamTtsError(
                `Sarvam TTS error ${response.status}: ${bodyText.slice(0, 400)}`,
                { status: response.status }
            );
            console.error(`[TTS] ${error.message}`);
            throw error;
        }

        let data;
        try {
            data = JSON.parse(bodyText);
        } catch {
            throw new SarvamTtsError("Sarvam TTS returned non-JSON audio");
        }

        const encoded = Array.isArray(data.audios) ? data.audios[0] : data.audio;
        if (!encoded) {
            throw new SarvamTtsError("Sarvam TTS response had no audio");
        }

        const bytes = Buffer.from(encoded, "base64");
        const wav = decodeWav(bytes);
        if (wav) return wav;

        const samples = new Float32Array(Math.floor(bytes.length / 2));
        for (let i = 0; i < samples.length; i++) {
            samples[i] = bytes.readInt16LE(i * 2) / 32768;
        }

        return { audio: samples, sampling_rate: this.sampleRate };
    }
}
