"""Extract text from uploaded attachments — stdlib-first, OS tools as fallback."""

from __future__ import annotations

import io
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

MAX_PARSE_BYTES = 2 * 1024 * 1024
MAX_TEXT_CHARS = 48_000

# Office + PDF — parsed server-side
DOCUMENT_EXTENSIONS = {
    ".pdf",
    ".doc",
    ".docx",
    ".rtf",
    ".odt",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
}

# Hard block — not parsed
BLOCKED_EXTENSIONS = {
    ".zip", ".gz", ".bz2", ".xz", ".7z", ".rar", ".tar",
    ".exe", ".dll", ".dmg", ".pkg", ".deb", ".rpm", ".msi",
    ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".flac",
    ".wasm", ".bin", ".iso", ".img",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".pyc", ".pyo", ".class", ".o", ".so", ".dylib", ".a",
    ".apk", ".ipa",
}


def is_blocked_extension(name: str) -> bool:
    ext = Path(name).suffix.lower()
    return ext in BLOCKED_EXTENSIONS


def needs_server_parse(name: str) -> bool:
    ext = Path(name).suffix.lower()
    return ext in DOCUMENT_EXTENSIONS


def _clip(text: str) -> tuple[str, bool]:
    text = text.replace("\x00", "").strip()
    if len(text) <= MAX_TEXT_CHARS:
        return text, False
    return text[:MAX_TEXT_CHARS].rsplit("\n", 1)[0] + "\n…", True


def _xml_text(blob: bytes) -> str:
    raw = blob.decode("utf-8", errors="replace")
    raw = re.sub(r"</w:p>", "\n", raw)
    raw = re.sub(r"</a:p>", "\n", raw)
    raw = re.sub(r"<[^>]+>", " ", raw)
    raw = re.sub(r"[ \t]+", " ", raw)
    raw = re.sub(r"\n{3,}", "\n\n", raw)
    return raw.strip()


def _ooxml_zip_text(data: bytes, member_pattern: re.Pattern[str]) -> str:
    parts: list[str] = []
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for name in sorted(zf.namelist()):
            if not member_pattern.search(name):
                continue
            try:
                parts.append(_xml_text(zf.read(name)))
            except (KeyError, zipfile.BadZipFile, UnicodeDecodeError):
                continue
    return "\n\n".join(p for p in parts if p.strip())


def _parse_docx(data: bytes) -> str:
    text = _ooxml_zip_text(data, re.compile(r"^word/document\.xml$"))
    if text:
        return text
    raise ValueError("Could not read DOCX content")


def _parse_xlsx(data: bytes) -> str:
    chunks: list[str] = []
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        if "xl/sharedStrings.xml" in zf.namelist():
            chunks.append(_xml_text(zf.read("xl/sharedStrings.xml")))
        chunks.append(_ooxml_zip_text(data, re.compile(r"^xl/worksheets/sheet\d+\.xml$")))
    text = "\n".join(c for c in chunks if c.strip())
    if text:
        return text
    raise ValueError("Could not read XLSX content")


def _parse_pptx(data: bytes) -> str:
    text = _ooxml_zip_text(data, re.compile(r"^ppt/slides/slide\d+\.xml$"))
    if text:
        return text
    raise ValueError("Could not read PPTX content")


def _parse_with_textutil(data: bytes, suffix: str) -> str:
    if sys.platform != "darwin":
        raise ValueError("Legacy .doc/.rtf requires macOS textutil")
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(data)
        tmp.flush()
        proc = subprocess.run(
            ["textutil", "-stdout", "-convert", "txt", tmp.name],
            capture_output=True,
            text=True,
            timeout=45,
        )
    if proc.returncode != 0 or not proc.stdout.strip():
        raise ValueError(proc.stderr.strip() or "textutil failed")
    return proc.stdout


def _parse_pdf(data: bytes) -> tuple[str, str]:
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=True) as tmp:
        tmp.write(data)
        tmp.flush()
        try:
            proc = subprocess.run(
                ["pdftotext", "-layout", tmp.name, "-"],
                capture_output=True,
                text=True,
                timeout=60,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                return proc.stdout, "pdf-pdftotext"
        except FileNotFoundError:
            pass

    try:
        import pypdf  # type: ignore

        reader = pypdf.PdfReader(io.BytesIO(data))
        pages = [page.extract_text() or "" for page in reader.pages]
        text = "\n".join(pages).strip()
        if text:
            return text, "pdf-pypdf"
    except ImportError:
        pass
    except Exception as e:
        raise ValueError(f"PDF parse failed: {e}") from e

    raise ValueError(
        "PDF support not installed. Run: ./setup.sh  (or: brew install poppler / pip install pypdf)"
    )


def extract_text(filename: str, data: bytes) -> dict:
    """Extract plain text from file bytes. Raises ValueError on failure."""
    if len(data) > MAX_PARSE_BYTES:
        raise ValueError(f"File too large (max {MAX_PARSE_BYTES // 1024} KB)")
    if is_blocked_extension(filename):
        raise ValueError(f"Unsupported file type: {Path(filename).suffix}")

    ext = Path(filename).suffix.lower()
    parser = "text"

    if ext == ".pdf":
        text, parser = _parse_pdf(data)
    elif ext == ".docx":
        text, parser = _parse_docx(data), "docx"
    elif ext == ".xlsx":
        text, parser = _parse_xlsx(data), "xlsx"
    elif ext == ".pptx":
        text, parser = _parse_pptx(data), "pptx"
    elif ext in {".doc", ".rtf", ".odt", ".xls", ".ppt"}:
        text, parser = _parse_with_textutil(data, ext), f"textutil{ext}"
    else:
        text = data.decode("utf-8", errors="replace")
        if _looks_binary(text):
            raise ValueError("File looks binary — not readable as text")
        parser = "utf8"

    text, truncated = _clip(text)
    if not text.strip():
        raise ValueError("No readable text found in file")
    return {"text": text, "truncated": truncated, "parser": parser}


def _looks_binary(text: str) -> bool:
    sample = text[:12_000]
    if not sample:
        return True
    control = sum(
        1 for c in sample if c == "\x00" or (ord(c) < 32 and c not in "\t\n\r")
    )
    return control / len(sample) > 0.03
