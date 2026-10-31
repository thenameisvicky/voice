import { parsePaise } from "./money.js";

export const COST_CALCULATION_VERSION = 1;

const ROUNDING = new Set(["ceil", "floor", "nearest"]);

function envString(env, key, fallback = "") {
    const value = env[key];
    return value == null || value === "" ? fallback : String(value);
}

function envInteger(env, key, fallback = null) {
    const raw = env[key];
    if (raw == null || raw === "") return fallback;
    const value = Number(raw);
    return Number.isInteger(value) ? value : fallback;
}

function envPaise(env, key) {
    return parsePaise(env[key]);
}

function roundingOf(value) {
    const rounding = String(value || "ceil").toLowerCase();
    return ROUNDING.has(rounding) ? rounding : "ceil";
}

export function resolveExotelTariff(env = process.env) {
    const inboundPaisePerMinute = envPaise(env, "EXOTEL_TARIFF_INBOUND_PAISE_PER_MINUTE");
    const outboundPaisePerMinute = envPaise(env, "EXOTEL_TARIFF_OUTBOUND_PAISE_PER_MINUTE");
    const incrementSeconds = envInteger(env, "EXOTEL_TARIFF_INCREMENT_SECONDS", 60);
    const configured = inboundPaisePerMinute != null || outboundPaisePerMinute != null;

    return {
        configured,
        currency: envString(env, "EXOTEL_TARIFF_CURRENCY", "INR"),
        inboundPaisePerMinute,
        outboundPaisePerMinute,
        incrementSeconds: incrementSeconds > 0 ? incrementSeconds : 60,
        rounding: roundingOf(envString(env, "EXOTEL_TARIFF_ROUNDING", "ceil")),
        version: envString(env, "EXOTEL_TARIFF_VERSION", String(COST_CALCULATION_VERSION))
    };
}

export function resolveInferenceRates(env = process.env) {
    return {
        asrPaisePerAudioMinute: envPaise(env, "INFERENCE_ASR_PAISE_PER_AUDIO_MINUTE"),
        llmPaisePer1kTokens: envPaise(env, "INFERENCE_LLM_PAISE_PER_1K_TOKENS"),
        ttsPaisePerAudioMinute: envPaise(env, "INFERENCE_TTS_PAISE_PER_AUDIO_MINUTE"),
        version: envString(env, "INFERENCE_COST_VERSION", String(COST_CALCULATION_VERSION))
    };
}

export function resolveExotelApiConfig(env = process.env) {
    const accountSid = envString(env, "EXOTEL_ACCOUNT_SID");
    const apiKey = envString(env, "EXOTEL_API_KEY");
    const apiToken = envString(env, "EXOTEL_API_TOKEN");
    const baseUrl = envString(env, "EXOTEL_API_BASE_URL").replace(/\/+$/, "");

    return {
        enabled: Boolean(accountSid && apiKey && apiToken && baseUrl),
        accountSid,
        apiKey,
        apiToken,
        baseUrl
    };
}

export function rateForDirection(tariff, direction) {
    if (direction === "outbound") return tariff.outboundPaisePerMinute;
    if (direction === "inbound") return tariff.inboundPaisePerMinute;
    return tariff.inboundPaisePerMinute ?? tariff.outboundPaisePerMinute;
}

export function snapshotTariff(tariff) {
    if (!tariff?.configured) return null;

    return {
        currency: tariff.currency,
        inboundPaisePerMinute: tariff.inboundPaisePerMinute,
        outboundPaisePerMinute: tariff.outboundPaisePerMinute,
        incrementSeconds: tariff.incrementSeconds,
        rounding: tariff.rounding,
        version: tariff.version
    };
}
