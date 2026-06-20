"""Web search helpers for local chat — stdlib only, no API keys."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from html import unescape
from urllib.parse import quote, unquote

USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) LocalChat/1.0"

CURRENCY_ALIASES = {
    "usd": "USD", "dollar": "USD", "dollars": "USD", "us dollar": "USD",
    "inr": "INR", "rupee": "INR", "rupees": "INR", "indian rupee": "INR",
    "eur": "EUR", "euro": "EUR", "euros": "EUR",
    "gbp": "GBP", "pound": "GBP", "pounds": "GBP", "sterling": "GBP",
    "jpy": "JPY", "yen": "JPY",
    "cad": "CAD", "aud": "AUD", "chf": "CHF", "cny": "CNY", "yuan": "CNY",
}

FX_PATTERN = re.compile(
    r"(?i)\b("
    + "|".join(re.escape(k) for k in sorted(CURRENCY_ALIASES, key=len, reverse=True))
    + r")\b"
)

ISO_CURRENCIES = {"USD", "INR", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "SGD", "NZD", "HKD"}


def detect_fx_pair(query: str) -> tuple[str, str] | None:
    """Return (from, to) ISO codes if query looks like a currency conversion."""
    q = query.lower()
    codes: list[str] = []

    for alias, code in sorted(CURRENCY_ALIASES.items(), key=lambda x: -len(x[0])):
        if re.search(rf"\b{re.escape(alias)}\b", q) and code not in codes:
            codes.append(code)

    for m in re.finditer(r"\b([A-Z]{3})\b", query.upper()):
        c = m.group(1)
        if c in ISO_CURRENCIES and c not in codes:
            codes.append(c)

    if len(codes) >= 2:
        return codes[0], codes[1]
    return None


def _fetch_json(url: str, timeout: int = 12) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def fetch_exchange_rate(from_ccy: str, to_ccy: str) -> dict:
    """Live FX via open.er-api.com (no API key)."""
    data = _fetch_json(f"https://open.er-api.com/v6/latest/{from_ccy.upper()}")
    rate = data.get("rates", {}).get(to_ccy.upper())
    if rate is None:
        raise ValueError(f"No rate for {from_ccy}/{to_ccy}")
    return {
        "from": from_ccy.upper(),
        "to": to_ccy.upper(),
        "rate": rate,
        "source": "open.er-api.com",
        "updated": data.get("time_last_update_utc", "recently"),
    }


def format_fx_answer(fx: dict) -> str:
    r = fx["rate"]
    return (
        f"**Live exchange rate** (via {fx['source']}, updated {fx['updated']}):\n\n"
        f"**1 {fx['from']} = {r:.4f} {fx['to']}**\n\n"
        f"Inverse: 1 {fx['to']} = {1 / r:.6f} {fx['from']}"
    )


def search_duckduckgo(query: str, max_results: int = 5) -> list[dict]:
    """Scrape DuckDuckGo Lite HTML — no API key."""
    url = f"https://lite.duckduckgo.com/lite/?q={quote(query)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as resp:
        html = unescape(resp.read().decode("utf-8", errors="replace"))

    rows = html.split("<tr")
    results: list[dict] = []
    i = 0
    while i < len(rows) - 2 and len(results) < max_results:
        chunk = rows[i]
        if 'rel="nofollow"' not in chunk:
            i += 1
            continue
        link_m = re.search(r'rel="nofollow" href="([^"]+)"[^>]*>([^<]+)', chunk)
        if not link_m:
            i += 1
            continue
        title = re.sub(r"\s+", " ", link_m.group(2)).strip()
        href = link_m.group(1)
        snippet = ""
        if i + 1 < len(rows):
            snippet_raw = re.sub(r"<[^>]+>", " ", rows[i + 1])
            snippet = re.sub(r"\s+", " ", snippet_raw).strip()
        if title and not title.startswith("Next"):
            results.append({"title": title, "snippet": snippet[:400], "url": href})
        i += 1
    return results


def build_web_context(query: str) -> tuple[str, str | None, list[dict]]:
    """
    Returns (context_for_llm, direct_answer_or_none, sources).
    direct_answer is set for high-confidence FX queries.
    """
    sources: list[dict] = []

    pair = detect_fx_pair(query)
    if pair:
        from_c, to_c = pair
        try:
            fx = fetch_exchange_rate(from_c, to_c)
            sources.append({"title": f"Live FX: {from_c}/{to_c}", "snippet": format_fx_answer(fx), "url": "https://open.er-api.com"})
            fx_block = format_fx_answer(fx)
            if re.search(r"(?i)\b(current|today|now|live|what'?s|what is)\b", query):
                return fx_block, fx_block, sources
            fx_block = f"Live exchange rate data:\n{fx_block}"
        except (urllib.error.URLError, ValueError, KeyError) as e:
            fx_block = f"(FX lookup failed: {e})"
    else:
        fx_block = ""

    try:
        results = search_duckduckgo(query, max_results=5)
        sources.extend(results)
    except urllib.error.URLError as e:
        results = []
        if not fx_block:
            return f"Web search failed: {e}", None, sources

    if not results and fx_block:
        return fx_block, fx_block if "Live exchange rate" in fx_block else None, sources

    lines = ["Web search results (use these — they are more current than your training data):"]
    if fx_block:
        lines.append(fx_block)
        lines.append("")
    for n, r in enumerate(results, 1):
        lines.append(f"{n}. {r['title']}")
        if r.get("snippet"):
            lines.append(f"   {r['snippet']}")
    context = "\n".join(lines)
    return context, None, sources
