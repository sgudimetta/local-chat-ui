# Local Chat UI

A simple ChatGPT-style chat app that runs entirely on your Mac. It uses **Ollama** for local AI and optional **web search** for live facts — exchange rates, weather, sports scores, crypto prices, and more.

**No npm. No Docker. No API keys.** Python 3 (already on macOS) + Ollama only.

---

## Quick start (5 minutes)

If you already have Homebrew and Ollama:

```bash
git clone https://github.com/sgudimetta/local-chat-ui.git ~/local-chat-ui
cd ~/local-chat-ui
chmod +x start.sh
./start.sh
```

Then open **http://127.0.0.1:8080** in Safari or Chrome.

Keep the Terminal window open while you chat.

---

## Full setup for beginners (new Mac)

### What you need

| Required | Not required |
|----------|--------------|
| macOS + Terminal | Docker |
| Python 3 (pre-installed) | Node.js / npm |
| Ollama (free) | OpenAI / Anthropic keys |
| ~5 GB disk for a small model | Cloud AI account |
| Internet (only if web search is on) | |

### Step 1 — Open Terminal

`Applications → Utilities → Terminal`

### Step 2 — Install Homebrew (skip if you have it)

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew --version
```

### Step 3 — Install Ollama

```bash
brew install ollama
brew services start ollama
```

Or download from [ollama.com/download](https://ollama.com/download) and open the app once.

Verify it works:

```bash
curl -s http://127.0.0.1:11434/api/tags
```

You should see JSON (the models list may be empty at first).

### Step 4 — Download a model

Check your RAM:

```bash
sysctl -n hw.memsize | awk '{print $0/1024/1024/1024 " GB RAM"}'
```

| Your RAM | Recommended | Command |
|----------|-------------|---------|
| 16 GB | Llama 3.1 8B | `ollama pull llama3.1:8b` |
| 16 GB | Llama 3.2 1B (faster, weaker) | `ollama pull llama3.2:1b` |
| 32–64 GB | Qwen3 32B (best general) | `ollama pull qwen3:32b` |
| 32–64 GB | Qwen2.5 Coder 32B (coding) | `ollama pull qwen2.5-coder:32b` |
| 32–64 GB | DeepSeek-R1 32B (reasoning) | `ollama pull deepseek-r1:32b` |

On a **64 GB personal Mac**, the UI auto-selects a 32B model if installed and shows a hint under the model picker. Your model choice is remembered across sessions.

Starter command (works on most Macs):

```bash
ollama pull llama3.1:8b
ollama list
```

Quick test:

```bash
ollama run llama3.1:8b "Say hello in one word."
```

Type `/bye` to exit.

**Corporate/work Mac:** Some employers block `ollama pull`. Use a personal Mac, or copy models from another machine.

### Step 5 — Get this app

```bash
git clone https://github.com/sgudimetta/local-chat-ui.git ~/local-chat-ui
cd ~/local-chat-ui
chmod +x start.sh
```

No git? Download the repo as ZIP from GitHub → Extract → `cd` into the folder.

### Step 6 — Run it

```bash
./start.sh
```

You should see:

```
Open →  http://127.0.0.1:8080
```

Open that URL in your browser.

### Step 7 — Confirm it works

1. Green dot bottom-left = Ollama connected  
2. Pick a model in the sidebar (e.g. `llama3.1:8b`)  
3. Ask: *"What's the current USD to INR exchange rate?"*  
4. With **Search the web** on, you should get a **live rate** with a green **Live · …** source badge — not an outdated guess  

Try a few more live queries:

- *"weather in Seattle today"*
- *"what time is it in Tokyo"*
- *"what is the bitcoin price"*
- *"when and where is the next FIFA world cup game"*

---

## How to use the UI

### Multiple chats

- **+ New chat** — always creates a new conversation in the sidebar (up to **100** chats, including blank ones)
- **Recent** list on the left — all saved chats, newest first (like Claude/Cowork)
- Click any chat to switch; **×** on hover deletes it
- Chat names auto-update from your first message
- **All chats persist** across refresh and server restart (`data/chats.json` + browser backup)
- On open/refresh you land on the **welcome screen** — your chats stay in the sidebar; click one to continue
- Creating a new chat **never removes** existing chats
- **Search chats** — filter the sidebar by title, instructions, or message text

### Stop, regenerate, edit

- **Stop** — click the orange stop button (or press **Esc**) while the assistant is generating
- **Regenerate** — on the last assistant reply, click **Regenerate** to try again
- **Edit** — on your last message, click **Edit** to change it and resend
- **Copy** — copy the last assistant reply to clipboard

### Project folder

Set **Project folder** in the sidebar (or env `CHAT_UI_REPO`). Required for Agent, Plan, and Debug modes.

### Chat modes (composer picker)

| Mode | What it does |
|------|----------------|
| **Ask** | Plain chat — no repo access |
| **Agent** | Auto-explores your project · proposes file edits (you approve) |
| **Plan** | Read-only exploration · structured implementation plan |
| **Debug** | Traces errors · proposes fixes for approval |

Shortcut: **⌘I** switches to Agent mode.

Relevant files are gathered automatically from your question — no `@file` syntax needed.

### Attach files

Click the **paperclip** to attach up to 5 files (512 KB each):

- **Any text-based file** — source code, config, logs, CSV, markdown, etc. (extension-agnostic; binary files like PDF/zip are skipped)
- **Images** — analyzed with a vision model when available

The model reads attached file contents and analyzes them in context. Ask e.g. *"Explain this code"* or *"Find bugs in the attached file."*

### Per-chat instructions

Set behavior for **this chat only** in the message box:

```
/system You are a Python tutor. Be concise.
```

Then ask your question normally. Change anytime with `/system …` or clear with `/system clear`.

Instructions show in the sidebar under each chat and as a banner at the top of the thread.

### Web search & live facts

| Toggle / command | What it does |
|------------------|--------------|
| **Search the web** (sidebar, on by default) | Auto-detects when a question needs current data |
| `/search your query` | Force a web search for any message |

When live data is found, answers appear instantly with **source chips** under the message (e.g. *Live · ESPN*, *Live · Open-Meteo*).

**Built-in live sources (no API keys):**

| Topic | Example question | Source |
|-------|------------------|--------|
| Exchange rates | "USD to INR rate" | open.er-api.com |
| Weather | "weather in Boston today" | Open-Meteo |
| Crypto | "bitcoin price" | CoinGecko |
| Sports | "next NFL game", "FIFA schedule" | ESPN |
| Time zones | "what time is it in London" | Local clock |
| Facts | "who is …", "what is …" | Wikipedia / DuckDuckGo |

Creative tasks (draft email, write code, explain a concept) **do not** trigger web search unless you use `/search`.

**Verify before answering** — questions about *latest* versions, release dates, or support status (e.g. *"when was the latest Java version released?"*) automatically:
1. Search the web first (you'll see **Checking sources…**)
2. Instruct the model to trust sources over its memory
3. Show source chips under the answer

Coding questions auto-use a **coder model** for that turn if you have one installed (e.g. `qwen2.5-coder:32b`), without changing your sidebar selection.

### Local models vs Claude / ChatGPT

This app runs **Ollama locally** — no API keys, no cloud bill, private on your Mac.

| | Local Chat (Ollama) | Claude Opus / Sonnet |
|--|---------------------|----------------------|
| Cost | Free (your hardware) | Paid API subscription |
| Privacy | Stays on your Mac | Sent to Anthropic servers |
| Recency | Training cutoff + web verify | Very current training + tools |
| Setup | `ollama pull …` | API key in a cloud app |

**Claude is not built into this app** — it would need an Anthropic API key and a different architecture. For comparable local quality on a 64 GB Mac, use **Qwen3 32B** or **DeepSeek-R1 32B** plus web verify for version/release facts.

### Sidebar toggles

| Toggle | Default | What it does |
|--------|---------|--------------|
| **Fast responses** | Off | Smaller context window — faster but less depth |
| **Search the web** | On | Live facts from the sources above |
| **Free RAM when I close tab** | On | Unloads the model when you close the browser |

Settings are saved in your browser (`localStorage`).

### Stop when done

| Action | How |
|--------|-----|
| Stop chat server | **Stop server** button in sidebar, or `Ctrl+C` in Terminal |
| Free model RAM | `ollama stop -a` |
| Stop Ollama entirely | `brew services stop ollama` |

---

## Daily workflow

**Start:**

```bash
brew services start ollama          # if not running
cd ~/local-chat-ui && ./start.sh
open http://127.0.0.1:8080
```

**Stop (light — may chat again later):**

```bash
Ctrl+C                             # stop chat UI
ollama stop llama3.1:8b            # free model RAM (use your model name)
```

**Stop (full — done for the day):**

```bash
Ctrl+C
ollama stop -a
brew services stop ollama
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Ollama offline" in sidebar | `brew services start ollama` |
| Connection refused on :8080 | Run `./start.sh` and keep Terminal open |
| Port 8080 already in use | `CHAT_UI_PORT=8081 ./start.sh` then open `http://127.0.0.1:8081` |
| Slow replies | Model too big for your RAM — try `llama3.2:1b` or enable **Fast responses** |
| Mac sluggish after use | `ollama stop -a` then `brew services stop ollama` |
| Web search fails | Check internet; corporate firewall may block DuckDuckGo or ESPN |
| Chats missing after restart | Check `data/chats.json` exists; start the server from the same folder |
| "+ New chat" not adding chats | Hard refresh the browser (`Cmd+Shift+R`) after updating |
| UI looks broken (vertical text) | Hard refresh (`Cmd+Shift+R`) — fixed in latest version |
| Git push blocked on work Mac | Push from a personal Mac or use GitHub web UI |
| GitHub 404 on work VPN | Clone works via Terminal; browser may be blocked by corporate proxy |

### Port already in use

```bash
lsof -i :8080                      # see what's using the port
CHAT_UI_PORT=8081 ./start.sh       # use a different port (safest)
open http://127.0.0.1:8081
```

---

## Environment variables (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAT_UI_PORT` | `8080` | Web UI port |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama API URL |
| `CHAT_UI_DATA_DIR` | `./data` | Where `chats.json` is stored |

Example:

```bash
CHAT_UI_PORT=8081 ./start.sh
```

---

## How it works

```
Browser (localhost:8080)
    ↓
server.py  — serves UI + proxies to Ollama + live data handlers
    ↓                    ↓
Ollama (localhost:11434)  Internet (web search / live APIs, if enabled)
    ↓
Local LLM model in RAM
```

- **LLM inference** stays on your machine  
- **Live facts** use free public APIs (ESPN, Open-Meteo, CoinGecko, etc.) — high-confidence answers skip the LLM entirely  
- **Fallback search** uses DuckDuckGo when no dedicated handler matches  
- **Chats** persist on disk in `data/chats.json`

---

## Project layout

```
local-chat-ui/
├── README.md
├── start.sh           # Start script — run this
├── server.py          # Python server + Ollama proxy + chat persistence
├── web_search.py      # Live data handlers (weather, sports, FX, crypto, …)
├── data/
│   └── chats.json     # Your conversations (created automatically, gitignored)
├── .gitignore
└── static/
    ├── index.html
    ├── styles.css
    └── app.js
```

---

## FAQ

**Does the model learn from my chats?**  
No. Weights are frozen. It only remembers messages **within each chat** until you delete it.

**Is my data sent to the cloud?**  
LLM inference is 100% local. Web search (if enabled) sends your query to public APIs for live facts only — not to OpenAI or Anthropic.

**Can I use this on Windows/Linux?**  
This guide is for macOS. The Python code may run elsewhere if Ollama is installed, but `start.sh` is written for Mac.

**Which GitHub branch should I use?**  
Use **`main`** — it has the latest features. The older `master` branch is stale.

---

## Self-contained gist (alternative)

If you cannot use git, the full source is also in this gist:

https://gist.github.com/sgudimetta/f8e49a99856429fe284e4afcc2fa022a

Note: some corporate networks block `gist.github.com` — use this GitHub repo instead.
