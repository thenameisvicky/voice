export const LLM_CONFIG = {
    url: "http://127.0.0.1:8081/v1/chat/completions",
    model: "Qwen3-0.6B",
    systemPrompt:
        "You are Yuga, a helpful voice assistant. Keep responses concise and natural for speech",
    temperature: 0.7,
    maxTokens: 128
};