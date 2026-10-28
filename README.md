# Kural

![Node.js](https://img.shields.io/badge/Node.js-18+-green)
![Web Audio](https://img.shields.io/badge/Web%20Audio-AudioWorklet-orange)
![WebSocket](https://img.shields.io/badge/WebSocket-ws-black)
![ONNX Runtime](https://img.shields.io/badge/Runtime-ONNX%20Runtime-purple)
![Silero VAD](https://img.shields.io/badge/VAD-Silero-blue)
![NeMo-Speech.cpp](https://img.shields.io/badge/ASR-NeMo--Speech.cpp-76B900)
![Nemotron](https://img.shields.io/badge/ASR%20Model-Nemotron%20Speech%200.6B-76B900)
![llama.cpp](https://img.shields.io/badge/LLM-llama.cpp-lightgrey)
![Qwen3](https://img.shields.io/badge/LLM%20Model-Qwen3--0.6B-blueviolet)

Real-time voice pipeline: browser mic → VAD → endpointing → ASR → LLM. Each stage is hand-written in Node.js; all inference runs locally. No voice/agent frameworks, no hosted APIs.

## Pipeline

```text
Browser mic
  → AudioWorklet         resample to 16 kHz mono PCM16, 2048-sample chunks
  → WebSocket            binary frames
  → AudioFramer          512-sample frames (32 ms)
  → Silero VAD (ONNX)    speech probability per frame, 64-sample context carried over
  → Endpointer           START / END state machine
  → UtteranceBuffer      200 ms pre-roll + speech until END
  → NeMo-Speech.cpp      WAV over HTTP (/v1/audio/transcriptions) → transcript
  → llama.cpp            OpenAI-compatible chat completion, conversation history kept
  → WebSocket            VAD + response text to UI
```

Output today is text only. TTS is the next stage (see [Next: TTS](#next-tts)).

## Endpointing

| Parameter            | Value  |
| -------------------- | ------ |
| Start threshold      | 0.5    |
| End threshold        | 0.3    |
| Min speech duration  | 100 ms |
| Min silence duration | 300 ms |
| Pre-speech buffer    | 200 ms |

Hysteresis (separate start/end thresholds) prevents flapping at the boundary. Config: `src/SST/config.js`.

## Transcription

- **Batch** (live path): full utterance sent to the ASR server on END, one request per utterance.
- **Streaming ASR** (in development, not working): pseudo-streaming prototype in `src/SST/transcriber/stream.js` and `Voice.streamingVoice()`. 500 ms window, 300 ms hop, re-decode on END. Not called from `server.js`.

## WebSocket protocol

- Client → server: binary, raw PCM16 / 16 kHz / mono.
- Server → client: JSON text frames.

```json
{ "type": "voice_event", "event": "vad", "probability": 0.92 }
{ "type": "voice_event", "event": "transcript", "probability": 0.12, "text": "<LLM response>" }
```

`vad` drives the waveform. `transcript` carries the LLM reply (not the user's transcript) and is rendered as text. The client has no audio playback path.

## Services

| Process                   | Port | Model                                         |
| ------------------------- | ---- | --------------------------------------------- |
| Node server               | 3000 | Silero VAD (ONNX, CPU)                        |
| NeMo-Speech.cpp (`serve`) | 8080 | `nemotron-speech-streaming-en-0.6b` (Q8_0)    |
| llama-server              | 8081 | `Qwen3-0.6B-Q8_0.gguf`                        |

## Layout

```text
server.js                     HTTP + WebSocket, per-connection pipeline
views/                        UI + AudioWorklet
src/SST/VAD/                  framer, Silero inference, endpointer
src/SST/utterance/            pre-roll + utterance assembly
src/SST/transcriber/          batch ASR client (live), streaming prototype (dev)
src/LLM/                      runtime (HTTP) → model → reasoner (history + system prompt)
src/SST/synthesizer/          TTS (empty stub, next)
src/telementry/               latency markers (fields only, not recorded)
landing/                      static site, deployed to GitHub Pages
```

## Run

Requires Node.js 18+, NeMo-Speech.cpp, built `llama.cpp`, and model files (not tracked):

```text
src/SST/VAD/silero_vad.onnx
models/Qwen3-0.6B-Q8_0.gguf
```

```bash
npm install
nemo-speech serve --asr-model nemotron-en --host 127.0.0.1 --port 8080
llama.cpp/build/bin/llama-server --port 8081 -m models/Qwen3-0.6B-Q8_0.gguf
node server.js
```

Open `http://localhost:3000`.

## Status

- [x] VAD, endpointing, utterance buffering
- [x] Batch ASR via NeMo-Speech.cpp
- [x] Local LLM response via llama.cpp (non-streaming, `stream: false`)
- [ ] TTS — **next**
- [ ] Streaming ASR — in development
- [ ] LLM token streaming
- [ ] Barge-in / interruption
- [ ] Latency telemetry

## Next: TTS

Goal: speak the LLM reply back to the browser.

Current state of the code TTS has to plug into:

| Item | State |
| ---- | ----- |
| `src/SST/synthesizer/synthesizer.js` | `class Synthesizer { speak(text) {} }`, empty, not exported |
| `Voice` constructor | accepts `synthesizer`, never called; `server.js` does not pass one |
| Hook point | `Voice.voice()`, after `reasoner.reason(transcript)` returns |
| LLM output | full reply string after generation completes; no tokens/sentences to stream yet |
| Server → client | JSON text frames only; no binary/audio downstream message type |
| Browser | no playback code; `AudioContext` exists only for mic capture |
| Mic capture | `echoCancellation: false` — played-back audio will reach the mic and VAD |
| Turn-taking | pipeline keeps listening during a reply; no barge-in handling |
| Telemetry | `ttsStart`, `firstAudioChunk`, `playbackStart` fields reserved in `src/telementry/telementry.js` |

Available locally: NeMo-Speech.cpp also serves `POST /v1/audio/speech` (MagpieTTS Multilingual 357M).

## References

- [Silero VAD](https://github.com/snakers4/silero-vad)
- [NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp)
- [Nemotron Speech Streaming 0.6B](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b)
- [llama.cpp](https://github.com/ggml-org/llama.cpp)
- [ONNX Runtime](https://onnxruntime.ai/)
