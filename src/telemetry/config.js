export const STAGES = {
    ASR: "asr",
    LLM: "llm",
    TOOL: "tool",
    TTS: "tts",
    VAD: "vad",
    TURN: "turn"
};

export const INFERENCE_STAGES = [STAGES.ASR, STAGES.LLM, STAGES.TTS];

export const STAGE_ORDER = [STAGES.ASR, STAGES.LLM, STAGES.TOOL, STAGES.TTS];

export const QUEUE_SOURCES = {
    MEDIA: "media",
    LLM_SERVER: "llm_server"
};

export const TELEMETRY_CONFIG = {
    outputDir: new URL("../../telemetry/", import.meta.url).pathname,
    sampleIntervalMs: 500,
    baselineDurationMs: 1500,
    maxRetainedCalls: 200
};

export const SLO_TARGETS = {
    p50LatencyMs: 1200,
    p95LatencyMs: 2500,
    maxQueueWaitP95Ms: 400,
    maxErrorRatePct: 2,
    minCompletionRatePct: 90,
    maxCpuUtilizationPct: 85,
    maxMemoryUtilizationPct: 85
};

export const BENCHMARK_LEVELS = [1, 4, 8];

export const BENCHMARK_METRICS = [
    ["CPU utilization", "Compute saturation"],
    ["RAM consumption", "Memory pressure"],
    ["GPU utilization", "Accelerator pressure, when there is one"],
    ["p50 turn latency", "Typical response"],
    ["p95 turn latency", "Slow-response experience"],
    ["Successful calls/min", "Actual throughput"],
    ["Error rate", "Reliability"],
    ["Cost per completed call", "Unit economics"]
];

export const MODEL_INVENTORY = [
    {
        stage: STAGES.ASR,
        name: "Nemotron ASR (nemo-speech.cpp)",
        path: null,
        fallbackBytes: 650 * 1024 * 1024
    },
    {
        stage: STAGES.LLM,
        name: "Qwen3-0.6B Q8_0 (llama.cpp)",
        path: new URL("../../models/Qwen3-0.6B-Q8_0.gguf", import.meta.url).pathname,
        fallbackBytes: 608 * 1024 * 1024
    },
    {
        stage: STAGES.TTS,
        name: "Kokoro-82M v1.0 ONNX q8",
        path: new URL("../../models/Kokoro-82M-v1.0-ONNX", import.meta.url).pathname,
        fallbackBytes: 86 * 1024 * 1024
    },
    {
        stage: STAGES.VAD,
        name: "Silero VAD ONNX",
        path: new URL("../SST/VAD/silero_vad.onnx", import.meta.url).pathname,
        fallbackBytes: 2 * 1024 * 1024
    }
];

export const COST_MODEL = {
    currency: "INR",
    currencySymbol: "₹",
    hardwareCapex: 55000,
    hardwareLifetimeMonths: 36,
    availableHoursPerMonth: 730,
    machineWatts: 45,
    idleWatts: 12,
    electricityPerKwh: 8.5,
    telephonyPerMinute: 0.6,
    cloudPerVcpuHour: 1.6,
    managedVoiceAiPerMinute: 6.0,
    utilizationTarget: 0.7,
    memoryTarget: 0.8,
    diskHeadroom: 2.5
};
