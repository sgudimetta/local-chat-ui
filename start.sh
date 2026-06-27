#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
export CHAT_UI_PORT="${CHAT_UI_PORT:-8080}"
PORT="$CHAT_UI_PORT"
OPEN_BROWSER="${OPEN_BROWSER:-1}"

# Auto-install deps, start Ollama, download RAM-appropriate models
bash "$DIR/setup.sh"

PYTHON="$DIR/.venv/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  PYTHON="python3"
fi

URL="http://127.0.0.1:${PORT}"

if [[ "$OPEN_BROWSER" == "1" ]] && command -v open >/dev/null 2>&1; then
  (
    for _ in $(seq 1 40); do
      if curl -sf "${URL}/" >/dev/null 2>&1; then
        open "${URL}" 2>/dev/null || true
        exit 0
      fi
      sleep 0.25
    done
  ) &
fi

echo ""
echo "Local Chat →  ${URL}"
echo "Stop/Start from the sidebar · Ctrl+C to quit this terminal"
echo ""

exec "$PYTHON" "$DIR/launcher.py"
