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