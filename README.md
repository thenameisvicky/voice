# Yuga

## Stack

![JavaScript](https://img.shields.io/badge/JavaScript-ESM-yellow)
![Node.js](https://img.shields.io/badge/Node.js-18-green)
![WebSocket](https://img.shields.io/badge/WebSocket-WS-black)
![Silero VAD](https://img.shields.io/badge/VAD-Silero-blue)
![Whisper](https://img.shields.io/badge/ASR-Whisper.cpp-red)
![ONNX](https://img.shields.io/badge/Runtime-ONNX%20Runtime-purple)

## Current Pipeline

```text
Browser Microphone
        ↓
AudioWorklet
        ↓
PCM16 / 16 kHz / Mono
        ↓
WebSocket
        ↓
Node.js
        ↓
AudioFramer
        ↓
Silero VAD
        ↓
Endpointer
        ↓
UtteranceBuffer
        ↓
Whisper.cpp
        ↓
Transcript
        ↓
Browser UI
```

## Current Status

* Silero VAD wired and working.
* Endpointer wired and working.
* Utterance buffering wired and working.
* Whisper.cpp wired and working.
* Batch transcription working end-to-end.
* Multiple real voice tests completed.
* Transcripts are shown in the UI.
* VAD drives the orb state.
* Whisper runs locally through native `whisper-server`.

## Whisper Setup

Whisper.cpp is built and running natively.

```text
Node.js :3007
      ↓ HTTP
whisper-server :8080
      ↓
ggml-base.en.bin
```

Current model:

```text
ggml-base.en.bin
```

## Important Design

VAD frame:

```text
512 samples
16 kHz
32 ms
```

VAD frames are not STT requests.

For the current batch flow:

```text
START
  ↓
collect audio
  ↓
END
  ↓
send complete utterance to Whisper
  ↓
receive transcript
```

Streaming ASR is not implemented yet.

## Project Structure

```text
.
├── server.js
├── package.json
├── views
│   ├── index.html
│   └── audioProcessor.js
└── src
    ├── SST
    │   ├── VAD
    │   │   ├── config.js
    │   │   ├── endpointer.js
    │   │   ├── framer.js
    │   │   ├── inference.js
    │   │   └── silero_vad.onnx
    │   ├── utterance
    │   │   └── utteranceBuffer.js
    │   └── transcriber
    │       └── transcriber.js
    ├── voice
        └── voice.js
