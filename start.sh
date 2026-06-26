#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
export CHAT_UI_PORT="${CHAT_UI_PORT:-8080}"
PORT="$CHAT_UI_PORT"

port_in_use() {
  lsof -ti :"${PORT}" >/dev/null 2>&1
}

if port_in_use; then
  echo "ERROR: Port ${PORT} is already in use."
  echo ""
  echo "What's using it:"
  lsof -i :"${PORT}" 2>/dev/null | head -5 || true
  echo ""
  echo "Option A — use a different port (recommended if another app owns 8080):"
  echo "  CHAT_UI_PORT=8081 ./start.sh"
  echo "  open http://127.0.0.1:8081"
  echo ""
  echo "Option B — free port ${PORT} (only if it's a leftover Local Chat server):"
  echo "  lsof -ti :${PORT} | xargs kill -9"
  echo "  ./start.sh"
  echo ""
  echo "Option C — one-liner: try ports until one works:"
  echo "  for p in 8080 8081 8082 8090; do CHAT_UI_PORT=\$p ./start.sh && break; done"
  exit 1
fi

# Auto-install / verify dependencies (PDF, Ollama, etc.)
bash "$DIR/setup.sh"

if ! curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "ERROR: Ollama still not reachable at http://127.0.0.1:11434"
  echo "Run ./setup.sh or: brew install ollama && brew services start ollama"
  exit 1
fi

echo "Models available:"
curl -s http://127.0.0.1:11434/api/tags | python3 -c "
import sys, json
for m in json.load(sys.stdin).get('models', []):
    print('  -', m['name'])
"

echo ""
echo "Open →  http://127.0.0.1:${PORT}"
echo "Stop  →  click 'Stop server' in the UI, or Ctrl+C here"
echo ""

PYTHON="$DIR/.venv/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  PYTHON="python3"
fi

exec "$PYTHON" "$DIR/server.py"
