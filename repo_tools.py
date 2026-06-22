"""Sandboxed filesystem tools for repo context and agent mode."""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

MAX_READ_BYTES = 120_000
MAX_GREP_MATCHES = 40
MAX_LIST_ENTRIES = 500
SKIP_DIRS = {
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    "target",
    ".idea",
    ".cursor",
}
SKIP_FILES = {".ds_store"}
TEXT_EXTENSIONS = {
    ".py",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".json",
    ".md",
    ".txt",
    ".html",
    ".css",
    ".scss",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".sql",
    ".sh",
    ".bash",
    ".zsh",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".swift",
    ".rb",
    ".php",
    ".c",
    ".h",
    ".cpp",
    ".hpp",
    ".vue",
    ".svelte",
    ".env",
    ".gitignore",
    ".dockerfile",
}
BINARY_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".pdf",
    ".zip",
    ".gz",
    ".wasm",
    ".bin",
    ".exe",
    ".dmg",
    ".mp4",
    ".mp3",
}

_repo_root: Path | None = None


def get_repo_root() -> Path | None:
    global _repo_root
    if _repo_root is not None:
        return _repo_root
    env = os.environ.get("CHAT_UI_REPO", "").strip()
    if env:
        p = Path(env).expanduser().resolve()
        if p.is_dir():
            _repo_root = p
            return _repo_root
    return None


def set_repo_root(path: str) -> Path:
    global _repo_root
    p = Path(path).expanduser().resolve()
    if not p.is_dir():
        raise ValueError(f"Not a directory: {p}")
    _repo_root = p
    return p


def resolve_repo_path(rel: str) -> Path:
    root = get_repo_root()
    if root is None:
        raise ValueError("No project folder set. Set CHAT_UI_REPO or pick a folder in the sidebar.")
    rel = rel.strip().lstrip("/")
    if not rel or rel in (".", "./"):
        return root
    candidate = (root / rel).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as e:
        raise ValueError(f"Path escapes project root: {rel}") from e
    return candidate


def _is_skipped_dir(name: str) -> bool:
    return name.lower() in SKIP_DIRS or name.startswith(".")


def list_tree(subpath: str = "", *, max_entries: int = MAX_LIST_ENTRIES) -> list[dict]:
    base = resolve_repo_path(subpath)
    if not base.is_dir():
        raise ValueError(f"Not a directory: {subpath or '.'}")
    root = get_repo_root()
    entries: list[dict] = []

    def walk(directory: Path, prefix: str) -> None:
        nonlocal entries
        if len(entries) >= max_entries:
            return
        try:
            children = sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return
        for child in children:
            if len(entries) >= max_entries:
                break
            if child.is_dir():
                if _is_skipped_dir(child.name):
                    continue
                rel = f"{prefix}{child.name}/" if prefix else f"{child.name}/"
                entries.append({"path": rel, "type": "dir"})
                walk(child, rel)
            else:
                if child.name.lower() in SKIP_FILES:
                    continue
                if child.suffix.lower() in BINARY_EXTENSIONS:
                    continue
                rel = f"{prefix}{child.name}" if prefix else child.name
                entries.append({"path": rel, "type": "file", "size": child.stat().st_size})

    walk(base, "")
    return entries


def read_file(rel: str, *, max_bytes: int = MAX_READ_BYTES) -> dict:
    path = resolve_repo_path(rel)
    if not path.is_file():
        raise ValueError(f"Not a file: {rel}")
    if path.suffix.lower() in BINARY_EXTENSIONS:
        raise ValueError(f"Refusing to read binary file: {rel}")
    size = path.stat().st_size
    truncated = size > max_bytes
    data = path.read_bytes()[:max_bytes]
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError(f"Not a UTF-8 text file: {rel}") from None
    return {
        "path": rel,
        "content": text,
        "size": size,
        "truncated": truncated,
    }


def grep_repo(pattern: str, subpath: str = "", *, max_matches: int = MAX_GREP_MATCHES) -> list[dict]:
    if not pattern.strip():
        raise ValueError("Empty search pattern")
    base = resolve_repo_path(subpath) if subpath else get_repo_root()
    if base is None:
        raise ValueError("No project folder set")
    root = get_repo_root()
    assert root is not None

    try:
        proc = subprocess.run(
            [
                "rg",
                "--json",
                "-m",
                str(max_matches),
                "--glob",
                "!.git/*",
                "--glob",
                "!node_modules/*",
                "--glob",
                "!__pycache__/*",
                "--glob",
                "!.venv/*",
                pattern,
                str(base),
            ],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return _grep_python(pattern, base, root, max_matches)

    matches: list[dict] = []
    for line in proc.stdout.splitlines():
        if len(matches) >= max_matches:
            break
        try:
            row = __import__("json").loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("type") != "match":
            continue
        data = row.get("data", {})
        fpath = Path(data.get("path", {}).get("text", ""))
        try:
            rel = str(fpath.resolve().relative_to(root))
        except ValueError:
            rel = fpath.name
        line_no = data.get("line_number")
        text = data.get("lines", {}).get("text", "").rstrip("\n")
        matches.append({"path": rel, "line": line_no, "text": text})
    return matches


def _grep_python(pattern: str, base: Path, root: Path, max_matches: int) -> list[dict]:
    rx = re.compile(pattern)
    matches: list[dict] = []
    for path in base.rglob("*"):
        if len(matches) >= max_matches:
            break
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.suffix.lower() in BINARY_EXTENSIONS:
            continue
        try:
            rel = str(path.relative_to(root))
            lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue
        for i, line in enumerate(lines, 1):
            if len(matches) >= max_matches:
                break
            if rx.search(line):
                matches.append({"path": rel, "line": i, "text": line.strip()[:200]})
    return matches


def write_file(rel: str, content: str) -> dict:
    path = resolve_repo_path(rel)
    if path.is_dir():
        raise ValueError(f"Path is a directory: {rel}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return {"path": rel, "bytes": len(content.encode("utf-8")), "ok": True}


def parse_file_refs(text: str) -> list[str]:
    refs: list[str] = []
    for m in re.finditer(r"@([\w./\-]+(?:\.\w+)?)", text):
        ref = m.group(1).strip()
        if ref and ref not in refs:
            refs.append(ref)
    return refs


def load_file_context(text: str, *, max_files: int = 6, max_bytes: int = 24_000) -> str:
    root = get_repo_root()
    if not root:
        return ""
    refs = parse_file_refs(text)
    if refs:
        return _load_refs(refs, max_files=max_files, max_bytes=max_bytes)
    return ""


def _load_refs(refs: list[str], *, max_files: int, max_bytes: int) -> str:
    blocks: list[str] = []
    for ref in refs[:max_files]:
        try:
            data = read_file(ref, max_bytes=max_bytes)
            note = " (truncated)" if data["truncated"] else ""
            blocks.append(f"--- {ref}{note} ---\n{data['content']}")
        except ValueError as e:
            blocks.append(f"--- {ref} ---\n(could not read: {e})")
    if not blocks:
        return ""
    return "Attached files from the project:\n\n" + "\n\n".join(blocks)


_STOP_WORDS = frozenset(
    "a an the is are was were be been being have has had do does did will would could "
    "should may might must shall can need want how what when where why who which this "
    "that these those with from into your our their for and or but not about please help "
    "me my i we you it its".split()
)


def _search_terms(query: str) -> list[str]:
    terms: list[str] = []
    for m in re.finditer(r"[A-Za-z_][\w.-]{2,}", query):
        t = m.group(0)
        if t.lower() in _STOP_WORDS:
            continue
        if t not in terms:
            terms.append(t)
    return terms[:6]


def auto_gather_context(query: str, *, max_files: int = 4, max_bytes: int = 16_000) -> str:
    """Find relevant project files from the question — no @refs needed."""
    root = get_repo_root()
    if not root or not query.strip():
        return ""
    parts: list[str] = []
    try:
        entries = list_tree("", max_entries=50)
        sample = [e["path"] for e in entries if e["type"] == "file"][:30]
        if sample:
            parts.append("Project structure (sample):\n" + "\n".join(sample))
    except ValueError:
        pass

    file_scores: dict[str, int] = {}
    for term in _search_terms(query):
        try:
            for m in grep_repo(re.escape(term), max_matches=12):
                file_scores[m["path"]] = file_scores.get(m["path"], 0) + 1
        except ValueError:
            continue

    ranked = sorted(file_scores.items(), key=lambda x: -x[1])
    if ranked:
        parts.append("Likely relevant files: " + ", ".join(p for p, _ in ranked[:8]))

    to_read = [p for p, _ in ranked[:max_files]]
    if not to_read:
        # Fallback: common entry points
        for guess in ("README.md", "server.py", "package.json", "src/main.py", "app.js", "index.ts"):
            try:
                if resolve_repo_path(guess).is_file():
                    to_read.append(guess)
                    break
            except ValueError:
                continue

    if to_read:
        parts.append(_load_refs(to_read, max_files=max_files, max_bytes=max_bytes))

    if not parts:
        return ""
    return "Auto-gathered project context:\n\n" + "\n\n".join(parts)
