import * as onxRT from "onnxruntime-node";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class VADInference {
    constructor() {
        this.session = null;
        this.initiated = false;
        this.sampleRate = 16000;
        this.state = new Float32Array(2 * 1 * 128);
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
        console.log(`[VAD] Inputs: ${this.session.inputNames}`);
        console.log(`[VAD] Outputs: ${this.session.outputNames}`);
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

        const inputTensor = new onxRT.Tensor(
            "float32",
            normalizedAudioFrame,
            [1, audioFrame.length]
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

        return speechProbability;
    }

    reset() {
        this.state = new Float32Array(2 * 1 * 128);
    }
}