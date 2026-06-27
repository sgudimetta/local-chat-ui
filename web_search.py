"""Web search helpers for local chat — stdlib only, no API keys."""

from __future__ import annotations

import json
import re
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from html import unescape
from urllib.parse import quote, unquote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) LocalChat/1.0"
CACHE_TTL_SECONDS = 120

CURRENCY_ALIASES = {
    "usd": "USD", "dollar": "USD", "dollars": "USD", "us dollar": "USD",
    "inr": "INR", "rupee": "INR", "rupees": "INR", "indian rupee": "INR",
    "eur": "EUR", "euro": "EUR", "euros": "EUR",
    "gbp": "GBP", "pound": "GBP", "pounds": "GBP", "sterling": "GBP",
    "jpy": "JPY", "yen": "JPY",
    "cad": "CAD", "aud": "AUD", "chf": "CHF", "cny": "CNY", "yuan": "CNY",
}

ISO_CURRENCIES = {"USD", "INR", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "SGD", "NZD", "HKD"}

CRYPTO_IDS = {
    "bitcoin": "bitcoin", "btc": "bitcoin",
    "ethereum": "ethereum", "eth": "ethereum",
    "solana": "solana", "sol": "solana",
    "dogecoin": "dogecoin", "doge": "dogecoin",
    "ripple": "ripple", "xrp": "ripple",
    "cardano": "cardano", "ada": "cardano",
    "litecoin": "litecoin", "ltc": "litecoin",
    "polkadot": "polkadot", "dot": "polkadot",
}

TZ_ALIASES = {
    "utc": "UTC", "gmt": "UTC",
    "est": "America/New_York", "edt": "America/New_York",
    "cst": "America/Chicago", "cdt": "America/Chicago",
    "mst": "America/Denver", "mdt": "America/Denver",
    "pst": "America/Los_Angeles", "pdt": "America/Los_Angeles",
    "ist": "Asia/Kolkata", "india": "Asia/Kolkata",
    "jst": "Asia/Tokyo", "tokyo": "Asia/Tokyo", "japan": "Asia/Tokyo",
    "kst": "Asia/Seoul", "seoul": "Asia/Seoul", "korea": "Asia/Seoul",
    "cet": "Europe/Paris", "paris": "Europe/Paris", "france": "Europe/Paris",
    "bst": "Europe/London", "london": "Europe/London", "uk": "Europe/London",
    "aest": "Australia/Sydney", "sydney": "Australia/Sydney",
    "dubai": "Asia/Dubai", "uae": "Asia/Dubai",
    "singapore": "Asia/Singapore", "sgt": "Asia/Singapore",
    "hong kong": "Asia/Hong_Kong", "hkt": "Asia/Hong_Kong",
    "beijing": "Asia/Shanghai", "shanghai": "Asia/Shanghai", "china": "Asia/Shanghai",
    "berlin": "Europe/Berlin", "germany": "Europe/Berlin",
    "moscow": "Europe/Moscow", "russia": "Europe/Moscow",
    "brazil": "America/Sao_Paulo", "sao paulo": "America/Sao_Paulo",
    "mexico city": "America/Mexico_City", "mexico": "America/Mexico_City",
    "toronto": "America/Toronto", "canada eastern": "America/Toronto",
    "vancouver": "America/Vancouver",
    "new york": "America/New_York", "nyc": "America/New_York",
    "los angeles": "America/Los_Angeles", "la": "America/Los_Angeles",
    "chicago": "America/Chicago",
    "denver": "America/Denver",
    "honolulu": "Pacific/Honolulu", "hawaii": "Pacific/Honolulu",
}

WMO_WEATHER = {
    0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Depositing rime fog", 51: "Light drizzle", 53: "Drizzle",
    55: "Dense drizzle", 61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
    80: "Rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
    95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
}

ESPN_LEAGUES = (
    {"pattern": re.compile(r"(?i)\b(f1|formula\s*one|formula\s*1|grand\s*prix)\b"), "sport": "racing", "league": "f1", "label": "Formula 1", "racing": True},
    {"pattern": re.compile(r"(?i)\b(fifa|world\s*cup|worldcup)\b"), "sport": "soccer", "league": "fifa.world", "label": "FIFA World Cup"},
    {"pattern": re.compile(r"(?i)\b(nfl|super\s*bowl|superbowl)\b"), "sport": "football", "league": "nfl", "label": "NFL"},
    {"pattern": re.compile(r"(?i)\b(nba|basketball)\b"), "sport": "basketball", "league": "nba", "label": "NBA"},
    {"pattern": re.compile(r"(?i)\b(mlb|baseball)\b"), "sport": "baseball", "league": "mlb", "label": "MLB"},
    {"pattern": re.compile(r"(?i)\b(premier\s*league|epl|english\s+premier)\b"), "sport": "soccer", "league": "eng.1", "label": "Premier League"},
    {"pattern": re.compile(r"(?i)\b(ipl|indian premier league)\b"), "sport": "cricket", "league": "8048", "label": "IPL"},
    {"pattern": re.compile(r"(?i)\b(college\s*football|ncaa\s*football|cfb)\b"), "sport": "football", "league": "college-football", "label": "College Football"},
)

SPORTS_LIVE_PATTERN = re.compile(
    r"(?i)\b("
    r"next|upcoming|schedule|fixture|when|where|today|tonight|live|score|scores|"
    r"who won|kickoff|kick off|game|match|race|grand\s*prix|"
    r"series|tour|playing|ongoing|current"
    r")\b"
)

TEMPORAL_QUERY_PATTERN = re.compile(
    r"(?i)\b(current|ongoing|latest|today|now|this week|this month|right now|"
    r"upcoming|next|schedule|who won|playing|score|standings|tour|series)\b"
)

QUESTION_PREFIX = re.compile(
    r"(?i)^(?:what(?:'s| is)|who(?:'s| is)|when(?:'s| is)|where(?:'s| is)|"
    r"how many|how much|tell me about|is there|are there)\s+"
)

TIME_PATTERN = re.compile(
    r"(?i)(?:\b(?:what(?:'s|\s+is)\s+)?(?:the\s+)?time(?:\s+is\s+it)?\s*(?:in|at|for)?\s*([a-zA-Z /]+?)(?:\?|$)|"
    r"\btime\s+in\s+([a-zA-Z /]+?)(?:\?|$))"
)

WEATHER_PATTERN = re.compile(
    r"(?i)\b(?:weather|forecast|temperature|rain|snow|humidity|wind)\b"
)

CRYPTO_PATTERN = re.compile(
    r"(?i)\b("
    + "|".join(re.escape(k) for k in sorted(CRYPTO_IDS, key=len, reverse=True))
    + r"|crypto|cryptocurrency)\b"
)

WIKI_PATTERN = re.compile(
    r"(?i)^(?:who is|who's|what is|what's|tell me about)\s+(.+?)(?:\?|$)"
)

DIRECT_INTENT = re.compile(
    r"(?i)\b(current|today|now|live|right now|what'?s|what is|how much|price|"
    r"next|upcoming|when|where|forecast|score|time in|time is it)\b"
)

FORCE_SEARCH_PREFIX = re.compile(r"(?i)^/search\s+")

LOCAL_ONLY_PATTERN = re.compile(
    r"(?i)\b(explain|why\s+(?:is|are|do|does|did)|how\s+(?:do|does|can|to)|help me understand|"
    r"what(?:'s| is) the difference|compare|pros and cons|draft|write|compose|rewrite|joke|"
    r"brainstorm|summarize|summary|translate|debug|teach me|walk me through|recommend|suggest)\b"
)

CONVERSATIONAL_ONLY_PATTERN = re.compile(
    r"(?i)^(?:"
    r"(?:thanks?(?:\s+(?:a\s+lot|so\s+much|very\s+much))?|thank\s+you(?:\s+so\s+much|\s+very\s+much)?|"
    r"thx|ty|cheers|much\s+appreciated|appreciate\s+it)|"
    r"(?:that(?:'s| is)\s+(?:helpful|great|perfect|awesome|good|useful))|"
    r"(?:ok(?:ay)?|k|cool|nice|great|perfect|got\s+it|understood|makes\s+sense|sounds\s+good|"
    r"will\s+do|noted|awesome|lovely|brilliant)|"
    r"(?:hello|hi|hey|yo|good\s+(?:morning|afternoon|evening|night))|"
    r"(?:how\s+(?:are\s+you|you\s+doing|goes\s+it))|"
    r"(?:bye|goodbye|see\s+(?:you|ya)|take\s+care|later)|"
    r"(?:yes|no|yep|nope|sure)|"
    r"(?:can\s+you\s+)?(?:elaborate|explain\s+more|tell\s+me\s+more|go\s+on|continue|more\s+detail|"
    r"expand(?:\s+on\s+that)?|say\s+more)"
    r")(?:[!.?\s,]*)*$"
)

FACTUAL_QUERY_PATTERN = re.compile(
    r"(?i)\b(who|what|when|where|which|how many|how much|tell me|give me)\b|"
    r"\b(when is|what is|what's|who is|who's|where is|how old|next|upcoming|"
    r"latest|current|today|tonight|schedule|fixture|price|cost|score|standings|"
    r"release date|who won|how tall|population of|capital of)\b|"
    r"\b(odi|test|t20(?:i)?|first[- ]class|list a)\b.*\b(stats|statistics|runs|average|centuries|record)\b|"
    r"\b(stats|statistics|batting|bowling)\b.*\b(odi|test|t20(?:i)?|cricket)\b"
)

CRICKET_FORMAT_ALIASES = {
    "test": "test",
    "tests": "test",
    "odi": "odi",
    "odis": "odi",
    "one day": "odi",
    "one-day": "odi",
    "t20": "t20i",
    "t20i": "t20i",
    "twenty20": "t20i",
    "fc": "fc",
    "first class": "fc",
    "first-class": "fc",
    "firstclass": "fc",
    "la": "la",
    "list a": "la",
    "list-a": "la",
}

CRICKET_FORMAT_SUFFIX = {
    "test": "1",
    "odi": "2",
    "fc": "3",
    "la": "4",
}

CRICKET_FORMAT_LABEL = {
    "test": "Test",
    "odi": "ODI",
    "fc": "First-class",
    "la": "List A",
    "t20i": "T20I",
}

CRICKET_STATS_QUERY = re.compile(
    r"(?i)(?:"
    r"(?:give me\s+)?(test|odi|odis|t20(?:i)?|first[- ]?class|fc|list[- ]?a)\s+"
    r"(?:stats|statistics|batting(?: stats)?|bowling(?: stats)?|career(?: stats)?|numbers?|record)\s+"
    r"(?:of|for)\s+(.+?)(?:\?|$)"
    r"|(.+?)(?:'s|')\s+(test|odi|odis|t20(?:i)?|first[- ]?class|fc|list[- ]?a)\s+"
    r"(?:stats|statistics|batting|bowling|career|average|runs|record)"
    r"|(test|odi|odis|t20(?:i)?|first[- ]?class|fc|list[- ]?a)\s+stats?\s+(?:of|for)\s+(.+?)(?:\?|$)"
    r"|how many\s+(test|odi|odis|t20(?:i)?)\s+(?:runs|centuries|matches|wickets)\s+"
    r"(?:did|has|have)\s+(.+?)(?:\s+(?:score|get|take))?(?:\?|$)"
    r")"
)

LIVE_REQUIRED_PATTERN = re.compile(
    r"(?i)\b(current|today'?s?|latest|right now|as of now|as of today|this week|this month|live)\b|"
    r"\b(weather|forecast|temperature)\b.*\b(today|tomorrow|now|in\s+\w)|"
    r"\b(weather|forecast)\s+(?:in|for|at)\s+|"
    r"\b(exchange rate|forex|usd\s*to|eur\s*to|inr\s*to|gbp\s*to)\b|"
    r"\b(bitcoin|ethereum|crypto|btc|eth)\s*(price|cost|worth)?\b|"
    r"\b(what time is it|time in\s+)\b|"
    r"\b(who won|final score|live score)\b|"
    r"\b(next\s+(?:game|match|fixture|race|grand\s*prix)|upcoming\s+(?:game|match|race))\b|"
    r"\b(f1|formula\s*one|formula\s*1|grand\s*prix)\b.*\b(next|schedule|when|where|today|live|race)\b|"
    r"\b(world\s*cup|worldcup|fifa|nfl|nba|mlb)\b.*\b(next|schedule|score|today|live)\b|"
    r"\b(cricket|ipl|t20|odi)\b.*\b(series|tour|schedule|current|ongoing|playing|match)\b|"
    r"\b(india|indian|team india)\b.*\b(cricket|series|tour|schedule|playing)\b|"
    r"\b(look up online|search the web|search online|find online|check online)\b"
)

VERIFY_FACTS_PATTERN = re.compile(
    r"(?i)"
    r"\b(latest|current|newest|most recent)\b.{0,40}\b("
    r"version|release|jdk|java\s*se?|openjdk|python|node\.?js|typescript|golang|\bgo\b|rust|"
    r"kotlin|swift|react|angular|vue|spring|\.net|dotnet|ubuntu|debian|macos|ios|android|"
    r"chrome|firefox|safari|windows|llama|ollama|gpt|claude|gemini"
    r")\b|"
    r"\b(what|which)\s+(?:is\s+)?(?:the\s+)?(?:latest|current|newest)\b.{0,35}\b("
    r"version|release|jdk|java|python|node|typescript|golang|rust|kotlin|swift|react|angular|"
    r"ubuntu|debian|macos|ios|android|chrome|firefox|windows|llama|ollama|gpt|claude|gemini"
    r")\b|"
    r"\bwhen\s+(?:was|is)\s+.+\b(?:released|launched|announced|general availability|ga)\b|"
    r"\b(?:is|are)\s+.+\b(?:still\s+supported|end[- ]of[- ]life|eol)\b|"
    r"\b(?:release\s+date|ga\s+date)\s+of\b"
)


def query_needs_verification(query: str) -> bool:
    q = FORCE_SEARCH_PREFIX.sub("", query).strip()
    if LOCAL_ONLY_PATTERN.search(q):
        return False
    return bool(VERIFY_FACTS_PATTERN.search(q))


def query_is_conversational(query: str) -> bool:
    """Thanks, greetings, brief acks — reply from chat context, not the web."""
    q = FORCE_SEARCH_PREFIX.sub("", query).strip()
    if not q or len(q) > 120:
        return False
    if CONVERSATIONAL_ONLY_PATTERN.match(q):
        return True
    if len(q) <= 20 and "?" not in q and not query_looks_factual(q):
        if LOCAL_ONLY_PATTERN.search(q):
            return False
        if not re.search(r"(?i)\b(who|what|when|where|why|how|which)\b", q):
            return bool(re.match(r"^[\w\s'\".,!-]+$", q))
    return False


def query_looks_factual(query: str) -> bool:
    q = FORCE_SEARCH_PREFIX.sub("", query).strip()
    if not q:
        return False
    if FORCE_SEARCH_PREFIX.search(query) or re.search(
        r"(?i)\b(look up online|search the web|search online|find online|check online|google this)\b", q
    ):
        return True
    if query_needs_verification(q):
        return True
    if FACTUAL_QUERY_PATTERN.search(q):
        return True
    if LIVE_REQUIRED_PATTERN.search(q):
        return True
    if re.search(
        r"(?i)\b(weather|forecast|price|score|population|capital|exchange rate|who won|headline|news today)\b",
        q,
    ):
        return True
    if q.endswith("?") and not LOCAL_ONLY_PATTERN.search(q):
        return True
    return False


def query_needs_internet(query: str, *, force_search: bool = False) -> bool:
    q = FORCE_SEARCH_PREFIX.sub("", query).strip()
    if query_is_conversational(q):
        return False
    if LOCAL_ONLY_PATTERN.search(q) and not query_looks_factual(q):
        return False
    if force_search and query_looks_factual(q):
        return True
    return query_looks_factual(q)

_response_cache: dict[str, tuple[float, dict]] = {}


@dataclass
class HandlerResult:
    direct_answer: str | None = None
    context_blocks: list[str] = field(default_factory=list)
    sources: list[dict] = field(default_factory=list)
    handler: str | None = None
    source_label: str | None = None
    live_data: bool = False
    use_direct: bool = False


def _cache_get(key: str) -> dict | None:
    entry = _response_cache.get(key)
    if not entry:
        return None
    ts, data = entry
    if time.monotonic() - ts > CACHE_TTL_SECONDS:
        _response_cache.pop(key, None)
        return None
    return data


def _cache_set(key: str, data: dict) -> None:
    _response_cache[key] = (time.monotonic(), data)


def _fetch_json(url: str, timeout: int = 12) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.URLError as e:
        if "SSL" not in str(e) and "certificate" not in str(e).lower():
            raise
        try:
            proc = subprocess.run(
                ["curl", "-sf", "--max-time", str(timeout), "-A", USER_AGENT, url],
                capture_output=True,
                text=True,
                check=True,
            )
            return json.loads(proc.stdout)
        except (subprocess.CalledProcessError, ValueError, json.JSONDecodeError) as err:
            raise urllib.error.URLError(str(err)) from err


def _fetch_text(url: str, timeout: int = 12) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as e:
        if "SSL" not in str(e) and "certificate" not in str(e).lower():
            raise
        proc = subprocess.run(
            ["curl", "-sf", "--max-time", str(timeout), "-A", USER_AGENT, url],
            capture_output=True,
            text=True,
            check=True,
        )
        return proc.stdout


def _now_line() -> str:
    return f"Today is {datetime.now().astimezone().strftime('%A, %B %d, %Y')}."


def _format_kickoff(kickoff: datetime) -> str:
    local = kickoff.astimezone()
    day = local.day
    hour = local.strftime("%I").lstrip("0") or "12"
    minute = local.strftime("%M")
    ampm = local.strftime("%p")
    return (
        f"{local.strftime('%A, %B')} {day}, {local.year} at {hour}:{minute} {ampm} "
        f"{local.tzname()} ({kickoff.strftime('%H:%M')} UTC)"
    )


def detect_fx_pair(query: str) -> tuple[str, str] | None:
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


def fetch_exchange_rate(from_ccy: str, to_ccy: str) -> dict:
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


def search_duckduckgo(query: str, max_results: int = 8, *, retries: int = 2) -> list[dict]:
    last_err: urllib.error.URLError | None = None
    for attempt in range(retries):
        try:
            url = f"https://lite.duckduckgo.com/lite/?q={quote(query)}"
            html = unescape(_fetch_text(url, timeout=15))
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
            if results:
                return results
        except urllib.error.URLError as e:
            last_err = e
            if attempt + 1 < retries:
                time.sleep(0.4 * (attempt + 1))
    if last_err:
        raise last_err
    return []


def search_ddg_instant(query: str) -> dict | None:
    url = f"https://api.duckduckgo.com/?q={quote(query)}&format=json&no_html=1&skip_disambig=1"
    try:
        data = _fetch_json(url, timeout=10)
    except (urllib.error.URLError, ValueError, json.JSONDecodeError):
        return None
    abstract = (data.get("AbstractText") or "").strip()
    if not abstract:
        return None
    heading = (data.get("Heading") or query).strip()
    source_url = data.get("AbstractURL") or data.get("AbstractSource") or "https://duckduckgo.com"
    return {
        "title": heading,
        "snippet": abstract,
        "url": source_url,
        "source_type": data.get("Type"),
    }


def extract_facts_from_results(results: list[dict]) -> list[str]:
    combined = "\n".join(
        f"{r.get('title', '')} {r.get('snippet', '')}" for r in results
    )
    facts: list[str] = []
    seen: set[str] = set()

    def add(label: str, value: str) -> None:
        key = f"{label}:{value}"
        if key not in seen and len(value) > 2:
            seen.add(key)
            facts.append(f"- {label}: {value}")

    for m in re.finditer(
        r"\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
        r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
        r"\s+\d{1,2},?\s+202[0-9]\b",
        combined,
        re.I,
    ):
        add("Date", m.group(0))

    for m in re.finditer(
        r"\b([A-Z][a-zA-Z&'.-]+(?:\s+[A-Z][a-zA-Z&'.-]+){0,3})\s+vs\.?\s+"
        r"([A-Z][a-zA-Z&'.-]+(?:\s+[A-Z][a-zA-Z&'.-]+){0,3})\b",
        combined,
    ):
        add("Matchup", f"{m.group(1).strip()} vs {m.group(2).strip()}")

    for m in re.finditer(r"\$[\d,]+(?:\.\d{2})?", combined):
        add("Price", m.group(0))

    for m in re.finditer(r"\b\d+(?:\.\d+)?%", combined):
        add("Percent", m.group(0))

    for m in re.finditer(
        r"\b(?:Stadium|Arena|Field|Estadio|BC Place|MetLife|SoFi|Mercedes-Benz|"
        r"Arrowhead|Gillette|Hard Rock|Lumen Field)[^,.;\n]{0,60}",
        combined,
        re.I,
    ):
        add("Venue", m.group(0).strip())

    return facts[:12]


def refine_search_query(query: str) -> str:
    q = FORCE_SEARCH_PREFIX.sub("", query).strip().rstrip("?").strip()
    year = date.today().year
    month = date.today().strftime("%B")

    if query_needs_verification(q):
        return f"{q} latest official release date {year}"

    if TEMPORAL_QUERY_PATTERN.search(q):
        if str(year) not in q:
            return f"{q} {month} {year}"
        return f"{q} {month}"

    return q


FILLER_WORDS = re.compile(
    r"(?i)\b(the|a|an|current|ongoing|latest|recent|present|right now|"
    r"what|is|are|was|were|that|this|please|tell me|about|which|who|when|where|how)\b"
)


def _search_terms_from_query(query: str) -> str:
    q = FORCE_SEARCH_PREFIX.sub("", query).strip().rstrip("?").strip()
    q = QUESTION_PREFIX.sub("", q).strip()
    q = FILLER_WORDS.sub(" ", q)
    q = re.sub(r"\s+", " ", q).strip()
    if TEMPORAL_QUERY_PATTERN.search(query) and str(date.today().year) not in q:
        q = f"{q} {date.today().year}"
    return q[:160] if q else query[:160]


def _wiki_hit_score(extract: str, query: str, title: str = "") -> int:
    score = 0
    years = _years_in_text(extract)
    cy = date.today().year
    if years:
        max_y = max(years)
        if max_y >= cy:
            score += 30
        elif max_y >= cy - 1:
            score += 15
        elif max_y < cy - 2:
            score -= 20
    if TEMPORAL_QUERY_PATTERN.search(query):
        if re.search(rf"(?i)\b{cy}\b", extract):
            score += 25
        if re.search(r"(?i)\b(tour|series|schedule|fixture|match|playing|vs\.?|versus)\b", extract):
            score += 10
    keywords = [w for w in _search_terms_from_query(query).lower().split() if len(w) > 3 and not w.isdigit()]
    blob = f"{title} {extract}".lower()
    score += sum(5 for k in keywords if k in blob)
    if re.search(r"(?i)\bwho won\b", query) and not re.search(
        r"(?i)\b(won|winner|victory|champion|defeated|beat)\b", extract[:500]
    ):
        score -= 25
    return score


def _years_in_text(text: str) -> list[int]:
    return [int(y) for y in re.findall(r"\b(20\d{2})\b", text or "")]


def _is_stale_reference(text: str, query: str) -> bool:
    """Drop references that only mention years far in the past for 'current/latest' questions."""
    if not TEMPORAL_QUERY_PATTERN.search(query):
        return False
    years = _years_in_text(text)
    if not years:
        return False
    return max(years) < date.today().year - 1


def _trim_extract(extract: str, max_len: int = 950) -> str:
    text = extract.strip()
    if len(text) <= max_len:
        return text
    return text[:max_len].rsplit(" ", 1)[0] + "…"


def _wikipedia_search_hits(query: str, *, limit: int = 3) -> list[tuple[str, str, str]]:
    """Search Wikipedia by terms extracted from the question — never use the raw question as a page title."""
    terms = _search_terms_from_query(query)
    search_url = (
        "https://en.wikipedia.org/w/api.php"
        f"?action=query&list=search&srsearch={quote(terms)}&format=json&srlimit={limit + 2}"
    )
    try:
        search = _fetch_json(search_url)
    except (urllib.error.URLError, ValueError, json.JSONDecodeError):
        return []
    ranked: list[tuple[int, str, str, str]] = []
    for hit in search.get("query", {}).get("search") or []:
        title = hit.get("title")
        if not title:
            continue
        try:
            result = _wikipedia_extract(title)
        except (urllib.error.URLError, ValueError, KeyError):
            continue
        if not result:
            continue
        extract, wiki_url = result
        if _is_stale_reference(extract, query):
            continue
        ranked.append((_wiki_hit_score(extract, query, title), title, extract, wiki_url))
    ranked.sort(key=lambda x: x[0], reverse=True)
    return [(t, e, u) for _s, t, e, u in ranked[:limit]]


def _rank_ddg_results(results: list[dict], query: str) -> list[dict]:
    def score(r: dict) -> int:
        text = f"{r.get('title', '')} {r.get('snippet', '')}"
        s = _wiki_hit_score(text, query, r.get("title", ""))
        if _is_stale_reference(text, query):
            s -= 50
        return s

    return sorted(results, key=score, reverse=True)


def build_direct_from_research(
    query: str,
    instant: dict | None,
    wiki_hits: list[tuple[str, str, str]],
    ddg_results: list[dict],
) -> str | None:
    """Build a direct answer from web sources — bypasses the local LLM for factual lookups."""
    sections: list[str] = []

    if instant and instant.get("snippet") and not _is_stale_reference(instant["snippet"], query):
        sections.append(f"**{instant['title']}**\n\n{instant['snippet']}")

    for title, extract, _url in wiki_hits:
        wscore = _wiki_hit_score(extract, query, title)
        if wscore < 15 and ddg_results:
            continue
        if re.search(r"(?i)\bwho won\b", query) and wscore < 25:
            continue
        sections.append(f"**{title}** (Wikipedia)\n\n{_trim_extract(extract, 850)}")
        break

    fresh_ddg = [
        r
        for r in ddg_results
        if r.get("snippet")
        and not _is_stale_reference(f"{r.get('title', '')} {r.get('snippet', '')}", query)
    ]
    pool = fresh_ddg if fresh_ddg else ddg_results

    if not sections and pool:
        lines = [f"**From web search** ({date.today().strftime('%B %d, %Y')})", ""]
        for r in pool[:4]:
            title = (r.get("title") or "").strip()
            snippet = (r.get("snippet") or "").strip()
            if title and snippet:
                lines.extend([f"**{title}**", snippet[:420], ""])
        if len(lines) > 2:
            sections.append("\n".join(lines).strip())
    elif pool and len(sections) == 1:
        r = pool[0]
        snippet = (r.get("snippet") or "").strip()
        if snippet:
            sections.append(f"**Also:** {(r.get('title') or 'Source')}\n{snippet[:380]}")

    return "\n\n".join(sections) if sections else None


def _is_factual_lookup(query: str) -> bool:
    if LOCAL_ONLY_PATTERN.search(query) and not FACTUAL_QUERY_PATTERN.search(query):
        return False
    return bool(
        FACTUAL_QUERY_PATTERN.search(query)
        or LIVE_REQUIRED_PATTERN.search(query)
        or TEMPORAL_QUERY_PATTERN.search(query)
    )


def run_web_research(query: str) -> tuple[HandlerResult, list[dict]]:
    """Generic web lookup: DDG Instant + Wikipedia search + DDG scrape → direct or LLM context."""
    search_q = refine_search_query(query)
    sources: list[dict] = []
    instant: dict | None = None

    try:
        instant = search_ddg_instant(search_q) or search_ddg_instant(query)
        if instant:
            sources.append(
                {"title": instant["title"], "snippet": instant["snippet"], "url": instant["url"]}
            )
    except (urllib.error.URLError, ValueError, json.JSONDecodeError):
        pass

    wiki_hits: list[tuple[str, str, str]] = []
    if not re.search(r"(?i)\bwho won\b", query):
        try:
            wiki_hits = _wikipedia_search_hits(query, limit=2)
        except Exception:
            wiki_hits = []

    ddg_results: list[dict] = []
    try:
        ddg_results = _rank_ddg_results(search_duckduckgo(search_q, max_results=8), query)
    except urllib.error.URLError:
        pass

    seen_urls: set[str] = {s.get("url", "") for s in sources}
    for r in ddg_results:
        url = r.get("url", "")
        if url and url not in seen_urls:
            sources.append(r)
            seen_urls.add(url)

    for title, extract, url in wiki_hits:
        sources.append(
            {"title": f"Wikipedia · {title}", "snippet": extract[:300], "url": url}
        )

    direct = build_direct_from_research(query, instant, wiki_hits, ddg_results)
    blocks: list[str] = []
    if instant:
        blocks.append(f"DuckDuckGo Instant:\n{instant['title']}\n{instant['snippet']}")
    for title, extract, _url in wiki_hits:
        blocks.append(f"Wikipedia — {title}:\n{_trim_extract(extract)}")

    if direct and _is_factual_lookup(query):
        return (
            HandlerResult(
                direct_answer=direct,
                context_blocks=[direct],
                sources=sources,
                handler="web",
                source_label="Web search",
                live_data=True,
                use_direct=True,
            ),
            ddg_results,
        )

    return (
        HandlerResult(
            context_blocks=blocks,
            sources=sources,
            handler="web",
            source_label="Web search",
            live_data=bool(blocks or ddg_results),
            use_direct=False,
        ),
        ddg_results,
    )


# --- Handlers ---


def _resolve_timezone(name: str) -> ZoneInfo | None:
    key = name.strip().lower()
    if not key:
        return datetime.now().astimezone().tzinfo  # type: ignore[return-value]
    if key in TZ_ALIASES:
        key = TZ_ALIASES[key]
    try:
        return ZoneInfo(key)
    except ZoneInfoNotFoundError:
        for alias, tz in TZ_ALIASES.items():
            if alias in key or key in alias:
                try:
                    return ZoneInfo(tz)
                except ZoneInfoNotFoundError:
                    continue
        title_key = key.replace(" ", "_")
        try:
            return ZoneInfo(title_key)
        except ZoneInfoNotFoundError:
            return None


def handle_time(query: str) -> HandlerResult | None:
    m = TIME_PATTERN.search(query)
    if not m:
        return None
    place = (m.group(1) or m.group(2) or "").strip()
    tz = _resolve_timezone(place) if place else datetime.now().astimezone().tzinfo
    if tz is None:
        return None
    now = datetime.now(tz)
    place_label = place.title() if place else str(now.tzname() or "local")
    answer = (
        f"**Current time in {place_label}:** {now.strftime('%A, %B %d, %Y at %I:%M:%S %p %Z')}\n\n"
        f"UTC: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')} UTC"
    )
    return HandlerResult(
        direct_answer=answer,
        context_blocks=[answer],
        sources=[{"title": f"Local time · {place_label}", "snippet": answer, "url": "local://time"}],
        handler="time",
        source_label="Live · Local clock",
        live_data=True,
        use_direct=True,
    )


def handle_fx(query: str) -> HandlerResult | None:
    pair = detect_fx_pair(query)
    if not pair:
        return None
    from_c, to_c = pair
    try:
        fx = fetch_exchange_rate(from_c, to_c)
    except (urllib.error.URLError, ValueError, KeyError):
        return None
    answer = format_fx_answer(fx)
    use_direct = bool(re.search(r"(?i)\b(current|today|now|live|what'?s|what is|rate)\b", query))
    return HandlerResult(
        direct_answer=answer if use_direct else None,
        context_blocks=[answer],
        sources=[{"title": f"Live FX: {from_c}/{to_c}", "snippet": answer, "url": "https://open.er-api.com"}],
        handler="fx",
        source_label="Live · open.er-api.com",
        live_data=True,
        use_direct=use_direct,
    )


def _detect_crypto_id(query: str) -> str | None:
    q = query.lower()
    for alias, coin_id in sorted(CRYPTO_IDS.items(), key=lambda x: -len(x[0])):
        if re.search(rf"\b{re.escape(alias)}\b", q):
            return coin_id
    if re.search(r"(?i)\bcrypto(currency)?\b", query):
        return "bitcoin"
    return None


def handle_crypto(query: str) -> HandlerResult | None:
    if not CRYPTO_PATTERN.search(query):
        return None
    coin_id = _detect_crypto_id(query)
    if not coin_id:
        return None
    url = (
        "https://api.coingecko.com/api/v3/simple/price"
        f"?ids={coin_id}&vs_currencies=usd,eur,gbp,inr&include_last_updated_at=true"
    )
    try:
        data = _fetch_json(url)
    except (urllib.error.URLError, ValueError, KeyError):
        return None
    prices = data.get(coin_id)
    if not prices:
        return None
    label = coin_id.replace("-", " ").title()
    updated = prices.get("last_updated_at")
    updated_str = (
        datetime.fromtimestamp(updated, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        if updated
        else "recently"
    )
    answer = (
        f"**Live {label} price** (via CoinGecko, updated {updated_str}):\n\n"
        f"- **USD:** ${prices.get('usd', 0):,.2f}\n"
        f"- **EUR:** €{prices.get('eur', 0):,.2f}\n"
        f"- **GBP:** £{prices.get('gbp', 0):,.2f}\n"
        f"- **INR:** ₹{prices.get('inr', 0):,.2f}"
    )
    use_direct = bool(re.search(r"(?i)\b(price|cost|how much|current|today|now|live|what'?s|what is)\b", query))
    return HandlerResult(
        direct_answer=answer if use_direct else None,
        context_blocks=[answer],
        sources=[{"title": f"Live crypto: {label}", "snippet": answer, "url": "https://www.coingecko.com"}],
        handler="crypto",
        source_label="Live · CoinGecko",
        live_data=True,
        use_direct=use_direct,
    )


def _extract_weather_location(query: str) -> str | None:
    q = query.strip()
    patterns = [
        r"(?i)(?:weather|forecast|temperature|rain|snow)\s+(?:in|for|at)\s+(.+?)(?:\?|$|today|tomorrow)",
        r"(?i)(?:weather|forecast)\s+(?:today|tomorrow|this week)\s+(?:in|for|at)\s+(.+?)(?:\?|$)",
        r"(?i)^(.+?)\s+(?:weather|forecast)(?:\?|$)",
    ]
    for pat in patterns:
        m = re.search(pat, q)
        if m:
            loc = m.group(1).strip(" ?.")
            if loc and not re.search(r"(?i)^(today|tomorrow|now|current)$", loc):
                return loc
    if re.search(r"(?i)\b(?:weather|forecast)\b", q) and not re.search(
        r"(?i)\b(?:draft|write|email|explain)\b", q
    ):
        return None
    return None


def handle_weather(query: str) -> HandlerResult | None:
    if not WEATHER_PATTERN.search(query):
        return None
    location = _extract_weather_location(query)
    try:
        if location:
            geo = _fetch_json(
                f"https://geocoding-api.open-meteo.com/v1/search?name={quote(location)}&count=1&language=en&format=json"
            )
            results = geo.get("results") or []
            if not results:
                return None
            place = results[0]
            lat, lon = place["latitude"], place["longitude"]
            place_name = ", ".join(
                x for x in [place.get("name"), place.get("admin1"), place.get("country")] if x
            )
        else:
            wttr = json.loads(_fetch_text("https://wttr.in/?format=j1", timeout=12))
            area = wttr.get("nearest_area", [{}])[0]
            place_name = ", ".join(
                x.get("value", "") for x in area.get("areaName", [{}])[:1]
            ) or "your area"
            lat = float(wttr["nearest_area"][0]["latitude"])
            lon = float(wttr["nearest_area"][0]["longitude"])

        forecast_url = (
            "https://api.open-meteo.com/v1/forecast"
            f"?latitude={lat}&longitude={lon}"
            "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m"
            "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code"
            "&timezone=auto&forecast_days=2"
        )
        data = _fetch_json(forecast_url)
        cur = data.get("current", {})
        daily = data.get("daily", {})
        code = int(cur.get("weather_code", -1))
        condition = WMO_WEATHER.get(code, "Unknown")
        temp = cur.get("temperature_2m")
        feels = cur.get("apparent_temperature")
        wind = cur.get("wind_speed_10m")
        humidity = cur.get("relative_humidity_2m")

        lines = [
            f"**Weather for {place_name}** (via Open-Meteo):",
            "",
            f"- **Now:** {temp}°C, {condition} (feels like {feels}°C)",
            f"- **Wind:** {wind} km/h · **Humidity:** {humidity}%",
        ]
        if daily.get("time"):
            hi = daily["temperature_2m_max"][0]
            lo = daily["temperature_2m_min"][0]
            rain = daily.get("precipitation_probability_max", [None])[0]
            lines.append(f"- **Today:** high {hi}°C / low {lo}°C" + (f", rain chance {rain}%" if rain is not None else ""))
            if len(daily["time"]) > 1:
                hi2 = daily["temperature_2m_max"][1]
                lo2 = daily["temperature_2m_min"][1]
                rain2 = daily.get("precipitation_probability_max", [None, None])[1]
                lines.append(
                    f"- **Tomorrow:** high {hi2}°C / low {lo2}°C"
                    + (f", rain chance {rain2}%" if rain2 is not None else "")
                )
        answer = "\n".join(lines)
        return HandlerResult(
            direct_answer=answer,
            context_blocks=[answer],
            sources=[{"title": f"Weather · {place_name}", "snippet": answer, "url": "https://open-meteo.com"}],
            handler="weather",
            source_label="Live · Open-Meteo",
            live_data=True,
            use_direct=True,
        )
    except (urllib.error.URLError, ValueError, KeyError, IndexError, json.JSONDecodeError):
        return None


def _parse_espn_event(event: dict, *, racing: bool = False) -> dict | None:
    comp = (event.get("competitions") or [{}])[0]
    competitors = comp.get("competitors") or []
    venue = comp.get("venue") or {}
    status = comp.get("status", {}).get("type", {})
    kickoff_raw = event.get("date") or comp.get("date")
    if not kickoff_raw:
        return None
    kickoff = datetime.fromisoformat(kickoff_raw.replace("Z", "+00:00"))
    state = status.get("state") or ""
    status_desc = status.get("description") or status.get("shortDetail") or ""

    team_names = [c.get("team", {}).get("displayName") for c in competitors[:2]]
    is_racing = racing or (
        len(competitors) != 2 or not all(team_names) or bool(competitors and competitors[0].get("athlete"))
    )

    if is_racing:
        race_name = event.get("name") or event.get("shortName") or "Race"
        scores = status_desc or "Scheduled"
        if state == "post" and competitors:
            winner = next((c for c in competitors if str(c.get("order")) == "1"), competitors[0])
            wname = (winner.get("athlete") or {}).get("displayName") or "?"
            scores = f"Winner: {wname}"
        elif state == "in" and competitors:
            leader = next((c for c in competitors if str(c.get("order")) == "1"), None)
            if leader:
                scores = f"Leader: {(leader.get('athlete') or {}).get('displayName', '?')}"
        return {
            "teams": race_name,
            "scores": scores,
            "venue": venue.get("fullName") or "TBD",
            "city": (venue.get("address") or {}).get("city") or "",
            "kickoff": kickoff,
            "state": state,
            "status": status_desc,
            "racing": True,
        }

    if len(competitors) < 2:
        return None
    teams = " vs ".join(c.get("team", {}).get("displayName", "?") for c in competitors[:2])
    scores = " — ".join(
        f"{c.get('team', {}).get('displayName', '?')} {c.get('score', '0')}"
        for c in competitors[:2]
    )
    return {
        "teams": teams,
        "scores": scores,
        "venue": venue.get("fullName") or "TBD",
        "city": (venue.get("address") or {}).get("city") or "",
        "kickoff": kickoff,
        "state": state,
        "status": status_desc,
        "racing": False,
    }


def _fetch_espn_events(sport: str, league: str, day: date, *, racing: bool = False) -> list[dict]:
    url = (
        f"https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard"
        f"?dates={day.strftime('%Y%m%d')}"
    )
    data = _fetch_json(url)
    events: list[dict] = []
    for raw in data.get("events") or []:
        parsed = _parse_espn_event(raw, racing=racing)
        if parsed:
            events.append(parsed)
    return events


def _fetch_espn_racing_events(sport: str, league: str, start: date, end: date) -> list[dict]:
    url = (
        f"https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard"
        f"?dates={start.strftime('%Y%m%d')}-{end.strftime('%Y%m%d')}"
    )
    data = _fetch_json(url)
    events: list[dict] = []
    for raw in data.get("events") or []:
        parsed = _parse_espn_event(raw, racing=True)
        if parsed:
            events.append(parsed)
    return events


def _detect_espn_league(query: str) -> dict | None:
    for entry in ESPN_LEAGUES:
        if entry["pattern"].search(query):
            return entry
    if SPORTS_LIVE_PATTERN.search(query):
        for entry in ESPN_LEAGUES:
            if re.search(rf"(?i)\b{re.escape(entry['label'].split()[0])}\b", query):
                return entry
    return None


def handle_espn_sports(query: str) -> HandlerResult | None:
    league = _detect_espn_league(query)
    if not league or not SPORTS_LIVE_PATTERN.search(query):
        return None

    now = datetime.now(timezone.utc)
    events: list[dict] = []
    sources: list[dict] = []
    is_racing = bool(league.get("racing"))

    if is_racing:
        start = (now - timedelta(days=1)).date()
        end = (now + timedelta(days=120)).date()
        try:
            events = _fetch_espn_racing_events(league["sport"], league["league"], start, end)
            if events:
                sources.append(
                    {
                        "title": f"ESPN {league['label']} ({start.isoformat()} – {end.isoformat()})",
                        "snippet": "; ".join(
                            f"{e['teams']} ({e['status']})" for e in events[:8]
                        ),
                        "url": (
                            f"https://site.api.espn.com/apis/site/v2/sports/"
                            f"{league['sport']}/{league['league']}/scoreboard"
                            f"?dates={start.strftime('%Y%m%d')}-{end.strftime('%Y%m%d')}"
                        ),
                    }
                )
        except (urllib.error.URLError, ValueError, KeyError):
            events = []
    else:
        for offset in range(-1, 4):
            day = (now + timedelta(days=offset)).date()
            try:
                day_events = _fetch_espn_events(league["sport"], league["league"], day)
                events.extend(day_events)
                if day_events:
                    sources.append(
                        {
                            "title": f"ESPN {league['label']} ({day.isoformat()})",
                            "snippet": "; ".join(
                                f"{e['teams']} @ {e['venue']} ({e['status']})" for e in day_events[:6]
                            ),
                            "url": (
                                f"https://site.api.espn.com/apis/site/v2/sports/"
                                f"{league['sport']}/{league['league']}/scoreboard?dates={day.strftime('%Y%m%d')}"
                            ),
                        }
                    )
            except (urllib.error.URLError, ValueError, KeyError):
                continue

    if not events:
        if league:
            answer = (
                f"**{league['label']}** (via ESPN)\n\n"
                f"No games found in ESPN's scoreboard for the past day or next few days. "
                f"The league may be between seasons or on a break."
            )
            return HandlerResult(
                direct_answer=answer,
                context_blocks=[answer],
                sources=[{
                    "title": f"ESPN {league['label']} scoreboard",
                    "snippet": "No events in date range",
                    "url": f"https://www.espn.com",
                }],
                handler="espn",
                source_label=f"Live · ESPN ({league['label']})",
                live_data=True,
                use_direct=True,
            )
        return None

    events.sort(key=lambda e: e["kickoff"])
    live = [e for e in events if e["state"] == "in"]
    upcoming = [e for e in events if e["state"] == "pre" and e["kickoff"] >= now]
    finished = [e for e in events if e["state"] == "post"]
    today_local = now.astimezone().date()
    today_events = [e for e in events if e["kickoff"].astimezone().date() == today_local]

    lines = [f"**{league['label']}** (live data via ESPN)", ""]
    use_direct = bool(re.search(r"(?i)\b(next|upcoming|when|where|today|tonight|live|score|who won)\b", query))
    event_label = "race" if is_racing else "match"
    events_label = "races" if is_racing else "games"
    today_label = "Today's races" if is_racing else "Today's games"

    if re.search(r"(?i)\bwho won\b", query) and finished:
        last = finished[-1]
        place = f"{last['venue']}, {last['city']}".strip(", ")
        lines.extend(
            [
                f"**Most recent result:** {last['scores']}",
                f"- **Status:** {last['status']}",
                f"- **Venue:** {place}",
                f"- **When:** {_format_kickoff(last['kickoff'])}",
            ]
        )
    elif live:
        match = live[0]
        place = f"{match['venue']}, {match['city']}".strip(", ")
        lines.extend(
            [
                f"**Currently playing:** {match['teams']}",
                f"- **Score:** {match['scores']}",
                f"- **Status:** {match['status']}",
                f"- **Venue:** {place}",
                f"- **Kickoff:** {_format_kickoff(match['kickoff'])}",
            ]
        )
        if upcoming:
            nxt = upcoming[0]
            nplace = f"{nxt['venue']}, {nxt['city']}".strip(", ")
            lines.extend(
                [
                    "",
                    f"**Next scheduled:** {nxt['teams']}",
                    f"- **When:** {_format_kickoff(nxt['kickoff'])}",
                    f"- **Where:** {nplace}",
                ]
            )
    elif upcoming:
        nxt = upcoming[0]
        place = f"{nxt['venue']}, {nxt['city']}".strip(", ") or "TBD"
        lines.extend(
            [
                f"**Next {event_label}:** {nxt['teams']}",
                f"- **When:** {_format_kickoff(nxt['kickoff'])}",
                f"- **Where:** {place}",
            ]
        )
    elif finished:
        last = finished[-1]
        lines.append(f"**Latest result:** {last['scores']} ({last['status']})")
    else:
        lines.append(f"No upcoming {events_label} found in the next few months.")

    if today_events:
        lines.extend(["", f"**{today_label}:**"])
        for e in today_events:
            place = f"{e['venue']}, {e['city']}".strip(", ")
            lines.append(f"- {e['teams']} — {e['status']} — {place}")

    answer = "\n".join(lines)
    return HandlerResult(
        direct_answer=answer if use_direct else None,
        context_blocks=[answer],
        sources=sources,
        handler="espn",
        source_label=f"Live · ESPN ({league['label']})",
        live_data=True,
        use_direct=use_direct,
    )


def _clean_wiki_field(value: str) -> str:
    text = unescape(value.strip())
    text = re.sub(r"\{\{[^}]+\}\}", "", text)
    text = re.sub(r"\[\[(?:[^|\]]+\|)?([^\]]+)\]\]", r"\1", text)
    text = re.sub(r"<ref[^>]*>.*?</ref>", "", text, flags=re.S)
    text = re.sub(r"<ref[^/]*/>", "", text)
    return re.sub(r"\s+", " ", text).strip()


def _normalize_cricket_format(raw: str) -> str | None:
    key = re.sub(r"\s+", " ", raw.strip().lower())
    return CRICKET_FORMAT_ALIASES.get(key)


def _parse_cricket_stats_query(query: str) -> tuple[str, str] | None:
    q = FORCE_SEARCH_PREFIX.sub("", query).strip().rstrip("?").strip()
    m = CRICKET_STATS_QUERY.search(q)
    if not m:
        return None
    g = m.groups()
    if g[0] and g[1]:
        fmt, player = g[0], g[1]
    elif g[2] and g[3]:
        player, fmt = g[2], g[3]
    elif g[4] and g[5]:
        fmt, player = g[4], g[5]
    elif g[6] and g[7]:
        fmt, player = g[6], g[7]
    else:
        return None
    fmt = _normalize_cricket_format(fmt)
    if not fmt:
        return None
    player = re.sub(r"\s+", " ", player).strip(" '\"")
    player = re.sub(r"(?i)\b(batting|bowling|career|stats|statistics|record)\b", "", player).strip()
    if len(player) < 3:
        return None
    return fmt, player


def _fetch_wikipedia_wikitext(title: str) -> tuple[str, str] | None:
    url = (
        "https://en.wikipedia.org/w/api.php"
        f"?action=parse&page={quote(title.replace(' ', '_'))}&prop=wikitext&redirects=1&format=json"
    )
    try:
        data = _fetch_json(url)
    except (urllib.error.URLError, ValueError, json.JSONDecodeError):
        return None
    parse = data.get("parse") or {}
    wikitext = (parse.get("wikitext") or {}).get("*") or ""
    if not wikitext:
        return None
    page_title = parse.get("title") or title
    wiki_url = f"https://en.wikipedia.org/wiki/{quote(page_title.replace(' ', '_'))}"
    return wikitext, wiki_url


def _find_cricket_infobox(wikitext: str) -> str:
    for marker in ("{{Infobox cricketer", "{{Infobox cricket player"):
        start = wikitext.find(marker)
        if start >= 0:
            depth = 0
            i = start
            while i < len(wikitext) - 1:
                if wikitext[i : i + 2] == "{{":
                    depth += 1
                    i += 2
                    continue
                if wikitext[i : i + 2] == "}}":
                    depth -= 1
                    i += 2
                    if depth == 0:
                        return wikitext[start:i]
                    continue
                i += 1
    return ""


def _infobox_field(infobox: str, field: str) -> str | None:
    m = re.search(rf"\|\s*{re.escape(field)}\s*=\s*([^\n|]+)", infobox, re.I)
    if not m:
        return None
    val = _clean_wiki_field(m.group(1))
    return val or None


def _espn_search_cricket_player(name: str) -> dict | None:
    url = (
        "https://site.api.espn.com/apis/search/v2"
        f"?query={quote(name)}&limit=5&type=player"
    )
    try:
        data = _fetch_json(url)
    except (urllib.error.URLError, ValueError, json.JSONDecodeError):
        return None
    for block in data.get("results") or []:
        if block.get("type") != "player":
            continue
        for item in block.get("contents") or []:
            if item.get("sport") != "cricket":
                continue
            display = (item.get("displayName") or "").strip()
            if not display:
                continue
            link = (item.get("link") or {}).get("web") or ""
            return {"name": display, "url": link}
    return None


def _resolve_cricket_player_page(player: str) -> tuple[str, str, str] | None:
    """Return (display_name, wikipedia_title, profile_url)."""
    espn = _espn_search_cricket_player(player)
    search_name = espn["name"] if espn else player
    profile_url = espn["url"] if espn else ""
    search_url = (
        "https://en.wikipedia.org/w/api.php"
        f"?action=query&list=search&srsearch={quote(search_name)}&format=json&srlimit=5"
    )
    try:
        search = _fetch_json(search_url)
    except (urllib.error.URLError, ValueError, json.JSONDecodeError):
        return None
    player_lower = search_name.lower()
    for hit in search.get("query", {}).get("search") or []:
        title = (hit.get("title") or "").strip()
        if not title:
            continue
        if player_lower.split()[0] in title.lower():
            return search_name, title, profile_url
    hits = search.get("query", {}).get("search") or []
    if hits:
        return search_name, hits[0]["title"], profile_url
    return None


def _format_cricket_stats_answer(
    player: str,
    fmt: str,
    infobox: str,
    *,
    wiki_url: str,
    profile_url: str,
) -> str | None:
    label = CRICKET_FORMAT_LABEL.get(fmt, fmt.upper())
    if fmt == "t20i":
        cap = _infobox_field(infobox, "T20Icap") or _infobox_field(infobox, "t20icap")
        if not cap:
            return None
        lines = [f"**{player} — {label} career statistics**", ""]
        lines.append(f"- **Matches:** {cap}")
        debut = " ".join(
            x
            for x in (
                _infobox_field(infobox, "T20Idebutdate") or _infobox_field(infobox, "t20idebutdate"),
                _infobox_field(infobox, "T20Idebutyear") or _infobox_field(infobox, "t20idebutyear"),
            )
            if x
        )
        against = _infobox_field(infobox, "T20Idebutagainst") or _infobox_field(infobox, "t20idebutagainst")
        if debut:
            lines.append(f"- **Debut:** {debut}" + (f" vs {against}" if against else ""))
        lines.append("")
        lines.append(
            "Detailed T20I batting/bowling numbers are not in the Wikipedia infobox; "
            f"see the full profile on ESPNcricinfo."
        )
    else:
        suffix = CRICKET_FORMAT_SUFFIX[fmt]
        matches = _infobox_field(infobox, f"matches{suffix}")
        runs = _infobox_field(infobox, f"runs{suffix}")
        if not matches and not runs:
            return None
        lines = [f"**{player} — {label} career statistics**", ""]
        if matches:
            lines.append(f"- **Matches:** {matches}")
        if runs:
            lines.append(f"- **Runs:** {runs}")
        avg = _infobox_field(infobox, f"bat avg{suffix}")
        if avg:
            lines.append(f"- **Batting average:** {avg}")
        hs = _infobox_field(infobox, f"100s/50s{suffix}")
        if hs:
            lines.append(f"- **100s / 50s:** {hs}")
        top = _infobox_field(infobox, f"top score{suffix}")
        if top:
            lines.append(f"- **Highest score:** {top}")
        catches = _infobox_field(infobox, f"catches/stumpings{suffix}")
        if catches:
            lines.append(f"- **Catches / stumpings:** {catches}")
        wickets = _infobox_field(infobox, f"wickets{suffix}")
        if wickets and wickets not in {"0", "—", "-"}:
            lines.append(f"- **Wickets:** {wickets}")
            bowl = _infobox_field(infobox, f"bowl avg{suffix}")
            best = _infobox_field(infobox, f"best bowling{suffix}")
            if bowl:
                lines.append(f"- **Bowling average:** {bowl}")
            if best:
                lines.append(f"- **Best bowling:** {best}")

        prefix = fmt
        cap = _infobox_field(infobox, f"{prefix}cap")
        if cap:
            lines.append(f"- **Caps:** {cap}")
        debut = " ".join(
            x
            for x in (
                _infobox_field(infobox, f"{prefix}debutdate"),
                _infobox_field(infobox, f"{prefix}debutyear"),
            )
            if x
        )
        debut_vs = _infobox_field(infobox, f"{prefix}debutagainst")
        if debut:
            lines.append(f"- **Debut:** {debut}" + (f" vs {debut_vs}" if debut_vs else ""))
        last = " ".join(
            x
            for x in (
                _infobox_field(infobox, f"last{prefix}date"),
                _infobox_field(infobox, f"last{prefix}year"),
            )
            if x
        )
        last_vs = _infobox_field(infobox, f"last{prefix}against")
        if last:
            lines.append(f"- **Last match:** {last}" + (f" vs {last_vs}" if last_vs else ""))

    lines.append("")
    src = profile_url or wiki_url
    if profile_url and wiki_url:
        lines.append(f"Sources: [Wikipedia]({wiki_url}) · [ESPNcricinfo]({profile_url})")
    elif profile_url:
        lines.append(f"Source: [ESPNcricinfo]({profile_url})")
    else:
        lines.append(f"Source: [Wikipedia]({wiki_url})")
    return "\n".join(lines)


def handle_cricket_player_stats(query: str) -> HandlerResult | None:
    parsed = _parse_cricket_stats_query(query)
    if not parsed:
        return None
    fmt, player = parsed
    resolved = _resolve_cricket_player_page(player)
    if not resolved:
        return None
    display_name, wiki_title, profile_url = resolved
    wiki = _fetch_wikipedia_wikitext(wiki_title)
    if not wiki:
        return None
    wikitext, wiki_url = wiki
    infobox = _find_cricket_infobox(wikitext)
    if not infobox:
        return None
    answer = _format_cricket_stats_answer(
        display_name,
        fmt,
        infobox,
        wiki_url=wiki_url,
        profile_url=profile_url,
    )
    if not answer:
        return None
    sources = [
        {"title": f"Wikipedia · {wiki_title}", "snippet": answer[:280], "url": wiki_url},
    ]
    if profile_url:
        sources.append(
            {"title": f"ESPNcricinfo · {display_name}", "snippet": f"{display_name} player profile", "url": profile_url}
        )
    return HandlerResult(
        direct_answer=answer,
        context_blocks=[answer],
        sources=sources,
        handler="cricket_stats",
        source_label=f"Live · {CRICKET_FORMAT_LABEL.get(fmt, fmt.upper())} stats",
        live_data=True,
        use_direct=True,
    )


def _wikipedia_extract(title: str) -> tuple[str, str] | None:
    url = (
        "https://en.wikipedia.org/w/api.php"
        f"?action=query&prop=extracts&exintro=1&explaintext&redirects=1&titles={quote(title)}&format=json"
    )
    data = _fetch_json(url)
    pages = data.get("query", {}).get("pages", {})
    for page in pages.values():
        if int(page.get("pageid", -1)) < 0:
            continue
        extract = (page.get("extract") or "").strip()
        if extract:
            page_title = page.get("title", title)
            wiki_url = f"https://en.wikipedia.org/wiki/{quote(page_title.replace(' ', '_'))}"
            return extract, wiki_url
    search_url = (
        "https://en.wikipedia.org/w/api.php"
        f"?action=query&list=search&srsearch={quote(title)}&format=json&srlimit=1"
    )
    search = _fetch_json(search_url)
    hits = search.get("query", {}).get("search") or []
    if not hits:
        return None
    return _wikipedia_extract(hits[0]["title"])


API_HANDLERS: list[tuple[str, object]] = [
    ("cricket_stats", handle_cricket_player_stats),
    ("time", handle_time),
    ("fx", handle_fx),
    ("crypto", handle_crypto),
    ("weather", handle_weather),
]


def run_api_handlers(query: str) -> HandlerResult:
    merged = HandlerResult()
    for _name, handler in API_HANDLERS:
        try:
            result = handler(query)
        except Exception:
            continue
        if not result:
            continue
        merged.sources.extend(result.sources)
        merged.context_blocks.extend(result.context_blocks)
        if result.handler and not merged.handler:
            merged.handler = result.handler
            merged.source_label = result.source_label
            merged.live_data = result.live_data
        if result.use_direct and result.direct_answer and not merged.direct_answer:
            merged.direct_answer = result.direct_answer
            merged.handler = result.handler
            merged.source_label = result.source_label
            merged.live_data = True
            merged.use_direct = True
    return merged


def _pack_direct_result(handler_out: HandlerResult, now_line: str) -> dict:
    context = f"{now_line}\n\n{handler_out.direct_answer}"
    return {
        "context": context,
        "direct_answer": handler_out.direct_answer,
        "sources": handler_out.sources,
        "handler": handler_out.handler,
        "source_label": handler_out.source_label,
        "live_data": handler_out.live_data,
    }


def build_web_context(query: str, *, force_search: bool = False) -> dict:
    """
    Returns dict with: context, direct_answer, sources, handler, source_label, live_data.
    Live APIs (time/FX/crypto/weather) + generic web research for everything else.
    """
    cache_key = f"{force_search}|{query.strip().lower()}"
    cached = _cache_get(cache_key)
    if cached:
        return cached

    now_line = _now_line()
    needs_verify = query_needs_verification(query)
    handler_out = run_api_handlers(query)

    pair = detect_fx_pair(query)
    if pair and not any("Live exchange rate" in b for b in handler_out.context_blocks):
        try:
            fx = fetch_exchange_rate(pair[0], pair[1])
            fx_block = format_fx_answer(fx)
            handler_out.context_blocks.append(fx_block)
            handler_out.sources.append(
                {"title": f"Live FX: {pair[0]}/{pair[1]}", "snippet": fx_block, "url": "https://open.er-api.com"}
            )
            if LIVE_REQUIRED_PATTERN.search(query) and not handler_out.direct_answer:
                handler_out.direct_answer = fx_block
                handler_out.use_direct = True
                handler_out.handler = handler_out.handler or "fx"
                handler_out.source_label = handler_out.source_label or "Live · open.er-api.com"
                handler_out.live_data = True
        except (urllib.error.URLError, ValueError, KeyError):
            pass

    if handler_out.use_direct and handler_out.direct_answer:
        out = _pack_direct_result(handler_out, now_line)
        _cache_set(cache_key, out)
        return out

    try:
        web, ddg_results = run_web_research(query)
    except Exception:
        web, ddg_results = HandlerResult(), []

    handler_out.sources.extend(web.sources)
    handler_out.context_blocks.extend(web.context_blocks)
    if web.use_direct and web.direct_answer:
        handler_out.direct_answer = web.direct_answer
        handler_out.use_direct = True
        handler_out.handler = web.handler or "web"
        handler_out.source_label = web.source_label or "Web search"
        handler_out.live_data = True

    if handler_out.use_direct and handler_out.direct_answer:
        out = _pack_direct_result(handler_out, now_line)
        _cache_set(cache_key, out)
        return out

    if not handler_out.context_blocks and not ddg_results:
        out = {
            "context": f"{now_line}\n\nNo web results found for this query.",
            "direct_answer": None,
            "sources": handler_out.sources,
            "handler": handler_out.handler,
            "source_label": handler_out.source_label,
            "live_data": False,
        }
        _cache_set(cache_key, out)
        return out

    extracted = extract_facts_from_results(ddg_results) if ddg_results else []
    lines = [now_line, ""]
    lines.append(
        "WEB SEARCH RESULTS — answer using ONLY this material. "
        f"Today is {date.today().strftime('%B %d, %Y')}. "
        "Ignore training-data dates (e.g. 2023) unless they appear in these sources."
    )
    if needs_verify:
        lines.append(
            "VERIFICATION MODE: version/release claims must come from these sources only."
        )
    lines.append("")
    for block in handler_out.context_blocks:
        lines.extend([block, ""])
    if extracted:
        lines.append("Key facts from snippets:")
        lines.extend(extracted)
        lines.append("")
    for n, r in enumerate(ddg_results, 1):
        lines.append(f"{n}. {r.get('title', '')}")
        if r.get("snippet"):
            lines.append(f"   {r['snippet']}")

    context = "\n".join(lines)
    out = {
        "context": context,
        "direct_answer": None,
        "sources": handler_out.sources,
        "handler": handler_out.handler or "web",
        "source_label": handler_out.source_label or "Web search",
        "live_data": bool(handler_out.context_blocks or ddg_results),
        "verify_facts": needs_verify,
    }
    _cache_set(cache_key, out)
    return out
