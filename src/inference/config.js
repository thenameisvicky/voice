import { resolveLlmConfig } from "../LLM/config.js";

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
        : { ...env, LLM_PROVIDER: envString(env, "LLM_PROVIDER", "groq") };

    const llm = resolveLlmConfig(llmEnv);

    return {
        mode,
        llm,
        asr: {
            provider: "nemo-speech-local",
            url: envString(env, "ASR_URL", ASR_DEFAULT)
        },
        tts: {
            provider: "kokoro-local"
        }
    };
}

export function validateInferenceConfig(config = resolveInferenceConfig()) {
    const errors = [];

    if (config.mode === "provider" && !config.llm.apiKey) {
        errors.push("INFERENCE_MODE=provider requires GROQ_API_KEY or LLM_API_KEY");
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
        `asr=${config.asr.provider} tts=${config.tts.provider} key=${config.llm.apiKey ? "set" : "none"}`
    );

    for (const error of errors) {
        console.error(`[INFERENCE] ${error}`);
    }

    return errors;
}

export const INFERENCE_CONFIG = resolveInferenceConfig();
