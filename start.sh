#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

LLAMA_DIR="$ROOT/llama.cpp"
NEMO_DIR="$ROOT/NeMo-Speech.cpp"
MODELS_DIR="$ROOT/models"
KOKORO_DIR="$MODELS_DIR/Kokoro-82M-v1.0-ONNX"
QWEN_GGUF="$MODELS_DIR/Qwen3-0.6B-Q8_0.gguf"
SILERO_ONNX="$ROOT/src/SST/VAD/silero_vad.onnx"

ASR_PORT=8080
LLM_PORT=8081
APP_PORT=3000

JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
OS="$(uname -s)"
ARCH="$(uname -m)"

ASR_PID=""
LLM_PID=""
APP_PID=""

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

need() {
    command -v "$1" >/dev/null 2>&1 || die "missing '$1'. $2"
}

cleanup() {
    trap - EXIT INT TERM
    for pid in "$APP_PID" "$LLM_PID" "$ASR_PID"; do
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
        fi
    done
    wait 2>/dev/null || true
}

trap cleanup EXIT INT TERM

case "$OS" in
    Darwin)
        NEMO_PRESET="cpu-server"
        if [ "$ARCH" = "arm64" ]; then
            NEMO_PRESET="metal-server"
        fi
        DEP_HINT="Install Xcode CLT, then: brew install git cmake ninja sentencepiece abseil curl"
        ;;
    Linux)
        NEMO_PRESET="cpu-server"
        DEP_HINT="Install: git cmake ninja-build g++ curl libsentencepiece-dev (Debian/Ubuntu) or sentencepiece-devel (Fedora)"
        ;;
    *)
        die "unsupported OS '$OS' (Mac and Linux only)"
        ;;
esac

NEMO_BIN="$NEMO_DIR/build/$NEMO_PRESET/bin/nemo-speech"
LLAMA_BIN="$LLAMA_DIR/build/bin/llama-server"

log "checking tools"
need git "$DEP_HINT"
need cmake "$DEP_HINT"
need curl "$DEP_HINT"
need node "Install Node.js 20.11 or newer (nvm install 20)."

if ! command -v ninja >/dev/null 2>&1; then
    die "missing 'ninja'. $DEP_HINT"
fi

if ! command -v c++ >/dev/null 2>&1 && ! command -v clang++ >/dev/null 2>&1 && ! command -v g++ >/dev/null 2>&1; then
    die "missing a C++ compiler. $DEP_HINT"
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 20 ]; then
    if [ -s "$HOME/.nvm/nvm.sh" ]; then
        . "$HOME/.nvm/nvm.sh"
        nvm use 20 >/dev/null 2>&1 || nvm install 20
    fi
    NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
    [ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20.11+ is required (found $(node -v))."
fi

clone_repo() {
    local url="$1" dest="$2"
    if [ -d "$dest/.git" ]; then
        printf '    already cloned: %s\n' "$dest"
        return
    fi
    if [ -e "$dest" ]; then
        die "$dest exists but is not a git clone"
    fi
    git clone --depth 1 "$url" "$dest"
}

download() {
    local url="$1" dest="$2"
    if [ -s "$dest" ]; then
        printf '    already have %s\n' "$dest"
        return
    fi
    mkdir -p "$(dirname "$dest")"
    printf '    downloading %s\n' "$dest"
    curl -L --fail --retry 3 --retry-delay 2 -C - \
        -H "User-Agent: kural-start" \
        -o "$dest.part" "$url"
    mv "$dest.part" "$dest"
}

wait_http() {
    local url="$1" name="$2" tries="${3:-180}"
    printf '    waiting for %s' "$name"
    i=0
    while [ "$i" -lt "$tries" ]; do
        if curl -fsS "$url" >/dev/null 2>&1; then
            printf ' ready\n'
            return
        fi
        printf '.'
        sleep 1
        i=$((i + 1))
    done
    printf '\n'
    die "$name did not become ready at $url"
}

with_libs() {
    local dir="$1"
    if [ "$OS" = "Darwin" ]; then
        export DYLD_LIBRARY_PATH="$dir${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
    else
        export LD_LIBRARY_PATH="$dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    fi
}

log "npm install"
if [ ! -d "$ROOT/node_modules" ]; then
    npm install
else
    printf '    node_modules already present\n'
fi

log "llama.cpp"
clone_repo "https://github.com/ggml-org/llama.cpp.git" "$LLAMA_DIR"

if [ ! -x "$LLAMA_BIN" ]; then
    cmake -S "$LLAMA_DIR" -B "$LLAMA_DIR/build" -DBUILD_SHARED_LIBS=OFF
    cmake --build "$LLAMA_DIR/build" --config Release -j "$JOBS" --target llama-server
fi
[ -x "$LLAMA_BIN" ] || die "llama-server did not build at $LLAMA_BIN"

log "NeMo-Speech.cpp ($NEMO_PRESET)"
clone_repo "https://github.com/NVIDIA/NeMo-Speech.cpp.git" "$NEMO_DIR"

if [ ! -x "$NEMO_BIN" ]; then
    git -C "$NEMO_DIR" submodule update --init llama.cpp third_party/cpp-httplib
    if ! (cd "$NEMO_DIR" && scripts/configure.sh "$NEMO_PRESET" && cmake --build --preset "$NEMO_PRESET" -j "$JOBS"); then
        [ "$NEMO_PRESET" != "cpu-server" ] || die "NeMo-Speech.cpp cpu-server build failed"
        log "falling back to cpu-server"
        NEMO_PRESET="cpu-server"
        NEMO_BIN="$NEMO_DIR/build/cpu-server/bin/nemo-speech"
        (cd "$NEMO_DIR" && scripts/configure.sh cpu-server && cmake --build --preset cpu-server -j "$JOBS")
    fi
    if [ ! -x "$NEMO_BIN" ] && [ -x "$NEMO_DIR/build/cpu-server/bin/nemo-speech" ]; then
        NEMO_BIN="$NEMO_DIR/build/cpu-server/bin/nemo-speech"
    fi
fi
[ -x "$NEMO_BIN" ] || die "nemo-speech did not build at $NEMO_BIN"

log "models"
mkdir -p "$MODELS_DIR" "$KOKORO_DIR/onnx" "$KOKORO_DIR/voices"

download \
    "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf" \
    "$QWEN_GGUF"

download \
    "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/config.json" \
    "$KOKORO_DIR/config.json"
download \
    "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/tokenizer.json" \
    "$KOKORO_DIR/tokenizer.json"
download \
    "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/tokenizer_config.json" \
    "$KOKORO_DIR/tokenizer_config.json"
download \
    "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx" \
    "$KOKORO_DIR/onnx/model_quantized.onnx"
download \
    "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin" \
    "$KOKORO_DIR/voices/af_heart.bin"

download \
    "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx" \
    "$SILERO_ONNX"

log "starting services"

with_libs "$(dirname "$NEMO_BIN")"
printf '    ASR  http://127.0.0.1:%s  (first run downloads nemotron-en to ~/.cache/nemo-speech)\n' "$ASR_PORT"
"$NEMO_BIN" serve --asr-model nemotron-en --host 127.0.0.1 --port "$ASR_PORT" &
ASR_PID=$!

wait_http "http://127.0.0.1:$ASR_PORT/v1/models" "ASR" 300

if [ "${INFERENCE_MODE:-provider}" = "local" ]; then
    printf '    LLM  http://127.0.0.1:%s\n' "$LLM_PORT"
    "$LLAMA_BIN" -t 2 --host 127.0.0.1 --port "$LLM_PORT" -m "$QWEN_GGUF" &
    LLM_PID=$!
    wait_http "http://127.0.0.1:$LLM_PORT/health" "LLM" 120
else
    printf '    LLM  Groq hosted (%s)\n' "${LLM_MODEL:-openai/gpt-oss-120b}"
fi

printf '    app  http://127.0.0.1:%s\n' "$APP_PORT"
node "$ROOT/server.js" &
APP_PID=$!

wait_http "http://127.0.0.1:$APP_PORT" "app" 30

log "Kural is up"
printf '    open http://localhost:%s\n' "$APP_PORT"
printf '    Ctrl-C stops ASR, llama-server, and the Node app\n\n'

wait
