#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
export CHAT_UI_PORT="${CHAT_UI_PORT:-8080}"
PORT="$CHAT_UI_PORT"

# Auto-install / verify dependencies (PDF, Ollama, etc.)
bash "$DIR/setup.sh"

PYTHON="$DIR/.venv/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  PYTHON="python3"
fi

echo ""
echo "Open →  http://127.0.0.1:${PORT}  (launcher — Stop/Start from sidebar)"
echo ""

exec "$PYTHON" "$DIR/launcher.py"
