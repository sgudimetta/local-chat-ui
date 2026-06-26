"""macOS-friendly memory + Ollama VRAM monitoring (stdlib only)."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

OLLAMA_BASE = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")


def _run(cmd: list[str], timeout: int = 5) -> str | None:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
        if out.returncode != 0:
            return None
        return out.stdout
    except (OSError, subprocess.SubprocessError):
        return None


def total_ram_gb() -> float | None:
    if sys.platform == "darwin":
        raw = _run(["sysctl", "-n", "hw.memsize"])
        if raw:
            try:
                return int(raw.strip()) / (1024**3)
            except ValueError:
                pass
    try:
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    kb = int(line.split()[1])
                    return kb / (1024**2)
    except OSError:
        pass
    return None


def _page_size() -> int:
    if sys.platform == "darwin":
        raw = _run(["sysctl", "-n", "hw.pagesize"])
        if raw:
            try:
                return int(raw.strip())
            except ValueError:
                pass
    return 4096


def _vm_stat_pages() -> dict[str, int]:
    text = _run(["vm_stat"]) if sys.platform == "darwin" else None
    if not text:
        return {}
    pages: dict[str, int] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, val = line.split(":", 1)
        m = re.search(r"(\d+)", val.replace(".", ""))
        if m:
            pages[key.strip()] = int(m.group(1))
    return pages


def _memory_pressure_free_pct() -> float | None:
    text = _run(["memory_pressure"]) if sys.platform == "darwin" else None
    if not text:
        return None
    m = re.search(r"free percentage:\s*(\d+)%", text, re.I)
    if m:
        return float(m.group(1))
    return None


def memory_snapshot() -> dict:
    total = total_ram_gb()
    page_size = _page_size()
    pages = _vm_stat_pages()

    free_gb: float | None = None
    used_gb: float | None = None
    used_pct: float | None = None

    if total and pages:
        free_pages = pages.get("Pages free", 0) + pages.get("Pages speculative", 0)
        wired = pages.get("Pages wired down", 0)
        active = pages.get("Pages active", 0)
        compressed = pages.get("Pages occupied by compressor", 0)
        free_gb = free_pages * page_size / (1024**3)
        used_gb = (wired + active + compressed) * page_size / (1024**3)
        used_gb = min(used_gb, total)
        used_pct = round(100 * used_gb / total, 1) if total else None

    pressure_free = _memory_pressure_free_pct()
    if pressure_free is not None and total:
        # macOS reports system-wide free % — derive used when vm_stat unavailable
        if used_pct is None:
            used_pct = round(100 - pressure_free, 1)
            used_gb = total * used_pct / 100
            free_gb = total - used_gb

    return {
        "total_gb": round(total, 1) if total else None,
        "used_gb": round(used_gb, 1) if used_gb is not None else None,
        "free_gb": round(free_gb, 1) if free_gb is not None else None,
        "used_pct": used_pct,
        "pressure_free_pct": pressure_free,
    }


def ollama_loaded_models() -> list[dict]:
    url = f"{OLLAMA_BASE}/api/ps"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "LocalChat/1.0"})
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.loads(resp.read())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return []
    out: list[dict] = []
    for m in data.get("models") or []:
        name = m.get("name") or m.get("model")
        if not name:
            continue
        vram = m.get("size_vram") or m.get("size") or 0
        out.append(
            {
                "name": name,
                "size_vram_bytes": int(vram),
                "size_vram_gb": round(int(vram) / (1024**3), 2),
            }
        )
    return out


def _ram_tier(total_gb: float | None) -> str:
    if not total_gb:
        return "normal"
    if total_gb <= 8.5:
        return "tiny"
    if total_gb <= 16.5:
        return "low"
    return "normal"


def assess_pressure(mem: dict, ollama_vram_gb: float) -> dict:
    total = mem.get("total_gb") or 0
    used_pct = mem.get("used_pct")
    free_gb = mem.get("free_gb")
    pressure_free = mem.get("pressure_free_pct")
    tier = _ram_tier(total)

    # Stricter thresholds on 8 GB and 16 GB Macs (Cursor + Ollama share RAM)
    if tier == "tiny":
        model_frac_warn, used_warn, used_crit = 0.32, 72, 82
        free_crit, pressure_crit = 0.7, 24
    elif tier == "low":
        model_frac_warn, used_warn, used_crit = 0.40, 78, 88
        free_crit, pressure_crit = 1.0, 20
    else:
        model_frac_warn, used_warn, used_crit = 0.45, 82, 90
        free_crit, pressure_crit = 1.2, 18

    level = "normal"
    message = "Memory looks fine."
    should_unload = False
    tier_note = f" ({int(total)} GB Mac)" if tier != "normal" and total else ""

    if total and ollama_vram_gb >= total * model_frac_warn:
        level = "warn"
        message = (
            f"Model using ~{ollama_vram_gb:.1f} GB of {total:.0f} GB RAM{tier_note} — "
            "Cursor may feel sluggish."
        )

    if used_pct is not None and used_pct >= used_warn:
        level = "warn"
        message = f"System RAM ~{used_pct:.0f}% used{tier_note} — consider freeing the model."

    if pressure_free is not None and pressure_free <= pressure_crit:
        level = "critical"
        message = f"Memory pressure high ({pressure_free:.0f}% free){tier_note} — free model RAM."
        should_unload = True

    if used_pct is not None and used_pct >= used_crit:
        level = "critical"
        message = f"System RAM ~{used_pct:.0f}% full{tier_note} — free model RAM for Cursor."
        should_unload = True

    if free_gb is not None and free_gb < free_crit and ollama_vram_gb > 0:
        level = "critical"
        message = f"Only ~{free_gb:.1f} GB free with model loaded{tier_note} — system may choke."
        should_unload = True

    return {"level": level, "message": message, "should_unload": should_unload, "ram_tier": tier}


def build_system_snapshot() -> dict:
    mem = memory_snapshot()
    models = ollama_loaded_models()
    ollama_vram_gb = round(sum(m["size_vram_gb"] for m in models), 2)
    pressure = assess_pressure(mem, ollama_vram_gb)
    return {
        "ok": True,
        "ram_gb": mem.get("total_gb"),
        "ram_used_gb": mem.get("used_gb"),
        "ram_free_gb": mem.get("free_gb"),
        "ram_used_pct": mem.get("used_pct"),
        "memory_pressure": pressure["level"],
        "memory_message": pressure["message"],
        "should_unload": pressure["should_unload"],
        "ram_tier": pressure["ram_tier"],
        "ollama_models": models,
        "ollama_vram_gb": ollama_vram_gb,
        "ollama_ok": bool(_ollama_reachable()),
    }


def _ollama_reachable() -> bool:
    try:
        req = urllib.request.Request(f"{OLLAMA_BASE}/api/tags", headers={"User-Agent": "LocalChat/1.0"})
        with urllib.request.urlopen(req, timeout=2) as resp:
            return resp.status == 200
    except urllib.error.URLError:
        return False
