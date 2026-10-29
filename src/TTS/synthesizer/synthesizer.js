import { getStrategy } from "../strategy/index.js";

function toWavBuffer(audio) {
    const samples = audio.audio;
    const sampleRate = audio.sampling_rate;

    if (!samples || !sampleRate) {
        throw new Error("TTS returned an invalid audio object");
    }

    const pcmBytes = Buffer.alloc(samples.length * 2);

    for (let i = 0; i < samples.length; i++) {
        const sample = Math.max(-1, Math.min(1, samples[i]));

        pcmBytes.writeInt16LE(
            Math.round(sample < 0 ? sample * 32768 : sample * 32767),
            i * 2
        );
    }

    const header = Buffer.alloc(44);

    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcmBytes.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcmBytes.length, 40);

    return Buffer.concat([header, pcmBytes]);
}

export async function synthesize(text, options = {}) {
    const strategy = getStrategy(options.language ?? "en");

    const audio = await strategy.synthesize(text, {
        voice: options.voice,
    });

    return {
        language: strategy.language,
        audio,
        audioBuffer: toWavBuffer(audio),
    };
}