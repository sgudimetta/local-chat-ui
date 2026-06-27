#!/usr/bin/env bash
# Check and install Local Chat UI dependencies (idempotent).
# Called automatically by start.sh; safe to run alone: ./setup.sh

set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

VENV="$DIR/.venv"
VENV_PY="$VENV/bin/python"
VENV_PIP="$VENV/bin/pip"

ok() { echo "  ✓ $1"; }
skip() { echo "  · $1"; }
warn() { echo "  ⚠ $1"; }
installing() { echo "  → $1"; }

has_pdftotext() { command -v pdftotext >/dev/null 2>&1; }
has_pypdf() {
  if [[ -x "$VENV_PY" ]] && "$VENV_PY" -c "import pypdf" 2>/dev/null; then return 0; fi
  python3 -c "import pypdf" 2>/dev/null
}
has_curl() { command -v curl >/dev/null 2>&1; }
has_brew() { command -v brew >/dev/null 2>&1; }
has_ollama_cli() { command -v ollama >/dev/null 2>&1; }

ollama_up() {
  curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1
}

ram_gb() {
  sysctl -n hw.memsize 2>/dev/null | awk '{printf "%.0f", $0/1024/1024/1024}' || echo 0
}

model_installed() {
  local want="$1"
  ollama_up || return 1
  curl -sf http://127.0.0.1:11434/api/tags | python3 -c "
import sys, json
want = sys.argv[1].lower()
for m in json.load(sys.stdin).get('models', []):
    n = (m.get('name') or '').lower()
    if n == want or n.startswith(want + ':'):
        sys.exit(0)
sys.exit(1)
" "$want" 2>/dev/null
}

pull_model() {
  local name="$1"
  if model_installed "$name"; then
    ok "$name"
    return 0
  fi
  if [[ "${SKIP_OLLAMA_PULL:-0}" == "1" ]]; then
    warn "SKIP_OLLAMA_PULL=1 — not downloading $name"
    return 1
  fi
  if ! has_ollama_cli; then
    warn "ollama CLI missing — cannot download $name"
    return 1
  fi
  installing "Downloading $name (first time can take several minutes)…"
  if ollama pull "$name"; then
    ok "installed $name"
    return 0
  fi
  local ec=$?
  if [[ $ec -eq 137 || $ec -eq 143 ]]; then
    warn "download of $name was killed (RAM or corporate policy) — try a personal Mac"
  else
    warn "could not download $name (exit $ec)"
  fi
  return 1
}

ensure_venv() {
  if [[ ! -x "$VENV_PY" ]]; then
    installing "Creating Python venv at .venv…"
    python3 -m venv "$VENV"
  fi
  ok "Python venv (.venv)"
  installing "Installing pip packages…"
  "$VENV_PIP" install -q --upgrade pip
  "$VENV_PIP" install -q -r "$DIR/requirements.txt"
}

ensure_curl() {
  if has_curl; then
    ok "curl"
  else
    warn "curl not found — required for web search and PDF fallback"
  fi
}

ensure_pdf() {
  if has_pdftotext; then
    ok "pdftotext (poppler) — PDF attachments"
    return 0
  fi
  if has_pypdf; then
    ok "pypdf — PDF attachments"
    return 0
  fi

  installing "PDF support missing — installing…"

  ensure_venv
  if has_pypdf; then
    ok "pypdf in .venv — PDF attachments"
    return 0
  fi

  if has_brew; then
    installing "trying brew install poppler…"
    export HOMEBREW_NO_AUTO_UPDATE=1
    if brew list poppler &>/dev/null 2>&1; then
      ok "poppler already installed via Homebrew"
      return 0
    elif brew install poppler 2>/dev/null && has_pdftotext; then
      ok "installed poppler (pdftotext)"
      return 0
    else
      warn "brew install poppler failed"
    fi
  fi

  warn "PDF attachments may not work. Run ./setup.sh again or ask your agent to fix."
  return 1
}

ensure_ollama() {
  if ollama_up; then
    ok "Ollama running at http://127.0.0.1:11434"
    return 0
  fi

  installing "Ollama not reachable — trying to start…"
  if has_brew; then
    if brew list ollama &>/dev/null 2>&1; then
      brew services start ollama 2>/dev/null || true
      sleep 2
    else
      installing "Installing Ollama via Homebrew…"
      brew install ollama 2>/dev/null || true
      brew services start ollama 2>/dev/null || true
      sleep 3
    fi
  fi

  if ! ollama_up && has_ollama_cli; then
    installing "Starting ollama serve in background…"
    nohup ollama serve >/tmp/ollama-serve.log 2>&1 &
    sleep 2
  fi

  if ollama_up; then
    ok "Ollama running"
    return 0
  fi

  warn "Ollama not running. Install from https://ollama.com/download or: brew install ollama"
  return 1
}

ensure_models() {
  if ! ollama_up; then
    return 0
  fi

  local gb
  gb="$(ram_gb)"
  [[ "$gb" =~ ^[0-9]+$ ]] || gb=16

  installing "RAM: ${gb} GB — ensuring recommended models…"

  local -a models=()
  if (( gb <= 8 )); then
    models=(llama3.2:1b moondream)
    ok "8 GB profile: small chat + vision models"
  elif (( gb <= 16 )); then
    models=(llama3.1:8b moondream)
    ok "16 GB profile: 8B chat + vision"
  elif (( gb <= 32 )); then
    models=(llama3.1:8b qwen3:14b moondream)
    ok "24–32 GB profile: 8B + 14B + vision"
  elif (( gb <= 48 )); then
    models=(llama3.1:8b qwen3:32b moondream)
    ok "48 GB profile: 8B + 32B + vision"
  else
    models=(llama3.1:8b qwen3:32b moondream)
    ok "64 GB+ profile: 8B + 32B + vision"
  fi

  local pulled=0
  local name
  for name in "${models[@]}"; do
    if pull_model "$name"; then
      ((pulled++)) || true
    fi
  done

  if model_installed "llama3.2:1b" || model_installed "llama3.1:8b" || model_installed "qwen3:14b" || model_installed "qwen3:32b"; then
    ok "Ready to chat (${pulled} model(s) checked this run)"
  else
    warn "No chat model available — downloads may have failed (corporate Mac?)"
    warn "On a personal Mac, run: ollama pull llama3.1:8b"
  fi
}

echo "Local Chat UI — automatic setup…"
ensure_curl
ensure_venv
ensure_pdf || true
ensure_ollama || true
ensure_models
echo ""
