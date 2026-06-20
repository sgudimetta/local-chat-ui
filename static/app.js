const messagesEl = document.getElementById("messages");
const chatForm = document.getElementById("chat-form");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const modelSelect = document.getElementById("model-select");
const systemPrompt = document.getElementById("system-prompt");
const newChatBtn = document.getElementById("new-chat");
const stopBtn = document.getElementById("stop-btn");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");

const webSearchToggle = document.getElementById("web-search");
const fastModeToggle = document.getElementById("fast-mode");
const unloadOnCloseToggle = document.getElementById("unload-on-close");

const SETTINGS_KEY = "localChat.settings";
const CHAT_KEY = "localChat.session";

const contextInfo = document.getElementById("context-info");

const LIMITS = {
  fast: { messages: 16, chars: 8000 },
  quality: { messages: 40, chars: 28000 },
};

const DEFAULTS = {
  webSearch: true,
  fastMode: false,
  unloadOnClose: true,
  systemPrompt:
    "You are a thoughtful assistant. Reason carefully before answering, but keep replies direct and concise—no filler or repetition. Remember earlier messages in this conversation and refer back to them when relevant. When web search results are provided, use them for current facts, numbers, and dates instead of your training data.",
};

/** @type {{ role: string, content: string }[]} */
let history = [];
let streaming = false;

function contextLimits() {
  return fastModeToggle?.checked ? LIMITS.fast : LIMITS.quality;
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    webSearchToggle.checked = saved.webSearch ?? DEFAULTS.webSearch;
    fastModeToggle.checked = saved.fastMode ?? DEFAULTS.fastMode;
    unloadOnCloseToggle.checked = saved.unloadOnClose ?? DEFAULTS.unloadOnClose;
    if (saved.systemPrompt != null) {
      systemPrompt.value = saved.systemPrompt;
    }
  } catch {
    webSearchToggle.checked = DEFAULTS.webSearch;
    fastModeToggle.checked = DEFAULTS.fastMode;
    unloadOnCloseToggle.checked = DEFAULTS.unloadOnClose;
  }
}

function trimHistory() {
  const { messages: maxMsg, chars: maxChars } = contextLimits();
  while (history.length > maxMsg) {
    history.shift();
  }
  let total = history.reduce((n, m) => n + (m.content?.length || 0), 0);
  while (total > maxChars && history.length > 2) {
    const removed = history.shift();
    total -= removed.content?.length || 0;
  }
}

function updateContextInfo() {
  if (!contextInfo) return;
  const n = history.length;
  const chars = history.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  contextInfo.textContent =
    n === 0
      ? "Conversation: new chat (no prior context)"
      : `Conversation: ${n} message${n === 1 ? "" : "s"} in context · ~${Math.round(chars / 1000)}k chars`;
}

function saveChat() {
  try {
    localStorage.setItem(
      CHAT_KEY,
      JSON.stringify({
        history,
        savedAt: Date.now(),
      })
    );
  } catch {
    /* storage full — drop oldest half and retry once */
    history = history.slice(-Math.floor(history.length / 2));
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify({ history, savedAt: Date.now() }));
    } catch {
      /* ignore */
    }
  }
  updateContextInfo();
}

function restoreChat() {
  try {
    const raw = localStorage.getItem(CHAT_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.history) || !data.history.length) return;
    history = data.history.filter((m) => m.role && m.content);
    trimHistory();
    messagesEl.innerHTML = "";
    for (const msg of history) {
      appendMessage(msg.role === "user" ? "user" : "assistant", msg.content);
    }
    updateContextInfo();
  } catch {
    history = [];
  }
}

/** Web search on follow-ups only when the message likely needs live data. */
function shouldWebSearch(text) {
  if (!webSearchToggle?.checked) return false;
  if (history.length <= 1) return true;
  return /\b(current|today|latest|now|live|price|rate|news|weather|score|stock|exchange|usd|eur|inr|gbp|who is|what happened|how much|when did)\b/i.test(
    text
  );
}

function saveSettings() {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      webSearch: webSearchToggle.checked,
      fastMode: fastModeToggle.checked,
      unloadOnClose: unloadOnCloseToggle.checked,
      systemPrompt: systemPrompt.value,
    })
  );
}

function pickBestModel(models) {
  const priority = [
    (m) => /qwen3:32b|qwen3\.6:32b|qwen2\.5:32b/.test(m),
    (m) => /deepseek-r1:32b/.test(m),
    (m) => /deepseek-r1:14b|qwen3:14b/.test(m),
    (m) => /qwen3:8b|deepseek-r1:8b/.test(m),
    (m) => /llama3\.1:8b|llama3:8b/.test(m),
    (m) => /70b/.test(m),
    (m) => /32b/.test(m),
    (m) => /14b/.test(m),
    (m) => /8b/.test(m),
  ];
  for (const test of priority) {
    const match = models.find(test);
    if (match) return match;
  }
  return models[0];
}

async function warmModel() {
  const model = modelSelect.value;
  if (!model) return;
  try {
    await fetch("/api/warmup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, fast_mode: fastModeToggle?.checked ?? false }),
    });
  } catch {
    /* non-fatal */
  }
}

async function stopServer() {
  if (!confirm("Stop the chat server and free model RAM?\n\nStart again later with: ./start.sh")) {
    return;
  }
  stopBtn.disabled = true;
  stopBtn.textContent = "Stopping…";
  userInput.disabled = true;
  sendBtn.disabled = true;
  try {
    await fetch("/api/shutdown", { method: "POST" });
  } catch {
    /* server may already be shutting down */
  }
  messagesEl.innerHTML = `
    <div class="welcome">
      <h1>Server stopped</h1>
      <p>Model RAM freed. To chat again, run in Terminal:</p>
      <p><code>cd ~/local-chat-ui && ./start.sh</code></p>
    </div>
  `;
  setStatus(false, "Server stopped");
}

async function unloadModels() {
  try {
    await fetch("/api/unload", { method: "POST", keepalive: true });
  } catch {
    /* tab may already be closing */
  }
}

function setStatus(ok, text) {
  statusDot.className = "status-dot " + (ok ? "ok" : "err");
  statusText.textContent = text;
}

async function loadModels() {
  try {
    const res = await fetch("/api/models");
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    modelSelect.innerHTML = "";
    const models = (data.models || []).map((m) => m.name).sort();
    if (!models.length) {
      modelSelect.innerHTML = '<option value="">No models found</option>';
      setStatus(false, "No Ollama models");
      return;
    }
    for (const name of models) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      modelSelect.appendChild(opt);
    }
    const preferred = pickBestModel(models);
    modelSelect.value = preferred;
    setStatus(true, `Ollama · ${models.length} model(s)`);
    warmModel();
  } catch (e) {
    setStatus(false, "Ollama offline");
    modelSelect.innerHTML = '<option value="">Unavailable</option>';
    showError("Cannot reach Ollama. Start it with: brew services start ollama");
  }
}

function clearWelcome() {
  const welcome = messagesEl.querySelector(".welcome");
  if (welcome) welcome.remove();
}

function showError(text) {
  clearWelcome();
  const el = document.createElement("div");
  el.className = "error-banner";
  el.textContent = text;
  messagesEl.appendChild(el);
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatContent(text) {
  let escaped = escapeHtml(text);
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return escaped.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  }).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function appendMessage(role, content, { streaming: isStream = false } = {}) {
  clearWelcome();
  const wrap = document.createElement("div");
  wrap.className = `message ${role}`;
  const roleLabel = role === "user" ? "You" : "Assistant";
  wrap.innerHTML = `
    <div class="message-role">${roleLabel}</div>
    <div class="message-content${isStream ? " cursor-blink" : ""}">${formatContent(content)}</div>
  `;
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrap.querySelector(".message-content");
}

function buildPayload() {
  const msgs = [];
  const sys = systemPrompt.value.trim();
  if (sys) msgs.push({ role: "system", content: sys });
  msgs.push(...history);
  return {
    model: modelSelect.value,
    messages: msgs,
    stream: true,
    fast_mode: fastModeToggle?.checked ?? false,
    web_search: shouldWebSearch(history[history.length - 1]?.content || ""),
  };
}

async function sendMessage(text) {
  if (!text.trim() || streaming || !modelSelect.value) return;

  streaming = true;
  sendBtn.disabled = true;
  userInput.disabled = true;

  history.push({ role: "user", content: text.trim() });
  trimHistory();
  appendMessage("user", text.trim());
  updateContextInfo();

  const useWeb = shouldWebSearch(text.trim());
  let contentEl;
  if (useWeb) {
    const wrap = document.createElement("div");
    wrap.className = "message assistant message-searching";
    wrap.innerHTML = `<div class="message-role">Assistant</div><div class="message-content">Searching the web…</div>`;
    messagesEl.appendChild(wrap);
    contentEl = wrap.querySelector(".message-content");
  } else {
    contentEl = appendMessage("assistant", "", { streaming: true });
  }
  let full = "";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload()),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || "Chat request failed");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line);
        if (chunk.search_meta) {
          contentEl.closest(".message")?.classList.remove("message-searching");
          if (!full) contentEl.innerHTML = "";
          contentEl.classList.add("cursor-blink");
        }
        if (chunk.message?.content) {
          full += chunk.message.content;
          contentEl.innerHTML = formatContent(full);
          contentEl.classList.add("cursor-blink");
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        if (chunk.done) {
          contentEl.classList.remove("cursor-blink");
        }
      }
    }

    history.push({ role: "assistant", content: full });
    trimHistory();
    saveChat();
  } catch (e) {
    contentEl.classList.remove("cursor-blink");
    contentEl.innerHTML = `<span class="thinking">Error: ${escapeHtml(e.message)}</span>`;
    history.pop();
    saveChat();
  } finally {
    streaming = false;
    sendBtn.disabled = false;
    userInput.disabled = false;
    userInput.focus();
  }
}

function newChat() {
  history = [];
  localStorage.removeItem(CHAT_KEY);
  updateContextInfo();
  messagesEl.innerHTML = `
    <div class="welcome">
      <h1>Chat locally</h1>
      <p>Local Ollama inference · Web search on by default for live facts</p>
      <div class="suggestions">
        <button type="button" class="suggestion" data-prompt="What's the current USD to INR exchange rate?">USD → INR rate</button>
        <button type="button" class="suggestion" data-prompt="Write a Python function to merge two sorted lists.">Merge sorted lists</button>
        <button type="button" class="suggestion" data-prompt="Summarize the pros and cons of local vs cloud LLMs.">Local vs cloud LLMs</button>
      </div>
    </div>
  `;
  bindSuggestions();
}

function bindSuggestions() {
  messagesEl.querySelectorAll(".suggestion").forEach((btn) => {
    btn.addEventListener("click", () => {
      userInput.value = btn.dataset.prompt;
      chatForm.requestSubmit();
    });
  });
}

userInput.addEventListener("input", () => {
  userInput.style.height = "auto";
  userInput.style.height = Math.min(userInput.scrollHeight, 200) + "px";
});

userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = userInput.value;
  userInput.value = "";
  userInput.style.height = "auto";
  sendMessage(text);
});

newChatBtn.addEventListener("click", newChat);
stopBtn.addEventListener("click", stopServer);

webSearchToggle.addEventListener("change", saveSettings);
fastModeToggle.addEventListener("change", () => {
  saveSettings();
  trimHistory();
  updateContextInfo();
  warmModel();
});
unloadOnCloseToggle.addEventListener("change", saveSettings);
modelSelect.addEventListener("change", warmModel);
systemPrompt.addEventListener("input", saveSettings);

window.addEventListener("beforeunload", () => {
  if (unloadOnCloseToggle.checked) unloadModels();
});
window.addEventListener("pagehide", () => {
  if (unloadOnCloseToggle.checked) unloadModels();
});

loadSettings();
bindSuggestions();
loadModels();
restoreChat();
updateContextInfo();
