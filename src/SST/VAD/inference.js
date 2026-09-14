import * as onxRT from "onnxruntime-node";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class VADInference {
    constructor() {
        this.session = null;
        this.initialized = false;
        this.sampleRate = 16000;
        this.state = new Float32Array(2 * 1 * 128);
        this.previousContext = new Float32Array(64);
    }


    async init() {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const modelPath = path.join(
            __dirname,
            "silero_vad.onnx"
        )
        console.log(`[VAD] - Loading model from path: ${modelPath}...`);
        this.session = await onxRT.InferenceSession.create(
            modelPath,
            {
                executionProviders: ["cpu"]
            }
        )
        console.log("[VAD] Model loaded");
        this.reset();
        this.initialized = true;
    }

    normalize(audioFrame) {
        const audio = new Float32Array(audioFrame.length);

        for (let i = 0; i < audioFrame.length; i++) {
            audio[i] = audioFrame[i] / 32768;
        }

        return audio;
    }

    async process(audioFrame) {
        const normalizedAudioFrame = this.normalize(audioFrame);

        const audioWithContext = new Float32Array(64 + 512);
        audioWithContext.set(this.previousContext, 0);
        audioWithContext.set(normalizedAudioFrame, 64);

        const inputTensor = new onxRT.Tensor(
            "float32",
            audioWithContext,
            [1, audioWithContext.length]
        );

        const stateTensor = new onxRT.Tensor(
            "float32",
            this.state,
            [2, 1, 128]
        );

        const sampleRateTensor = new onxRT.Tensor(
            "int64",
            BigInt64Array.from([BigInt(this.sampleRate)]),
            []
        );

        const output = await this.session.run({
            input: inputTensor,
            state: stateTensor,
            sr: sampleRateTensor
        })

        const speechProbability = output.output.data[0];

        this.state = new Float32Array(output.stateN.data);
        this.previousContext = audioWithContext.slice(audioWithContext.length - 64);

        return {
            probability: speechProbability,
            frameSamples: audioFrame.length,
            sampleRate: this.sampleRate
        };
    }

    reset() {
        this.state = new Float32Array(2 * 1 * 128);
        this.previousContext = new Float32Array(64);
    }
}