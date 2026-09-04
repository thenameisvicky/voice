class DebugAudioWorklet extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0];

        if (input.length > 0) {
            const channel = input[0]; // There is only one channel for now

            let peak = 0;
            let min = Infinity;
            let max = -Infinity;

            for (let i = 0; i < channel.length; i++) {
                const sample = channel[i];
                peak = Math.max(peak, Math.abs(sample));
                min = Math.min(min, sample);
                max = Math.max(max, sample);
            }

            console.log(`[AUDIO_WORKLET_PROCESSOR] Samples length: ${channel.length} | Peak: ${peak} | Min: ${min} | Max: ${max}`);
        }
        return true;
    }
}

registerProcessor("debug-audio", DebugAudioWorklet);