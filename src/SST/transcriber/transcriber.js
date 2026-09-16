import fs from "node:fs";
export class Transcriber {
    constructor({ url }) {
        this.url = url;
    }

    async transcribe(speech) {
        const durationMs =
            speech.length / 16000 * 1000;

        console.log(
            `[VOICE][TRANSCRIBER] - ${speech.length} samples (${(durationMs / 1000).toFixed(2)}s)`
        );

        const wavBuffer = this.createWav(speech);

        const form = new FormData();

        form.append(
            "file",
            new Blob([wavBuffer], { type: "audio/wav" }),
            "speech.wav"
        );

        form.append("response_format", "json");

        const response = await fetch(this.url, {
            method: "POST",
            body: form
        });

        if (!response.ok) {
            const errorText = await response.text();

            console.error(
                "[VOICE][TRANSCRIBER] Whisper response:",
                response.status,
                errorText
            );

            throw new Error(
                `Whisper HTTP ${response.status}: ${errorText}`
            );
        }

        const result = await response.json();

        return result.text?.trim() ?? "";
    }

    createWav(samples) {
        const sampleRate = 16000;
        const channels = 1;
        const bitsPerSample = 16;

        const dataSize =
            samples.length * 2;

        const buffer = Buffer.alloc(
            44 + dataSize
        );

        buffer.write("RIFF", 0);
        buffer.writeUInt32LE(
            36 + dataSize,
            4
        );
        buffer.write("WAVE", 8);

        buffer.write("fmt ", 12);
        buffer.writeUInt32LE(16, 16);
        buffer.writeUInt16LE(1, 20);
        buffer.writeUInt16LE(
            channels,
            22
        );
        buffer.writeUInt32LE(
            sampleRate,
            24
        );

        const byteRate =
            sampleRate *
            channels *
            bitsPerSample / 8;

        buffer.writeUInt32LE(
            byteRate,
            28
        );

        const blockAlign =
            channels *
            bitsPerSample / 8;

        buffer.writeUInt16LE(
            blockAlign,
            32
        );

        buffer.writeUInt16LE(
            bitsPerSample,
            34
        );

        buffer.write("data", 36);
        buffer.writeUInt32LE(
            dataSize,
            40
        );

        for (let i = 0; i < samples.length; i++) {
            buffer.writeInt16LE(
                samples[i],
                44 + i * 2
            );
        }

        return buffer;
    }
}