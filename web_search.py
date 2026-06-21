"""Web search helpers for local chat — stdlib only, no API keys."""

from __future__ import annotations

import json
import re
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
    {"pattern": re.compile(r"(?i)\b(fifa|world\s*cup|worldcup)\b"), "sport": "soccer", "league": "fifa.world", "label": "FIFA World Cup"},
    {"pattern": re.compile(r"(?i)\b(nfl|super\s*bowl|superbowl)\b"), "sport": "football", "league": "nfl", "label": "NFL"},
    {"pattern": re.compile(r"(?i)\b(nba|basketball)\b"), "sport": "basketball", "league": "nba", "label": "NBA"},
    {"pattern": re.compile(r"(?i)\b(mlb|baseball)\b"), "sport": "baseball", "league": "mlb", "label": "MLB"},
    {"pattern": re.compile(r"(?i)\b(premier\s*league|epl|english\s+premier)\b"), "sport": "soccer", "league": "eng.1", "label": "Premier League"},
    {"pattern": re.compile(r"(?i)\b(college\s*football|ncaa\s*football|cfb)\b"), "sport": "football", "league": "college-football", "label": "College Football"},
)

SPORTS_LIVE_PATTERN = re.compile(
    r"(?i)\b("
    r"next|upcoming|schedule|fixture|when|where|today|tonight|live|score|scores|"
    r"who won|kickoff|kick off|game|match"
    r")\b"
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
    r"next|upcoming|when|where|who is|who's|forecast|score|time in|time is it)\b"
)

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
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def _fetch_text(url: str, timeout: int = 12) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


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


def search_duckduckgo(query: str, max_results: int = 5) -> list[dict]:
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
    return results


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
    if re.search(r"(?i)\b(world\s*cup|worldcup|fifa)\b", query) and re.search(
        r"(?i)\b(next|upcoming|schedule|fixture|when|where|match|game)\b", query
    ):
        return f"FIFA World Cup next match schedule venue 2026 {query}"
    if re.search(r"(?i)\b(next|upcoming|schedule|fixture)\b", query) and re.search(
        r"(?i)\b(match|game|playoff|final|tournament|vs\.?)\b", query
    ):
        return f"{query} schedule date time venue"
    return query


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


def _parse_espn_event(event: dict) -> dict | None:
    comp = (event.get("competitions") or [{}])[0]
    competitors = comp.get("competitors") or []
    if len(competitors) < 2:
        return None
    teams = " vs ".join(c.get("team", {}).get("displayName", "?") for c in competitors[:2])
    scores = " — ".join(
        f"{c.get('team', {}).get('displayName', '?')} {c.get('score', '0')}"
        for c in competitors[:2]
    )
    venue = comp.get("venue") or {}
    status = comp.get("status", {}).get("type", {})
    kickoff_raw = event.get("date") or comp.get("date")
    if not kickoff_raw:
        return None
    kickoff = datetime.fromisoformat(kickoff_raw.replace("Z", "+00:00"))
    return {
        "teams": teams,
        "scores": scores,
        "venue": venue.get("fullName") or "TBD",
        "city": (venue.get("address") or {}).get("city") or "",
        "kickoff": kickoff,
        "state": status.get("state") or "",
        "status": status.get("description") or status.get("shortDetail") or "",
    }


def _fetch_espn_events(sport: str, league: str, day: date) -> list[dict]:
    url = (
        f"https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard"
        f"?dates={day.strftime('%Y%m%d')}"
    )
    data = _fetch_json(url)
    events: list[dict] = []
    for raw in data.get("events") or []:
        parsed = _parse_espn_event(raw)
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
        place = f"{nxt['venue']}, {nxt['city']}".strip(", ")
        lines.extend(
            [
                f"**Next match:** {nxt['teams']}",
                f"- **When:** {_format_kickoff(nxt['kickoff'])}",
                f"- **Where:** {place}",
            ]
        )
    elif finished:
        last = finished[-1]
        lines.append(f"**Latest result:** {last['scores']} ({last['status']})")
    else:
        lines.append("No upcoming fixtures found in the next few days.")

    if today_events:
        lines.extend(["", "**Today's games:**"])
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


def handle_wikipedia(query: str) -> HandlerResult | None:
    m = WIKI_PATTERN.match(query.strip())
    if not m:
        return None
    topic = m.group(1).strip(" ?.")
    if len(topic) < 2 or re.search(r"(?i)\b(draft|write|email|explain|code|function)\b", topic):
        return None
    try:
        result = _wikipedia_extract(topic)
    except (urllib.error.URLError, ValueError, KeyError):
        return None
    if not result:
        return None
    extract, wiki_url = result
    snippet = extract if len(extract) <= 900 else extract[:900].rsplit(" ", 1)[0] + "…"
    answer = f"**{topic.title()}** (via Wikipedia):\n\n{snippet}"
    return HandlerResult(
        direct_answer=answer,
        context_blocks=[answer],
        sources=[{"title": f"Wikipedia · {topic.title()}", "snippet": snippet[:300], "url": wiki_url}],
        handler="wikipedia",
        source_label="Wikipedia",
        live_data=True,
        use_direct=True,
    )


def handle_ddg_instant(query: str) -> HandlerResult | None:
    if WIKI_PATTERN.match(query.strip()):
        return None
    if not re.search(r"(?i)^(who|what|when|where|how many|how much)\b", query.strip()):
        return None
    if re.search(r"(?i)\b(draft|write|code|explain|email|weather|price|score|schedule)\b", query):
        return None
    hit = search_ddg_instant(query)
    if not hit:
        return None
    answer = f"**{hit['title']}**\n\n{hit['snippet']}"
    use_direct = bool(DIRECT_INTENT.search(query))
    return HandlerResult(
        direct_answer=answer if use_direct else None,
        context_blocks=[answer],
        sources=[{"title": hit["title"], "snippet": hit["snippet"], "url": hit["url"]}],
        handler="ddg_instant",
        source_label="DuckDuckGo Instant Answer",
        live_data=True,
        use_direct=use_direct,
    )


HANDLERS: list[tuple[str, object]] = [
    ("time", handle_time),
    ("fx", handle_fx),
    ("crypto", handle_crypto),
    ("weather", handle_weather),
    ("espn", handle_espn_sports),
    ("wikipedia", handle_wikipedia),
    ("ddg_instant", handle_ddg_instant),
]


def run_handlers(query: str) -> HandlerResult:
    merged = HandlerResult()
    for _name, handler in HANDLERS:
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


def build_web_context(query: str) -> dict:
    """
    Returns dict with: context, direct_answer, sources, handler, source_label, live_data.
    """
    cache_key = query.strip().lower()
    cached = _cache_get(cache_key)
    if cached:
        return cached

    now_line = _now_line()
    handler_out = run_handlers(query)

    fx_block = ""
    pair = detect_fx_pair(query)
    if pair and not any("Live exchange rate" in b for b in handler_out.context_blocks):
        try:
            fx = fetch_exchange_rate(pair[0], pair[1])
            fx_block = format_fx_answer(fx)
            handler_out.context_blocks.append(fx_block)
            handler_out.sources.append(
                {"title": f"Live FX: {pair[0]}/{pair[1]}", "snippet": fx_block, "url": "https://open.er-api.com"}
            )
        except (urllib.error.URLError, ValueError, KeyError):
            pass

    search_query = refine_search_query(query)
    results: list[dict] = []
    try:
        results = search_duckduckgo(search_query, max_results=5)
        handler_out.sources.extend(results)
    except urllib.error.URLError as e:
        if not handler_out.context_blocks and not handler_out.direct_answer:
            out = {
                "context": f"Web search failed: {e}",
                "direct_answer": None,
                "sources": handler_out.sources,
                "handler": handler_out.handler,
                "source_label": handler_out.source_label,
                "live_data": handler_out.live_data,
            }
            return out

    extracted = extract_facts_from_results(results) if results else []
    lines = [now_line, ""]
    if handler_out.direct_answer and handler_out.use_direct:
        context = f"{now_line}\n\n{handler_out.direct_answer}"
        out = {
            "context": context,
            "direct_answer": handler_out.direct_answer,
            "sources": handler_out.sources,
            "handler": handler_out.handler,
            "source_label": handler_out.source_label,
            "live_data": handler_out.live_data,
        }
        _cache_set(cache_key, out)
        return out

    lines.append("Web search results (use these — they are more current than your training data):")
    lines.append("")
    for block in handler_out.context_blocks:
        lines.extend([block, ""])
    if extracted:
        lines.append("Extracted facts from search snippets:")
        lines.extend(extracted)
        lines.append("")
    for n, r in enumerate(results, 1):
        lines.append(f"{n}. {r['title']}")
        if r.get("snippet"):
            lines.append(f"   {r['snippet']}")

    context = "\n".join(lines)
    out = {
        "context": context,
        "direct_answer": None,
        "sources": handler_out.sources,
        "handler": handler_out.handler,
        "source_label": handler_out.source_label,
        "live_data": handler_out.live_data,
    }
    _cache_set(cache_key, out)
    return out
