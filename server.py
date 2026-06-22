#!/usr/bin/env python3
"""Local chat UI server — serves static files and proxies to Ollama."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from web_search import build_web_context, query_needs_verification
from repo_tools import (
    get_repo_root,
    grep_repo,
    list_tree,
    load_file_context,
    read_file,
    set_repo_root,
    write_file,
)
from agent import run_agent

OLLAMA_BASE = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
PORT = int(os.environ.get("CHAT_UI_PORT", "8080"))
STATIC_DIR = Path(__file__).resolve().parent / "static"
DATA_DIR = Path(os.environ.get("CHAT_UI_DATA_DIR", Path(__file__).resolve().parent / "data"))
CHATS_FILE = DATA_DIR / "chats.json"
_http_server: ThreadingHTTPServer | None = None
_chat_store_lock = threading.Lock()


def load_chats_from_disk() -> dict:
    """Load persisted chats from disk. Returns {activeId, chats, updatedAt}."""
    with _chat_store_lock:
        if not CHATS_FILE.is_file():
            return {"activeId": None, "chats": [], "updatedAt": None}
        try:
            data = json.loads(CHATS_FILE.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                return {"activeId": None, "chats": [], "updatedAt": None}
            chats = data.get("chats")
            if not isinstance(chats, list):
                chats = []
            return {
                "activeId": data.get("activeId"),
                "chats": chats,
                "updatedAt": data.get("updatedAt"),
            }
        except (OSError, json.JSONDecodeError):
            return {"activeId": None, "chats": [], "updatedAt": None}


def save_chats_to_disk(data: dict) -> None:
    """Atomically persist chats to disk, merging with existing by id."""
    incoming = data.get("chats") if isinstance(data.get("chats"), list) else []
    existing = load_chats_from_disk().get("chats") or []
    by_id: dict[str, dict] = {}
    for raw in existing:
        if isinstance(raw, dict) and raw.get("id"):
            by_id[str(raw["id"])] = raw
    for raw in incoming:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        cid = str(raw["id"])
        prev = by_id.get(cid)
        if not prev or (raw.get("updatedAt") or 0) >= (prev.get("updatedAt") or 0):
            by_id[cid] = raw
    merged = sorted(by_id.values(), key=lambda c: c.get("updatedAt") or 0, reverse=True)
    payload = {
        "activeId": data.get("activeId"),
        "chats": merged,
        "updatedAt": data.get("updatedAt") or int(time.time() * 1000),
    }
    with _chat_store_lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = CHATS_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(CHATS_FILE)


def system_ram_gb() -> int | None:
    """Best-effort total RAM in GB (macOS sysctl)."""
    try:
        out = subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True).strip()
        return round(int(out) / (1024**3))
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


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
        if args and isinstance(args[0], str) and args[0].startswith("GET /api/"):
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
        if self.path == "/api/system":
            self._json_response(200, {"ram_gb": system_ram_gb()})
            return
        if self.path == "/api/repo":
            root = get_repo_root()
            self._json_response(200, {"root": str(root) if root else None})
            return
        if self.path.startswith("/api/repo/tree"):
            self._repo_tree()
            return
        if self.path == "/api/chats":
            self._get_chats()
            return
        if self.path.startswith("/api/search?"):
            q = urllib.parse.unquote(self.path.split("q=", 1)[-1].split("&")[0]) if "q=" in self.path else ""
            if not q:
                self._json_response(400, {"error": "Missing q parameter"})
                return
            result = build_web_context(q)
            self._json_response(200, {"query": q, **result})
            return
        if self.path in ("/", ""):
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/chat":
            self._proxy_chat_stream()
            return
        if self.path == "/api/agent":
            self._run_agent()
            return
        if self.path == "/api/repo":
            self._set_repo()
            return
        if self.path == "/api/repo/read":
            self._repo_read()
            return
        if self.path == "/api/repo/grep":
            self._repo_grep()
            return
        if self.path == "/api/repo/write":
            self._repo_write()
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
        if self.path == "/api/chats":
            self._put_chats()
            return
        if self.path == "/api/generate":
            self._proxy_post_raw(f"{OLLAMA_BASE}/api/generate")
            return
        self.send_error(404)

    def do_PUT(self):
        if self.path == "/api/chats":
            self._put_chats()
            return
        self.send_error(404)

    def _get_chats(self):
        data = load_chats_from_disk()
        self._json_response(200, data)

    def _put_chats(self):
        body = self._read_body()
        try:
            payload = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._json_response(400, {"error": "Invalid JSON"})
            return
        if not isinstance(payload.get("chats"), list):
            self._json_response(400, {"error": "Missing chats array"})
            return
        try:
            save_chats_to_disk(payload)
            self._json_response(200, {"ok": True, "count": len(payload["chats"])})
        except OSError as e:
            self._json_response(500, {"error": f"Could not save chats: {e}"})

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
            return {
                "num_ctx": 4096,
                "num_predict": 1024,
                "num_batch": 512,
                "temperature": 0.7,
                "top_p": 0.9,
            }
        return {
            "num_ctx": 8192,
            "num_predict": 3072,
            "num_batch": 512,
            "temperature": 0.55,
            "top_p": 0.92,
            "repeat_penalty": 1.08,
        }

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

    def _set_repo(self):
        body = self._read_body()
        try:
            payload = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._json_response(400, {"error": "Invalid JSON"})
            return
        path = (payload.get("path") or "").strip()
        if not path:
            self._json_response(400, {"error": "Missing path"})
            return
        try:
            root = set_repo_root(path)
            self._json_response(200, {"ok": True, "root": str(root)})
        except ValueError as e:
            self._json_response(400, {"error": str(e)})

    def _repo_tree(self):
        q = urllib.parse.urlparse(self.path).query
        sub = ""
        if q:
            sub = urllib.parse.parse_qs(q).get("path", [""])[0]
        try:
            entries = list_tree(sub)
            self._json_response(200, {"entries": entries, "root": str(get_repo_root())})
        except ValueError as e:
            self._json_response(400, {"error": str(e)})

    def _repo_read(self):
        body = self._read_body()
        try:
            payload = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._json_response(400, {"error": "Invalid JSON"})
            return
        try:
            data = read_file(payload.get("path", ""))
            self._json_response(200, data)
        except ValueError as e:
            self._json_response(400, {"error": str(e)})

    def _repo_grep(self):
        body = self._read_body()
        try:
            payload = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._json_response(400, {"error": "Invalid JSON"})
            return
        try:
            matches = grep_repo(payload.get("pattern", ""), payload.get("path", ""))
            self._json_response(200, {"matches": matches})
        except ValueError as e:
            self._json_response(400, {"error": str(e)})

    def _repo_write(self):
        body = self._read_body()
        try:
            payload = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._json_response(400, {"error": "Invalid JSON"})
            return
        try:
            result = write_file(payload.get("path", ""), payload.get("content", ""))
            self._json_response(200, result)
        except ValueError as e:
            self._json_response(400, {"error": str(e)})

    def _run_agent(self):
        body = self._read_body()
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self._json_response(400, {"error": "Invalid JSON"})
            return
        model = payload.get("model", "llama3.1:8b")
        fast = payload.get("fast_mode", False)
        messages = payload.get("messages") or []
        approved = payload.get("approved_write")
        attachments = payload.get("attachments")
        mode = payload.get("mode", "agent")
        result = run_agent(
            messages,
            model=model,
            mode=mode,
            fast_mode=fast,
            approved_write=approved,
            perf_options=self._perf_options(fast),
            attachments=attachments,
        )
        self._json_response(200, result)

    def _inject_repo_context(self, payload: dict) -> None:
        messages = payload.get("messages") or []
        last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
        if not last_user:
            return
        text = last_user.get("content") or ""
        if isinstance(text, list):
            text = " ".join(
                p.get("text", "") for p in text if isinstance(p, dict) and p.get("type") == "text"
            )
        ctx = load_file_context(text)
        if not ctx:
            return
        root = get_repo_root()
        header = f"Project root: {root}\n\n{ctx}" if root else ctx
        sys_msg = {"role": "system", "content": header}
        out = []
        inserted = False
        for m in messages:
            if m.get("role") == "system" and not inserted:
                out.append({"role": "system", "content": f"{m.get('content', '')}\n\n{header}".strip()})
                inserted = True
            else:
                out.append(m)
        if not inserted:
            out.insert(0, sys_msg)
        payload["messages"] = out

    def _inject_attachments(self, payload: dict) -> None:
        attachments = payload.pop("attachments", None)
        if not attachments:
            return
        blocks: list[str] = []
        for raw in attachments:
            if not isinstance(raw, dict):
                continue
            name = raw.get("name") or "file"
            text = raw.get("text") or ""
            if not text.strip():
                continue
            note = " (truncated)" if raw.get("truncated") else ""
            blocks.append(f"--- Attached: {name}{note} ---\n{text}")
        if not blocks:
            return
        header = (
            "IMPORTANT: The user attached files. Their FULL contents are in the user message below.\n"
            "Analyze the ACTUAL file contents. Do NOT give generic 'how to analyze' advice.\n\n"
            + "\n\n".join(blocks)
        )
        messages = payload.get("messages") or []
        inserted = False
        out = []
        for m in messages:
            if m.get("role") == "system" and not inserted:
                out.append({"role": "system", "content": f"{m.get('content', '')}\n\n{header}".strip()})
                inserted = True
            else:
                out.append(m)
        if not inserted:
            out.insert(0, {"role": "system", "content": header})
        # Ensure last user message includes file text (fallback if client didn't embed)
        for i in range(len(out) - 1, -1, -1):
            if out[i].get("role") == "user":
                content = out[i].get("content") or ""
                if blocks[0][:40] not in content:
                    names = ", ".join(raw.get("name", "file") for raw in attachments if isinstance(raw, dict))
                    out[i]["content"] = (
                        f"{content.strip() or 'Analyze the attached file(s).'}\n\n"
                        f"[Attached: {names}]\n\n" + "\n\n".join(blocks)
                    )
                break
        payload["messages"] = out

    def _prepare_messages_for_ollama(self, payload: dict) -> None:
        """Ensure user messages with images use Ollama multimodal format."""
        images = payload.pop("images", None)
        if not images:
            return
        messages = payload.get("messages") or []
        for m in reversed(messages):
            if m.get("role") == "user":
                m["images"] = images
                break

    def _inject_web_search(self, payload: dict) -> tuple[dict, dict | None]:
        """If web_search enabled, enrich messages. Returns (payload, meta)."""
        use_web = payload.pop("web_search", False)
        if not use_web:
            return payload, None

        messages = payload.get("messages") or []
        force_search = payload.pop("web_search_force", False)
        verify_facts = payload.pop("verify_facts", False)
        last_user = payload.pop("web_search_query", None) or next(
            (m["content"] for m in reversed(messages) if m.get("role") == "user"), ""
        )
        if not last_user:
            return payload, None

        verify_facts = verify_facts or query_needs_verification(last_user)
        if verify_facts:
            force_search = True

        result = build_web_context(last_user, force_search=force_search)
        context = result["context"]
        direct = result.get("direct_answer")
        verify_facts = verify_facts or bool(result.get("verify_facts"))
        meta = {
            "web_search": True,
            "sources": result.get("sources") or [],
            "handler": result.get("handler"),
            "source_label": result.get("source_label"),
            "live_data": bool(result.get("live_data")),
            "verify_facts": verify_facts,
        }

        if direct:
            meta["direct_answer"] = direct
            payload["_direct_answer"] = direct
            return payload, meta

        user_system = "\n\n".join(
            m["content"] for m in messages if m.get("role") == "system" and m.get("content")
        )
        if verify_facts:
            web_part = (
                "This question needs VERIFIED facts (versions, releases, dates, support status).\n\n"
                "Rules — follow strictly:\n"
                "1. Base version numbers, release dates, and any 'latest/current' claim ONLY on "
                "the reference material below and its 'Today is …' line.\n"
                "2. If your training memory disagrees with the reference, trust the reference.\n"
                "3. If the reference is thin or conflicting, say you could not fully verify and "
                "give only what the sources support — do NOT guess from memory.\n"
                "4. Answer in your own words with a polished, structured reply.\n"
                "5. Never tell the user to search elsewhere.\n\n"
                f"{context}"
            )
        else:
            web_part = (
                "Reference material from the web is provided below. Use it thoughtfully:\n\n"
                "1. Silently clarify what the user needs and how the reference material applies.\n"
                "2. Answer in your own words with a polished, structured reply — no visible planning "
                "or pasted search snippets.\n"
                "3. Use the reference only for facts that must be current or verified "
                "(numbers, dates, names, scores, rates).\n"
                "4. For reasoning, comparison, or follow-ups, rely on your analysis and chat context.\n"
                "5. If the reference is thin or conflicting, say so briefly and reason from what you know.\n"
                "6. Never tell the user to check websites or search elsewhere.\n\n"
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

        self._inject_attachments(payload)
        payload, search_meta = self._inject_web_search(payload)
        self._inject_repo_context(payload)
        self._prepare_messages_for_ollama(payload)
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
    print(f"Chats saved to →  {CHATS_FILE}")
    root = get_repo_root()
    if root:
        print(f"Project root   →  {root}")
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
