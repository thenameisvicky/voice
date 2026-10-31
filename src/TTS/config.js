export const KOKORO_TTS = {
    provider: "kokoro-local",
    model: "Kokoro-82M-v1.0-ONNX"
};

export const SARVAM_TTS = {
    provider: "sarvam",
    url: "https://api.sarvam.ai/text-to-speech",
    model: "bulbul:v3",
    speaker: "priya",
    language: "en-IN",
    sampleRate: 22050
};

export const TTS_CONFIG = {
    defaultLanguage: "en",
    modelsDir: new URL("../../models/", import.meta.url).pathname,
    models: {
        en: {
            id: "Kokoro-82M-v1.0-ONNX",
            voice: "af_heart",
            dtype: "q8",
        },
        hi: {
            id: null,
            voice: null,
            dtype: "q8"
        },
        tn: {
            id: null,
            voice: null,
            dtype: "q8"
        }
    }
}