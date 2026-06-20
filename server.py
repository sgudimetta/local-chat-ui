#!/usr/bin/env python3
"""Local chat UI server — serves static files and proxies to Ollama."""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from web_search import build_web_context

OLLAMA_BASE = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
PORT = int(os.environ.get("CHAT_UI_PORT", "8080"))
STATIC_DIR = Path(__file__).resolve().parent / "static"
_http_server: ThreadingHTTPServer | None = None


def unload_ollama_models() -> list[str]:
    """Unload all models from Ollama RAM (keep_alive=0)."""
    unloaded: list[str] = []
    with urllib.request.urlopen(f"{OLLAMA_BASE}/api/ps", timeout=5) as resp:
        running = json.loads(resp.read()).get("models") or []
    for m in running:
        name = m.get("name") or m.get("model")
        if not name:
            continue
        body = json.dumps({"model": name, "prompt": "", "keep_alive": 0}).encode()
        req = urllib.request.Request(
            f"{OLLAMA_BASE}/api/generate",
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            urllib.request.urlopen(req, timeout=10)
            unloaded.append(name)
        except urllib.error.URLError:
            pass
    return unloaded


def schedule_server_shutdown(delay: float = 0.25) -> None:
    def _shutdown() -> None:
        time.sleep(delay)
        if _http_server:
            _http_server.shutdown()

    threading.Thread(target=_shutdown, daemon=True).start()


class ChatHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, fmt, *args):
        if args and args[0].startswith("GET /api/"):
            return
        super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path == "/api/models":
            self._proxy_get(f"{OLLAMA_BASE}/api/tags")
            return
        if self.path == "/api/health":
            self._json_response(200, {"ok": True, "ollama": OLLAMA_BASE})
            return
        if self.path.startswith("/api/search?"):
            q = urllib.parse.unquote(self.path.split("q=", 1)[-1].split("&")[0]) if "q=" in self.path else ""
            if not q:
                self._json_response(400, {"error": "Missing q parameter"})
                return
            ctx, direct, sources = build_web_context(q)
            self._json_response(200, {"query": q, "context": ctx, "direct": direct, "sources": sources})
            return
        if self.path in ("/", ""):
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/chat":
            self._proxy_chat_stream()
            return
        if self.path == "/api/unload":
            self._unload_models()
            return
        if self.path == "/api/shutdown":
            self._shutdown_server()
            return
        if self.path == "/api/warmup":
            self._warmup_model()
            return
        if self.path == "/api/generate":
            self._proxy_post_raw(f"{OLLAMA_BASE}/api/generate")
            return
        self.send_error(404)

    def _unload_models(self):
        try:
            unloaded = unload_ollama_models()
            self._json_response(200, {"ok": True, "unloaded": unloaded})
        except urllib.error.URLError as e:
            self._json_response(502, {"error": str(e)})

    def _shutdown_server(self):
        """Unload models and stop the chat UI server."""
        unloaded: list[str] = []
        try:
            unloaded = unload_ollama_models()
        except urllib.error.URLError:
            pass
        self._json_response(200, {
            "ok": True,
            "unloaded": unloaded,
            "message": "Server stopping. Run ./start.sh to start again.",
        })
        schedule_server_shutdown()

    def _warmup_model(self):
        """Load model into RAM so the first real reply is faster."""
        body = self._read_body()
        try:
            payload = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._json_response(400, {"error": "Invalid JSON"})
            return
        model = payload.get("model", "llama3.1:8b")
        fast = payload.get("fast_mode", False)
        req_body = json.dumps({
            "model": model,
            "prompt": " ",
            "stream": False,
            "keep_alive": "30m",
            "options": self._perf_options(fast),
        }).encode()
        req = urllib.request.Request(
            f"{OLLAMA_BASE}/api/generate",
            data=req_body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            urllib.request.urlopen(req, timeout=120)
            self._json_response(200, {"ok": True, "model": model, "warmed": True})
        except urllib.error.URLError as e:
            self._json_response(502, {"error": str(e)})

    @staticmethod
    def _perf_options(fast: bool) -> dict:
        if fast:
            return {"num_ctx": 4096, "num_predict": 1024, "num_batch": 512}
        return {"num_ctx": 8192, "num_predict": 2048, "num_batch": 512}

    def _apply_perf_options(self, payload: dict) -> None:
        fast = payload.pop("fast_mode", False)
        payload.setdefault("keep_alive", "30m")
        opts = payload.setdefault("options", {})
        for k, v in self._perf_options(fast).items():
            opts.setdefault(k, v)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    def _json_response(self, code: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _proxy_get(self, url: str):
        try:
            with urllib.request.urlopen(url, timeout=10) as resp:
                body = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.URLError as e:
            self._json_response(502, {"error": f"Ollama unreachable at {OLLAMA_BASE}: {e}"})

    def _proxy_post_raw(self, url: str):
        body = self._read_body()
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                out = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)
        except urllib.error.URLError as e:
            self._json_response(502, {"error": str(e)})

    def _inject_web_search(self, payload: dict) -> tuple[dict, dict | None]:
        """If web_search enabled, enrich messages. Returns (payload, meta)."""
        use_web = payload.pop("web_search", False)
        if not use_web:
            return payload, None

        messages = payload.get("messages") or []
        last_user = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")
        if not last_user:
            return payload, None

        context, direct, sources = build_web_context(last_user)
        meta = {"web_search": True, "sources": sources}

        if direct:
            meta["direct_answer"] = direct
            payload["_direct_answer"] = direct
            return payload, meta

        user_system = "\n\n".join(
            m["content"] for m in messages if m.get("role") == "system" and m.get("content")
        )
        web_part = (
            "The user enabled web search for this turn. Use the live search results below "
            "for current facts, numbers, and dates. Also remember the conversation history.\n\n"
            f"{context}"
        )
        combined_system = f"{user_system}\n\n{web_part}".strip() if user_system else web_part
        web_system = {"role": "system", "content": combined_system}
        out = [web_system]
        for m in messages:
            if m.get("role") != "system":
                out.append(m)
        payload["messages"] = out
        return payload, meta

    def _proxy_chat_stream(self):
        body = self._read_body()
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self._json_response(400, {"error": "Invalid JSON"})
            return

        payload, search_meta = self._inject_web_search(payload)
        model = payload.get("model", "llama3.1:8b")
        self._apply_perf_options(payload)

        if direct_answer := payload.pop("_direct_answer", None):
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            if search_meta:
                self.wfile.write((json.dumps({"search_meta": search_meta}) + "\n").encode())
            chunk = json.dumps({"model": model, "message": {"role": "assistant", "content": direct_answer}, "done": False}) + "\n"
            done = json.dumps({"model": model, "message": {"role": "assistant", "content": ""}, "done": True}) + "\n"
            self.wfile.write(chunk.encode())
            self.wfile.write(done.encode())
            self.wfile.flush()
            return

        ollama_body = json.dumps(payload).encode()
        req = urllib.request.Request(
            f"{OLLAMA_BASE}/api/chat",
            data=ollama_body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                if search_meta:
                    self.wfile.write((json.dumps({"search_meta": search_meta}) + "\n").encode())
                try:
                    while True:
                        chunk = resp.read(4096)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
        except urllib.error.URLError as e:
            self._json_response(502, {"error": f"Ollama chat failed: {e}"})


def main():
    global _http_server
    if not STATIC_DIR.is_dir():
        print(f"Missing static dir: {STATIC_DIR}", file=sys.stderr)
        sys.exit(1)

    _http_server = ThreadingHTTPServer(("127.0.0.1", PORT), ChatHandler)
    print(f"Local Chat UI  →  http://127.0.0.1:{PORT}")
    print(f"Ollama backend →  {OLLAMA_BASE}")
    print("Press Ctrl+C to stop, or use 'Stop server' in the UI")
    try:
        _http_server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        _http_server.server_close()


if __name__ == "__main__":
    try:
        main()
    except OSError as e:
        if e.errno == 48:  # Address already in use
            print(f"\nERROR: Port {PORT} is already in use.", file=sys.stderr)
            print(f"\nUse a different port:", file=sys.stderr)
            print(f"  CHAT_UI_PORT=8081 python3 server.py", file=sys.stderr)
            print(f"  open http://127.0.0.1:8081", file=sys.stderr)
            print(f"\nOr free port {PORT}:", file=sys.stderr)
            print(f"  lsof -ti :{PORT} | xargs kill -9", file=sys.stderr)
            sys.exit(1)
        raise
