#!/usr/bin/env bash
# Installs the local tools Take Note uses on macOS:
#   - ffmpeg + whisper.cpp (speech-to-text)            via Homebrew
#   - a multilingual Whisper model (~574 MB)           into ~/.cache/whisper
#   - sherpa-onnx + 2 speaker models (~80 MB)          into ~/.take-note   (skip with --no-speakers)
# Everything runs and stays on your Mac.
set -euo pipefail

SPEAKERS=1
for arg in "$@"; do
  case "$arg" in
    --no-speakers) SPEAKERS=0 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
  esac
done

say() { printf "\n\033[1m==> %s\033[0m\n" "$1"; }

[[ "$(uname)" == "Darwin" ]] || { echo "This script is for macOS. See the README for other platforms."; exit 1; }
command -v brew >/dev/null || { echo "Homebrew is required: https://brew.sh"; exit 1; }

say "Installing ffmpeg and whisper.cpp (Homebrew)"
brew install ffmpeg whisper-cpp

WHISPER_DIR="$HOME/.cache/whisper"
WHISPER_MODEL="$WHISPER_DIR/ggml-large-v3-turbo-q5_0.bin"
if [[ -f "$WHISPER_MODEL" ]]; then
  say "Whisper model already present"
else
  say "Downloading Whisper model large-v3-turbo-q5_0 (~574 MB)"
  mkdir -p "$WHISPER_DIR"
  curl -L --fail --progress-bar -o "$WHISPER_MODEL.part" \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
  mv "$WHISPER_MODEL.part" "$WHISPER_MODEL"
fi

if [[ "$SPEAKERS" == 1 ]]; then
  if ! command -v node >/dev/null; then
    say "Installing Node.js (needed to run speaker separation)"
    brew install node
  fi
  TAKE_NOTE_HOME="${TAKE_NOTE_HOME:-$HOME/.take-note}"
  say "Installing sherpa-onnx into $TAKE_NOTE_HOME"
  mkdir -p "$TAKE_NOTE_HOME/models"
  cd "$TAKE_NOTE_HOME"
  [[ -f package.json ]] || echo '{"name":"take-note-helper","private":true}' > package.json
  # 2.0.1 is pinned: it is the newest release with macOS builds at the time of writing.
  npm install --silent --save-exact sherpa-onnx-node@2.0.1
  cd models
  if [[ ! -f sherpa-onnx-pyannote-segmentation-3-0/model.onnx ]]; then
    say "Downloading speaker segmentation model (~7 MB)"
    curl -L --fail --progress-bar -o seg.tar.bz2 \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
    tar -xjf seg.tar.bz2 && rm seg.tar.bz2
  fi
  EMB=3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx
  if [[ ! -f "$EMB" ]]; then
    say "Downloading voice fingerprint model (~40 MB)"
    curl -L --fail --progress-bar -o "$EMB.part" \
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/$EMB"
    mv "$EMB.part" "$EMB"
  fi
  TAKE_NOTE_HOME="$TAKE_NOTE_HOME" node -e 'require(process.env.TAKE_NOTE_HOME + "/node_modules/sherpa-onnx-node"); console.log("sherpa-onnx OK")'
fi

say "Done. In Obsidian: Settings → Take Note → \"Check Whisper setup\" and \"Check speaker setup\"."
