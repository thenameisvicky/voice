// tts/strategy/english.js

import { KokoroTTS } from "kokoro-js";
import { env } from "@huggingface/transformers";
import { TTS_CONFIG } from "../config.js";

const config = TTS_CONFIG.models.en;

env.localModelPath = TTS_CONFIG.modelsDir;
env.allowLocalModels = true;
env.allowRemoteModels = false;

let modelPromise = null;

async function initialize() {
    if (!modelPromise) {
        modelPromise = KokoroTTS.from_pretrained(config.id, {
            dtype: config.dtype,
        }).catch((error) => {
            modelPromise = null;
            throw error;
        });
    }

    return modelPromise;
}

async function synthesize(text, options = {}) {
    if (typeof text !== "string" || !text.trim()) {
        throw new TypeError("TTS text must be a non-empty string.");
    }

    const model = await initialize();

    return model.generate(text, {
        voice: options.voice ?? config.voice,
    });
}

export const englishStrategy = {
    language: "en",
    initialize,
    synthesize,
};