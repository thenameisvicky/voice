import "../env.js";
import { isFreeOpenRouterModel, resolveLlmConfig } from "../LLM/config.js";
import { KOKORO_TTS, SARVAM_TTS } from "../TTS/config.js";

const ASR_DEFAULT = "http://127.0.0.1:8080/v1/audio/transcriptions";

function envString(env, key, fallback = "") {
    const value = env[key];
    return value == null || value === "" ? fallback : String(value);
}

export function resolveInferenceMode(env = process.env) {
    const requested = envString(env, "INFERENCE_MODE", envString(env, "VOICE_INFERENCE", "provider")).toLowerCase();
    if (requested === "local" || requested === "provider") {
        return requested;
    }
    return "provider";
}

export function resolveInferenceConfig(env = process.env) {
    const mode = resolveInferenceMode(env);
    const llmEnv = mode === "local"
        ? { ...env, LLM_PROVIDER: "local" }
        : { ...env, LLM_PROVIDER: envString(env, "LLM_PROVIDER", "openrouter") };

    const llm = resolveLlmConfig(llmEnv);

    return {
        mode,
        llm,
        asr: {
            provider: "nemo-speech-local",
            url: envString(env, "ASR_URL", ASR_DEFAULT)
        },
        tts: mode === "local" ? { ...KOKORO_TTS } : { ...SARVAM_TTS }
    };
}

export function validateInferenceConfig(config = resolveInferenceConfig()) {
    const errors = [];

    if (config.llm.requestedProvider === "sarvam") {
        errors.push("Sarvam LLM was removed. Using OpenRouter. Set LLM_PROVIDER=openrouter or groq.");
    }

    if (config.mode === "provider" && config.llm.provider === "groq" && !config.llm.apiKey) {
        errors.push("INFERENCE_MODE=provider with Groq requires GROQ_API_KEY or LLM_API_KEY");
    }

    if (config.mode === "provider" && config.llm.provider === "openrouter" && !config.llm.apiKey) {
        errors.push("INFERENCE_MODE=provider with OpenRouter requires OPENROUTER_API_KEY or LLM_API_KEY");
    }

    if (config.mode === "provider" && config.llm.provider === "openrouter" && !isFreeOpenRouterModel(config.llm.model)) {
        errors.push("OPENROUTER_MODEL must be a free model (id ending in :free). Paid models are refused.");
    }

    const paidFallback = (config.llm.fallbackModels || []).find((id) => !isFreeOpenRouterModel(id));
    if (config.mode === "provider" && paidFallback) {
        errors.push(`OPENROUTER_FALLBACK_MODELS must be free models. Refusing "${paidFallback}".`);
    }

    if (config.mode === "local" && config.tts.provider !== "kokoro-local") {
        errors.push("INFERENCE_MODE=local must use Kokoro TTS, not a hosted provider");
    }

    if (config.mode === "local" && config.llm.provider !== "local") {
        errors.push("INFERENCE_MODE=local must use the local LLM, not a hosted provider");
    }

    return errors;
}

export function logInferenceConfig(config = resolveInferenceConfig()) {
    const errors = validateInferenceConfig(config);

    console.log(
        `[INFERENCE] mode=${config.mode} llm=${config.llm.provider}/${config.llm.model} ` +
        (config.llm.fallbackModels?.length ? `fallbacks=${config.llm.fallbackModels.join(",")} ` : "") +
        `asr=${config.asr.provider} tts=${config.tts.provider}/${config.tts.model} key=${config.llm.apiKey ? "set" : "none"}`
    );

    for (const error of errors) {
        console.error(`[INFERENCE] ${error}`);
    }

    return errors;
}

export const INFERENCE_CONFIG = resolveInferenceConfig();
