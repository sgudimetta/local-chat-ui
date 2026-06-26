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
  if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
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

  if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    ok "Ollama running"
    return 0
  fi

  warn "Ollama not running. Install from https://ollama.com/download or: brew install ollama"
  return 1
}

ensure_model_hint() {
  if ! curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    return 0
  fi
  count="$(curl -s http://127.0.0.1:11434/api/tags | python3 -c "
import sys, json
print(len(json.load(sys.stdin).get('models', [])))
" 2>/dev/null || echo 0)"
  if [[ "${count:-0}" -eq 0 ]]; then
    warn "No Ollama models installed yet. Run: ollama pull llama3.1:8b"
  else
    ok "${count} Ollama model(s) installed"
  fi
}

echo "Local Chat UI — checking dependencies…"
ensure_curl
ensure_venv
ensure_pdf || true
ensure_ollama || true
ensure_model_hint
echo ""
