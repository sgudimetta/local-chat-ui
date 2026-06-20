# Local Chat UI — Ollama + Web Search

A self-contained ChatGPT/Claude-style chat UI that runs on **localhost**. Uses **Ollama** for local LLM inference and optional **web search** for live facts (exchange rates, current events).

**Total files: 6** — no npm, no Docker, no pip packages. Python 3 stdlib only.

**GitHub repo (works on corporate networks):** https://github.com/sgudimetla/local-chat-ui  
**Gist (self-contained, all code embedded):** https://gist.github.com/sgudimetla/f8e49a99856429fe284e4afcc2fa022a  
*(Some corporate networks block `gist.github.com` — use the repo link instead.)*

---

## Fastest install (clone the repo)

```bash
git clone https://github.com/sgudimetla/local-chat-ui.git ~/local-chat-ui
cd ~/local-chat-ui
chmod +x start.sh
./start.sh
open http://127.0.0.1:8080
```

---

A self-contained ChatGPT/Claude-style chat UI that runs on **localhost**. Uses **Ollama** for local LLM inference and optional **web search** for live facts (exchange rates, current events).

**Total files: 6** — no npm, no Docker, no pip packages. Python 3 stdlib only.

**Gist (source of truth):** https://gist.github.com/sgudimetta/f8e49a99856429fe284e4afcc2fa022a

---

## Complete setup from a new Mac (start here)

This section assumes a **fresh Mac** with internet. You do **not** need Docker, Node.js, or npm. Claude (app or Cursor) is optional — it can help you create the files, but the app itself runs via Terminal + Ollama.

### What you need vs. what you don't

| Required | Not required |
|----------|--------------|
| macOS with Terminal | Docker |
| Python 3 (pre-installed on macOS) | Node.js / npm |
| Ollama (free) | OpenAI / Anthropic API keys |
| ~5 GB disk for a small model | A GitHub repo clone |
| Internet (for web search toggle) | Cursor or Claude to *run* the app |

### Step 0 — Open Terminal

`Applications → Utilities → Terminal`

### Step 1 — Install Homebrew (skip if you already have it)

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Verify:

```bash
brew --version
```

### Step 2 — Install Ollama

**Option A — Homebrew (recommended):**

```bash
brew install ollama
brew services start ollama
```

**Option B — Direct download:**

1. Go to https://ollama.com/download
2. Install the macOS app
3. Open Ollama once (menu bar icon should appear)

Verify Ollama is running:

```bash
curl -s http://127.0.0.1:11434/api/tags
```

You should see JSON like `{"models":[...]}` (may be empty if no models yet).

### Step 3 — Download a local model

#### Check your Mac specs first

```bash
# Total RAM
sysctl -n hw.memsize | awk '{print $0/1024/1024/1024 " GB RAM"}'

# Chip (Apple Silicon vs Intel)
sysctl -n machdep.cpu.brand_string

# Architecture
uname -m   # arm64 = Apple Silicon, x86_64 = Intel
```

#### Which model to download

Pick the **largest model that fits entirely in RAM**. If the model spills to disk/CPU, responses crawl (1–5 tokens/sec).

| Your RAM | Recommended model | `ollama pull` command | Download size | Best for |
|----------|-------------------|----------------------|---------------|----------|
| **8 GB** | Llama 3.2 3B or DeepSeek-R1 7B | `ollama pull llama3.2:3b` | ~2 GB | Light chat only |
| **16 GB** | Llama 3.1 8B or Qwen3 8B | `ollama pull llama3.1:8b` | ~5 GB | Daily chat + coding basics |
| **16 GB** | DeepSeek-R1 8B (reasoning) | `ollama pull deepseek-r1:8b` | ~5 GB | Math / logic |
| **24 GB** | DeepSeek-R1 14B | `ollama pull deepseek-r1:14b` | ~9 GB | Better reasoning |
| **32 GB** | Qwen3 32B or DeepSeek-R1 32B | `ollama pull qwen3:32b` | ~20 GB | Strong coding + chat |
| **48 GB** | DeepSeek-R1 32B (comfortable) | `ollama pull deepseek-r1:32b` | ~20 GB | Best quality at this tier |
| **64 GB+** | Qwen3 32B + DeepSeek-R1 32B | both commands above | ~40 GB total | Pick per task in UI dropdown |
| **64 GB+** | DeepSeek-R1 70B (max quality, slower) | `ollama pull deepseek-r1:70b` | ~40 GB | Hardest reasoning (~10 tok/s) |

**Apple Silicon (M1/M2/M3/M4):** All models above work well — unified memory is ideal for local LLMs.

**Intel Mac:** Same RAM rules apply; prefer smaller quants (8B max on 16 GB).

**Work / corporate Mac:** Some companies block `ollama pull`. If blocked, use a personal Mac or USB-copy models from another machine.

#### Default starter (works on most Macs)

```bash
ollama pull llama3.1:8b
ollama list
```

#### Optional — pull a second model on 64 GB machines

```bash
ollama pull qwen3:32b          # better coding
ollama pull deepseek-r1:32b    # better reasoning
```

Both appear in the UI model dropdown automatically.

#### Quick test after download

```bash
ollama run llama3.1:8b "Say hello in one word."
```

Type `/bye` to exit.

Verify GPU is used (not CPU fallback) while model is loaded:

```bash
ollama ps
# Should show "100% GPU" on Apple Silicon
```

### Step 4 — Verify Python 3

```bash
python3 --version
```

Need 3.9+. macOS ships with Python 3 — no install needed.

### Step 5 — Create the project (choose one method)

#### Method A — Ask Claude / Cursor to scaffold from this file

Paste this entire README into Claude and say:

> Create the `local-chat-ui` folder in my home directory with all 6 files exactly as documented. Use the code blocks under each "File:" section. Then tell me the commands to run.

Claude should create:

```
~/local-chat-ui/
├── start.sh
├── server.py
├── web_search.py
└── static/
    ├── index.html
    ├── styles.css
    └── app.js
```

#### Method B — Manual copy from the gist README

```bash
mkdir -p ~/local-chat-ui/static
cd ~/local-chat-ui
```

Then create each file by copying the contents from the **File:** sections at the bottom of this document into:

- `start.sh`
- `server.py`
- `web_search.py`
- `static/index.html`
- `static/styles.css`
- `static/app.js`

#### Method C — Download gist raw file (if curl works; blocked on some corporate networks)

```bash
mkdir -p ~/local-chat-ui
curl -o ~/local-chat-ui/INSTRUCTIONS.md \
  https://gist.githubusercontent.com/sgudimetta/f8e49a99856429fe284e4afcc2fa022a/raw/README.md
```

Then use Claude to extract the 6 files from `INSTRUCTIONS.md`, or copy each section manually.

### Step 6 — Run the chat UI

```bash
cd ~/local-chat-ui
chmod +x start.sh
./start.sh
```

You should see:

```
Local Chat UI  →  http://127.0.0.1:8080
Ollama backend →  http://127.0.0.1:11434
```

Open **http://127.0.0.1:8080** in Safari or Chrome.

**Keep the Terminal window open** while using the chat.

### Step 7 — Verify it works

1. Green dot in sidebar bottom-left = Ollama connected
2. Select a model from the dropdown (e.g. `llama3.1:8b`)
3. Enable **Search the web** toggle
4. Ask: *"What's the current USD to INR exchange rate?"*
5. You should get a **live rate** (~94 INR), not an outdated training-data guess

### Step 8 — Daily use: start, stop, and save resources

Three things can consume RAM/CPU:

| Component | RAM when idle | RAM when active |
|-----------|---------------|-----------------|
| **Chat UI** (`server.py`) | ~30 MB | ~30 MB |
| **Ollama daemon** | ~200 MB | — |
| **Loaded model** (the big one) | 0 MB | 5–40 GB depending on model |

The **model in RAM** is what can slow your Mac or cause freezes — not the chat UI itself.

#### Start (when you want to use it)

```bash
# 1. Start Ollama (if not already running)
brew services start ollama

# 2. Start the chat UI
cd ~/local-chat-ui && ./start.sh

# 3. Open browser
open http://127.0.0.1:8080
```

#### Stop — light (keeps Ollama ready, frees model RAM)

Do this when you're done chatting but may come back later:

```bash
# Stop the chat UI — press Ctrl+C in the Terminal running ./start.sh

# Unload the model from RAM (important — frees 5–40 GB)
ollama ps                    # see what's loaded
ollama stop llama3.1:8b      # replace with your model name
```

Ollama auto-unloads models after **5 minutes** of inactivity by default. To unload immediately, use `ollama stop`.

#### Stop — full (maximum resource savings)

Do this when you're done for the day or your Mac feels sluggish:

```bash
# 1. Ctrl+C in the Terminal running ./start.sh (stops chat UI)

# 2. Stop all loaded models
ollama stop -a               # unload every loaded model

# 3. Stop the Ollama daemon entirely
brew services stop ollama

# Or: quit Ollama from the menu bar icon → Quit
```

Verify everything is freed:

```bash
ollama ps          # should show nothing
# Activity Monitor → Memory — model RAM should drop
```

#### Restart later

```bash
brew services start ollama
cd ~/local-chat-ui && ./start.sh
```

#### Avoiding freezes / "deadlock"

If your Mac gets slow or frozen while using local AI:

1. **Use a smaller model** — `llama3.1:8b` on 16 GB, not `qwen3:32b`
2. **Stop the model when done** — `ollama stop <model>` or `ollama stop -a`
3. **Stop Ollama when not needed** — `brew services stop ollama`
4. **Check what's eating RAM** — `ollama ps` shows loaded models and size
5. **Rule of thumb:** model Q4 size should be **less than ~70% of your total RAM** to leave headroom for macOS + apps

---

## Does the model get smarter the more I use it?

**No.** Local Ollama models do **not** learn or improve from your conversations.

| What happens | Does it learn? |
|--------------|----------------|
| You chat back and forth | ❌ Weights stay frozen |
| You click "New chat" | ❌ Previous chat is forgotten |
| You close the browser | ❌ History is gone (not saved to disk) |
| You use it for a month | ❌ Same intelligence as day one |
| You pull a newer model tag | ✅ Newer/better **version** from Ollama library |
| You switch to a bigger model | ✅ More capable model, not "learned" |

**Why it feels like it remembers:** Within a single chat session, the UI sends your conversation history to the model each turn — so it remembers **within that chat**, like Claude does in one thread. That is not learning; it is context window replay.

**How to actually get better answers over time:**

1. **Pull a better model** — e.g. upgrade from `llama3.1:8b` → `qwen3:32b` on a 64 GB Mac
2. **Enable web search** — live facts instead of stale training data
3. **Edit the system prompt** — steer tone and behavior in the sidebar
4. **Fine-tuning** (advanced, not built into this UI) — retrain weights on your own data; rarely worth it for personal use

**Cloud Claude vs local Ollama:** Claude (paid cloud) is updated by Anthropic behind the scenes. Your local model is a fixed snapshot from when it was downloaded until you `ollama pull` a newer version.

---

## Conversation context (within a chat)

The UI **does remember your chat** — both within a session and across browser refreshes.

| What | Behavior |
|------|----------|
| **Same chat thread** | Every message you send includes full prior history — the model sees the whole conversation |
| **Page refresh** | Chat restored from `localStorage` automatically |
| **New chat button** | Clears history and starts fresh |
| **Context limit** | Keeps last ~40 messages or ~28k characters (whichever hits first) so small models don't overflow |
| **Sidebar indicator** | Shows `N messages in context · ~Xk chars` |

**Smart web search:** With "Search the web" on, only the **first message** or messages asking for **live/current** info (rates, news, today, etc.) trigger a web search. Follow-ups like *"explain that more"* or *"what about EUR?"* use **conversation context** without replacing it with search results.

**Limitation:** This is **not learning** — the model doesn't get smarter over time. It only remembers messages **in the current chat** until you click New chat.

---


## Quick start (if Ollama is already installed)

### Prerequisites

1. **Python 3** (3.9+)
2. **Ollama** — [https://ollama.com](https://ollama.com)
3. At least one model pulled, e.g. `ollama pull llama3.1:8b`
4. **Internet** — only if using "Search the web" toggle

### Install Ollama (if needed)

```bash
# macOS
brew install ollama
brew services start ollama
ollama pull llama3.1:8b
```

### Create folder structure

Recreate this exact layout:

```
local-chat-ui/
├── start.sh
├── server.py
├── web_search.py
└── static/
    ├── index.html
    ├── styles.css
    └── app.js
```

### Run

```bash
cd local-chat-ui
chmod +x start.sh
./start.sh
```

Or directly:

```bash
python3 server.py
```

Open **http://127.0.0.1:8080**

### Environment variables (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAT_UI_PORT` | `8080` | Web UI port |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama API URL |

---

## Features

- Dark chat UI with streaming responses
- Model picker (auto-detects Ollama models)
- Editable system prompt
- **Search the web** toggle — **on by default** — DuckDuckGo + live FX rates (no API keys)
- **Free RAM when I close this tab** — **on by default** — unloads model from memory on exit
- Smart model picker — auto-selects best available model (32B > 14B > 8B)
- Improved default system prompt — prefers web search results for current facts
- Settings persist in browser (`localStorage`) across sessions
- **Conversation context** — history sent every turn; restored on page refresh
- **Smart web search** — live search on first/current-facts messages; follow-ups use chat context
- Context indicator in sidebar (`N messages in context`)
- Currency queries (e.g. USD → INR) return live rates directly
- 100% localhost for LLM inference

---

## Built-in defaults (no config needed)

These are **on by default** in the app — no setup required:

| Setting | Default | What it does |
|---------|---------|--------------|
| **Search the web** | ✅ On | Live FX rates, current facts via DuckDuckGo |
| **Free RAM on tab close** | ✅ On | Unloads Ollama model when you close the browser tab |
| **Stop server button** | Sidebar | Unloads model + shuts down chat UI (start again with `./start.sh`) |
| **Model picker** | Best available | Prefers `qwen3:32b` > `deepseek-r1:32b` > `14b` > `8b` |
| **System prompt** | Web-aware | Instructs model to use search results for current data |

Settings are saved in your browser (`localStorage`) so your toggles persist across visits.

**To fully stop everything when done for the day:**

```bash
Ctrl+C                          # stop chat UI (Terminal)
brew services stop ollama       # stop Ollama daemon
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Ollama offline" | `brew services start ollama` |
| Connection refused on :8080 | Run `python3 server.py` and keep terminal open |
| Slow responses | Model too large for RAM; use smaller model |
| Web search fails | Check internet; corporate firewall may block DuckDuckGo |
| Mac sluggish / frozen after use | `ollama stop -a` then `brew services stop ollama` |
| Model still using RAM after closing browser | `ollama ps` then `ollama stop <model>` — browser closing does not unload the model |
| Port 8080 already in use | See **Port already in use** section below — use `CHAT_UI_PORT=8081 ./start.sh` |

---

## Port already in use (`Address already in use` / `Errno 48`)

Port **8080** is the default. Another app (Docker, Jenkins, a previous Local Chat session, etc.) may already be using it.

### For humans — quick fix

**Use a different port (safest — does not kill other apps):**

```bash
cd ~/local-chat-ui
CHAT_UI_PORT=8081 ./start.sh
open http://127.0.0.1:8081
```

Other ports that usually work: `8082`, `8090`, `3000`, `8888`.

**Or free port 8080 (only if it's a stale Local Chat server):**

```bash
lsof -ti :8080 | xargs kill -9
./start.sh
```

### Check what's using a port

```bash
lsof -i :8080
# or
lsof -ti :8080
```

### For Claude / GPT — if the user hits a port conflict

When `./start.sh` or `python3 server.py` fails with **port already in use**, do this:

1. **Do not guess** — run `lsof -i :8080` (or whatever port failed) and tell the user what's occupying it.
2. **Prefer a new port** over killing unknown processes:
   ```bash
   CHAT_UI_PORT=8081 ./start.sh
   ```
3. **Open the matching URL** — if port is 8081, browser URL is `http://127.0.0.1:8081` (not 8080).
4. **Only kill the process** if `lsof` shows it's clearly a leftover `Python` Local Chat server from an earlier run:
   ```bash
   lsof -ti :8080 | xargs kill -9
   ```
5. **Persist the port** for the session:
   ```bash
   export CHAT_UI_PORT=8081
   ./start.sh
   ```
6. **Ollama is separate** — it always uses `11434`. Only the chat UI port changes.

| Variable | Default | Example |
|----------|---------|---------|
| `CHAT_UI_PORT` | `8080` | `CHAT_UI_PORT=8081 ./start.sh` |

The `start.sh` script checks the port **before** starting and prints these options automatically.

---

## For AI assistants

This document is the **single source of truth**. It contains setup instructions AND the complete source code for all 6 files.

**Your task when a user pastes this file:**

1. Create directory `~/local-chat-ui/static/`
2. Write these 6 files with contents from the sections below (exact paths):
   - `~/local-chat-ui/start.sh` — make executable (`chmod +x`)
   - `~/local-chat-ui/server.py`
   - `~/local-chat-ui/web_search.py`
   - `~/local-chat-ui/static/index.html`
   - `~/local-chat-ui/static/styles.css`
   - `~/local-chat-ui/static/app.js`
3. Ensure Ollama is installed and running (`brew services start ollama`)
4. Ensure at least one model is pulled (`ollama pull llama3.1:8b`)
5. Run: `cd ~/local-chat-ui && ./start.sh`
6. Tell user to open the URL printed by the server (default `http://127.0.0.1:8080`)
7. **If port 8080 is in use:** run `CHAT_UI_PORT=8081 ./start.sh` and open `http://127.0.0.1:8081` instead — do not kill unknown processes without checking `lsof -i :8080` first

**Do not omit files. Do not merge files. Do not add npm/Docker dependencies.**

---

## Architecture (how it works)

```
Browser (localhost:8080)
    ↓
server.py (Python — serves HTML/CSS/JS + API proxy)
    ↓                          ↓
Ollama (localhost:11434)    Internet (web search only, if toggled on)
    ↓
Local LLM model (llama3.1:8b, etc.)
```

- **LLM inference** stays on your machine (Ollama)
- **Web search** (optional) hits DuckDuckGo + open.er-api.com for live FX rates
- No cloud AI API needed to run this app

---

## Folder structure

```
local-chat-ui/
├── start.sh           # Launcher — checks Ollama, starts server
├── server.py          # HTTP server — static files + Ollama proxy + web search
├── web_search.py      # DuckDuckGo search + live exchange rates
└── static/
    ├── index.html     # Chat UI markup
    ├── styles.css     # Dark theme styles
    └── app.js         # Chat logic, streaming, model picker
```

---
