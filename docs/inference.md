# Yuga inference providers

Provider mode uses a hosted LLM and Sarvam TTS. Local mode uses llama.cpp and Kokoro. ASR stays on the local NeMo-Speech server in both modes.

```bash
INFERENCE_MODE=provider          # or local
LLM_PROVIDER=openrouter          # or groq
```

## OpenRouter LLM

```bash
OPENROUTER_API_KEY=
OPENROUTER_MODEL=                # must be a free model, id ending in :free
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

The default model is `google/gemma-4-31b-it:free`. It was selected from OpenRouter's live free catalogue because it advertises native tools, a 256k context window, and zero prompt/completion price.

Free models share upstream capacity, so the primary often returns 429 "temporarily rate-limited upstream". Each request sends OpenRouter a `models` list, and it falls through to the next free model on failure:

```bash
OPENROUTER_FALLBACK_MODELS=nvidia/nemotron-3.5-super-vl:free   # empty disables
```

Paid OpenRouter models are refused, including as fallbacks. There is no automatic fallback to Groq or to a paid model.

Keys go in `.env` (gitignored, see `.env.example`). `server.js` loads it on start; real environment variables win.

Optional headers:

```bash
OPENROUTER_HTTP_REFERER=
OPENROUTER_TITLE=Yuga
```

## Groq LLM

```bash
LLM_PROVIDER=groq
GROQ_API_KEY=
GROQ_MODEL=openai/gpt-oss-120b
```

## Sarvam TTS

Provider mode still uses Sarvam TTS exactly as before: `bulbul:v3`, speaker `priya`, language `en-IN`, 22050 Hz. That path is separate from the LLM. Do not point `LLM_PROVIDER` at Sarvam.

```bash
SARVAM_API_KEY=
```

## Local

```bash
INFERENCE_MODE=local
```

This forces the local llama server and Kokoro. Hosted LLM and Sarvam TTS are not used.
