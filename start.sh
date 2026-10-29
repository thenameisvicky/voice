#!/usr/bin/env bash
cd "$(dirname "$0")"

nemo-speech serve 
  --asr-model nemotron-en 
  --host 127.0.0.1 
  --port 8080 &

./llama.cpp/build/bin/llama-server 
  -t 2 
  --host 127.0.0.1 
  --port 8081 
  -m ./models/Qwen3-0.6B-Q8_0.gguf &

node server.js &

wait