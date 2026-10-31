import assert from "node:assert/strict";
import { test } from "node:test";

import { Voice } from "../src/voice/voice.js";
import { Endpointer } from "../src/SST/VAD/endpointer.js";
import { SST_CONFIG } from "../src/SST/config.js";

const FRAME = 512; // 32 ms at 16 kHz

function voiceWith(probabilities, onBargeIn) {
    let i = 0;
    return new Voice({
        audioFramer: { process: () => [new Int16Array(FRAME)] },
        vad: { process: async () => ({ probability: probabilities[i++] ?? 0, frameSamples: FRAME }) },
        endpointer: new Endpointer(SST_CONFIG),
        utteranceBuffer: { process: () => null },
        onBargeIn,
        callId: null
    });
}

async function feed(voice, frames) {
    for (let n = 0; n < frames; n++) await voice.voice(Buffer.alloc(FRAME * 2));
}

test("barges in once after sustained speech", async () => {
    let fired = 0;
    const voice = voiceWith(Array(40).fill(0.9), () => fired++);
    await feed(voice, 40);
    assert.equal(fired, 1);
});

test("a short blip does not barge in", async () => {
    let fired = 0;
    const blip = [...Array(6).fill(0.9), ...Array(20).fill(0)];
    const voice = voiceWith(blip, () => fired++);
    await feed(voice, blip.length);
    assert.equal(fired, 0);
});

test("fires again for the next utterance after silence", async () => {
    let fired = 0;
    const two = [...Array(20).fill(0.9), ...Array(15).fill(0), ...Array(20).fill(0.9)];
    const voice = voiceWith(two, () => fired++);
    await feed(voice, two.length);
    assert.equal(fired, 2);
});

test("no callback, no tracking", async () => {
    const voice = voiceWith(Array(40).fill(0.9), null);
    await feed(voice, 40);
    assert.equal(voice.bargedIn, false);
});
