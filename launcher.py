#!/usr/bin/env python3
"""Launcher — always-on control plane on CHAT_UI_PORT; manages server.py worker."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.client import HTTPConnection
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DIR = Path(__file__).resolve().parent
STATIC_DIR = DIR / "static"
OLLAMA_BASE = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")

LAUNCHER_PORT = int(os.environ.get("CHAT_UI_PORT", "8080"))
WORKER_PORT_START = int(os.environ.get("CHAT_UI_WORKER_PORT_START", "18080"))
WORKER_PORT_END = int(os.environ.get("CHAT_UI_WORKER_PORT_END", "18100"))
PORT_SCAN = list(range(LAUNCHER_PORT, min(LAUNCHER_PORT + 11, 8095))) + list(
    range(WORKER_PORT_START, WORKER_PORT_END + 1)
)

PYTHON = os.environ.get("CHAT_UI_PYTHON", str(DIR / ".venv" / "bin" / "python"))
if not Path(PYTHON).is_file():
    PYTHON = sys.executable

_worker_proc: subprocess.Popen | None = None
_worker_port: int | None = None
_worker_lock = threading.Lock()
_launcher_port: int = LAUNCHER_PORT
_http_server: ThreadingHTTPServer | None = None

CONTROL_PATHS = {
    "/api/server/status",
    "/api/server/start",
    "/api/shutdown",
}

CHAT_PATHS = {"/api/chats"}


def _state_file() -> Path:
    from server import DATA_DIR

    return DATA_DIR / "launcher.json"


def _save_state() -> None:
    from server import DATA_DIR

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "launcher_port": _launcher_port,
        "worker_port": _worker_port,
        "worker_pid": _worker_proc.pid if _worker_proc and _worker_proc.poll() is None else None,
        "launcher_pid": os.getpid(),
    }
    _state_file().write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _pids_on_port(port: int) -> list[int]:
    try:
        out = subprocess.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (subprocess.SubprocessError, FileNotFoundError):
        return []
    if out.returncode != 0:
        return []
    pids: list[int] = []
    for line in out.stdout.split():
        line = line.strip()
        if line.isdigit():
            pids.append(int(line))
    return pids


def _kill_pids(pids: list[int], *, exclude: set[int] | None = None) -> list[int]:
    exclude = exclude or set()
    killed: list[int] = []
    for pid in pids:
        if pid in exclude or pid == os.getpid():
            continue
        try:
            os.kill(pid, signal.SIGTERM)
            killed.append(pid)
        except OSError:
            pass
    if killed:
        time.sleep(0.35)
    for pid in killed:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    return killed


def _port_free(port: int) -> bool:
    return not _pids_on_port(port)


def _wait_health(port: int, timeout: float = 20.0) -> bool:
    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{port}/api/health"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status == 200:
                    return True
        except (urllib.error.URLError, TimeoutError):
            pass
        if _worker_proc and _worker_proc.poll() is not None:
            return False
        time.sleep(0.25)
    return False


def _unload_ollama() -> list[str]:
    from server import unload_ollama_models

    try:
        return unload_ollama_models()
    except urllib.error.URLError:
        return []


def _worker_running() -> bool:
    global _worker_proc, _worker_port
    if _worker_proc is None or _worker_proc.poll() is not None:
        _worker_proc = None
        if _worker_port and _wait_health(_worker_port, timeout=0.5):
            return True
        _worker_port = None
        return False
    if _worker_port and _wait_health(_worker_port, timeout=0.5):
        return True
    return False


def _pick_worker_port(preferred: int | None = None) -> int | None:
    candidates = []
    if preferred:
        candidates.append(preferred)
    candidates.extend(range(WORKER_PORT_START, WORKER_PORT_END + 1))
    seen: set[int] = set()
    for port in candidates:
        if port in seen:
            continue
        seen.add(port)
        if port == _launcher_port:
            continue
        if _port_free(port):
            return port
        pids = [p for p in _pids_on_port(port) if p != os.getpid()]
        if not pids:
            continue
        _kill_pids(pids, exclude={os.getpid()})
        time.sleep(0.25)
        if _port_free(port):
            return port
    return None


def stop_worker(*, unload_models: bool = True) -> dict:
    global _worker_proc, _worker_port
    with _worker_lock:
        unloaded: list[str] = []
        port = _worker_port
        proc = _worker_proc

        if port and proc and proc.poll() is None:
            try:
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}/api/shutdown",
                    data=b"{}",
                    method="POST",
                    headers={"Content-Type": "application/json"},
                )
                urllib.request.urlopen(req, timeout=3)
            except (urllib.error.URLError, TimeoutError):
                pass
            try:
                proc.wait(timeout=4)
            except subprocess.TimeoutExpired:
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()

        if port:
            _kill_pids(_pids_on_port(port), exclude={os.getpid()})

        _worker_proc = None
        old_port = port
        _worker_port = None

        if unload_models:
            unloaded = _unload_ollama()

        _save_state()
        return {
            "ok": True,
            "stopped": True,
            "worker_port": old_port,
            "unloaded": unloaded,
        }


def start_worker(*, preferred_port: int | None = None) -> dict:
    global _worker_proc, _worker_port
    with _worker_lock:
        if _worker_running():
            return {
                "ok": True,
                "already_running": True,
                "worker_port": _worker_port,
                "url": f"http://127.0.0.1:{_launcher_port}",
            }

        if _worker_proc and _worker_proc.poll() is None:
            stop_worker(unload_models=False)

        port = _pick_worker_port(preferred_port)
        if port is None:
            return {"ok": False, "error": "No free worker port found"}

        env = os.environ.copy()
        env["CHAT_UI_PORT"] = str(port)
        env.pop("CHAT_UI_WORKER", None)
        log_path = Path(env.get("CHAT_UI_DATA_DIR", "")) if env.get("CHAT_UI_DATA_DIR") else None
        if log_path is None:
            from server import DATA_DIR

            log_path = DATA_DIR
        log_path.mkdir(parents=True, exist_ok=True)
        log_file = open(log_path / "worker.log", "a", encoding="utf-8")

        try:
            proc = subprocess.Popen(
                [PYTHON, str(DIR / "server.py")],
                cwd=str(DIR),
                env=env,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        except OSError as e:
            log_file.close()
            return {"ok": False, "error": f"Could not start worker: {e}"}

        _worker_proc = proc
        _worker_port = port

        if not _wait_health(port):
            code = proc.poll()
            _worker_proc = None
            _worker_port = None
            log_file.close()
            return {
                "ok": False,
                "error": f"Worker failed to start (exit {code}). See {log_path / 'worker.log'}",
            }

        _save_state()
        return {
            "ok": True,
            "worker_port": port,
            "launcher_port": _launcher_port,
            "url": f"http://127.0.0.1:{_launcher_port}",
        }


def server_status() -> dict:
    ollama_ok = False
    try:
        with urllib.request.urlopen(f"{OLLAMA_BASE}/api/tags", timeout=3) as resp:
            ollama_ok = resp.status == 200
    except urllib.error.URLError:
        pass
    running = _worker_running()
    return {
        "ok": True,
        "launcher": True,
        "running": running,
        "launcher_port": _launcher_port,
        "worker_port": _worker_port if running else None,
        "url": f"http://127.0.0.1:{_launcher_port}",
        "ollama": OLLAMA_BASE,
        "ollama_ok": ollama_ok,
    }


class LauncherHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, fmt, *args):
        if args and isinstance(args[0], str) and args[0].startswith("GET /api/"):
            return
        super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    def _json(self, code: int, data: dict) -> None:
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_control(self, body: bytes = b"") -> bool:
        path = self.path.split("?", 1)[0]
        if path == "/api/server/status" and self.command == "GET":
            self._json(200, server_status())
            return True
        if path == "/api/server/start" and self.command == "POST":
            preferred = None
            if body:
                try:
                    preferred = json.loads(body).get("port")
                except json.JSONDecodeError:
                    pass
            result = start_worker(preferred_port=preferred)
            self._json(200 if result.get("ok") else 503, result)
            return True
        if path == "/api/shutdown" and self.command == "POST":
            result = stop_worker(unload_models=True)
            self._json(200, result)
            return True
        return False

    def _handle_chats_local(self, body: bytes = b"") -> bool:
        path = self.path.split("?", 1)[0]
        if path not in CHAT_PATHS:
            return False
        from server import load_chats_from_disk, save_chats_to_disk

        if self.command == "GET":
            self._json(200, load_chats_from_disk())
            return True
        if self.command in ("PUT", "POST"):
            try:
                payload = json.loads(body) if body else {}
            except json.JSONDecodeError:
                self._json(400, {"error": "Invalid JSON"})
                return True
            if not isinstance(payload.get("chats"), list):
                self._json(400, {"error": "Missing chats array"})
                return True
            try:
                save_chats_to_disk(payload)
                self._json(200, {"ok": True, "count": len(payload["chats"])})
            except OSError as e:
                self._json(500, {"error": f"Could not save chats: {e}"})
            return True
        return False

    def _proxy_to_worker(self, body: bytes = b"") -> bool:
        if not _worker_running() or not _worker_port:
            return False
        path = self.path
        conn = HTTPConnection("127.0.0.1", _worker_port, timeout=300)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "connection")}
        try:
            conn.request(self.command, path, body=body, headers=headers)
            resp = conn.getresponse()
            self.send_response(resp.status)
            for k, v in resp.getheaders():
                if k.lower() not in ("transfer-encoding", "connection"):
                    self.send_header(k, v)
            self.end_headers()
            while True:
                chunk = resp.read(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
            return True
        except OSError as e:
            self._json(502, {"error": f"Worker proxy failed: {e}"})
            return True
        finally:
            conn.close()

    def _api_unavailable(self) -> None:
        self._json(
            503,
            {
                "ok": False,
                "error": "Chat server is stopped. Click Start server in the sidebar.",
                "running": False,
            },
        )

    def do_GET(self):
        if self._handle_control():
            return
        if self.path.split("?", 1)[0].startswith("/api/"):
            if _worker_running():
                if self._proxy_to_worker():
                    return
            if self._handle_chats_local():
                return
            self._api_unavailable()
            return
        if self.path in ("/", ""):
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        body = self._read_body()
        if self._handle_control(body):
            return
        if self.path.split("?", 1)[0].startswith("/api/"):
            if _worker_running():
                if self._proxy_to_worker(body):
                    return
            if self._handle_chats_local(body):
                return
            self._api_unavailable()
            return
        self.send_error(404)

    def do_PUT(self):
        body = self._read_body()
        if self._handle_control(body):
            return
        if self.path.split("?", 1)[0].startswith("/api/"):
            if _worker_running():
                if self._proxy_to_worker(body):
                    return
            if self._handle_chats_local(body):
                return
            self._api_unavailable()
            return
        self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()


def _bind_launcher_port() -> int:
    global _launcher_port
    me = os.getpid()
    for port in range(LAUNCHER_PORT, min(LAUNCHER_PORT + 11, 8095)):
        pids = _pids_on_port(port)
        if pids and me not in pids:
            stale = True
            try:
                if _state_file().is_file():
                    state = json.loads(_state_file().read_text())
                    if state.get("launcher_pid") in pids:
                        stale = True
            except (json.JSONDecodeError, OSError):
                pass
            if stale:
                _kill_pids(pids, exclude={me})
                time.sleep(0.3)
        if _port_free(port):
            _launcher_port = port
            return port
    raise OSError(f"No free launcher port in {LAUNCHER_PORT}–{min(LAUNCHER_PORT + 10, 8094)}")


def main() -> None:
    global _http_server
    if not STATIC_DIR.is_dir():
        print(f"Missing static dir: {STATIC_DIR}", file=sys.stderr)
        sys.exit(1)

    port = _bind_launcher_port()
    _http_server = ThreadingHTTPServer(("127.0.0.1", port), LauncherHandler)

    print(f"Local Chat UI (launcher) →  http://127.0.0.1:{port}")
    print(f"Ollama backend          →  {OLLAMA_BASE}")

    result = start_worker()
    if result.get("ok"):
        print(f"Chat worker             →  http://127.0.0.1:{result.get('worker_port')} (proxied)")
    else:
        print(f"Worker not started      →  {result.get('error', 'unknown')}")
        print("Use **Start server** in the sidebar when ready.")

    _save_state()
    print("Stop / Start from the sidebar — launcher stays on this port.")

    def _exit(*_args):
        stop_worker(unload_models=False)
        if _http_server:
            _http_server.shutdown()

    signal.signal(signal.SIGINT, _exit)
    signal.signal(signal.SIGTERM, _exit)

    try:
        _http_server.serve_forever()
    except KeyboardInterrupt:
        _exit()
    finally:
        if _http_server:
            _http_server.server_close()


if __name__ == "__main__":
    main()
