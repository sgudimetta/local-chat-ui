const messagesEl = document.getElementById("messages");
const chatForm = document.getElementById("chat-form");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const modelSelect = document.getElementById("model-select");
const newChatBtn = document.getElementById("new-chat");
const stopBtn = document.getElementById("stop-btn");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const chatListEl = document.getElementById("chat-list");
const chatListLabel = document.getElementById("chat-list-label");

const webSearchToggle = document.getElementById("web-search");
const fastModeToggle = document.getElementById("fast-mode");
const unloadOnCloseToggle = document.getElementById("unload-on-close");

const SETTINGS_KEY = "localChat.settings";
const CHATS_KEY = "localChat.chats";
const LEGACY_CHAT_KEY = "localChat.session";
const MAX_CHATS = 100;

const LIMITS = {
  fast: { messages: 16, chars: 8000 },
  quality: { messages: 40, chars: 28000 },
};

const DEFAULTS = {
  webSearch: true,
  fastMode: false,
  unloadOnClose: true,
};

/** @type {{ id: string, title: string, draftTitle?: string, systemPrompt: string, history: { role: string, content: string }[], updatedAt: number }[]} */
let chats = [];
let activeChatId = null;
let streaming = false;

function newChatId() {
  return crypto.randomUUID?.() || `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function getActiveChat() {
  return chats.find((c) => c.id === activeChatId) || null;
}

function titleFromText(text) {
  let clean = text.replace(/\s+/g, " ").trim();
  if (!clean || /^\/(?:system|s)\b/i.test(clean)) return "New chat";

  clean = clean.replace(/\?+$/, "").trim();

  const prefixes = [
    /^(?:please\s+)?(?:can you|could you|would you)\s+(?:help me\s+)?(?:with\s+)?/i,
    /^(?:please\s+)?(?:give me|show me|tell me|list|suggest|recommend)\s+(?:some\s+)?/i,
    /^(?:i want|i need|i'd like|i would like)\s+(?:some\s+)?/i,
    /^(?:what are|what is|what's|how do i|how to|how can i)\s+(?:the\s+)?/i,
    /^please\s+/i,
  ];
  for (const pattern of prefixes) {
    clean = clean.replace(pattern, "").trim();
  }

  if (clean) {
    clean = clean.charAt(0).toUpperCase() + clean.slice(1);
  }

  return clean.length > 42 ? `${clean.slice(0, 42)}…` : clean || "New chat";
}

function displayTitle(chat) {
  if (chat.history.length) return chat.title;
  if (chat.draftTitle && chat.draftTitle !== "New chat") return chat.draftTitle;
  return chat.title;
}

function titleFromHistory(hist) {
  const firstUser = hist.find((m) => m.role === "user");
  return firstUser ? titleFromText(firstUser.content) : "New chat";
}

function truncate(text, max = 36) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function parseSystemCommand(text) {
  const match = text.match(/^\/(?:system|s)\s+(.*)$/is);
  if (!match) return { isCommand: false };
  const body = match[1].trim();
  if (/^clear$/i.test(body)) return { isCommand: true, clear: true };
  if (!body) return { isCommand: true, empty: true };
  return { isCommand: true, prompt: body };
}

function updateComposerPlaceholder() {
  const chat = getActiveChat();
  if (!chat) {
    userInput.placeholder = "Type /system instructions for this chat, or just ask…";
    return;
  }
  if (chat.systemPrompt?.trim()) {
    userInput.placeholder = "Message this chat, or /system to change instructions…";
  } else if (!chat.history.length) {
    userInput.placeholder = "Type /system instructions for this chat, or just ask…";
  } else {
    userInput.placeholder = "Message this chat, or /system to add instructions…";
  }
}

function contextLimits() {
  return fastModeToggle?.checked ? LIMITS.fast : LIMITS.quality;
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    webSearchToggle.checked = saved.webSearch ?? DEFAULTS.webSearch;
    fastModeToggle.checked = saved.fastMode ?? DEFAULTS.fastMode;
    unloadOnCloseToggle.checked = saved.unloadOnClose ?? DEFAULTS.unloadOnClose;
  } catch {
    webSearchToggle.checked = DEFAULTS.webSearch;
    fastModeToggle.checked = DEFAULTS.fastMode;
    unloadOnCloseToggle.checked = DEFAULTS.unloadOnClose;
  }
}

function trimHistoryFor(chat) {
  const { messages: maxMsg, chars: maxChars } = contextLimits();
  while (chat.history.length > maxMsg) {
    chat.history.shift();
  }
  let total = chat.history.reduce((n, m) => n + (m.content?.length || 0), 0);
  while (total > maxChars && chat.history.length > 2) {
    const removed = chat.history.shift();
    total -= removed.content?.length || 0;
  }
}

function trimHistory() {
  const chat = getActiveChat();
  if (chat) trimHistoryFor(chat);
}

function saveChats() {
  while (chats.length > MAX_CHATS) {
    const removable = [...chats]
      .filter((c) => c.id !== activeChatId && c.history.length === 0)
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (removable) {
      chats = chats.filter((c) => c.id !== removable.id);
    } else {
      const oldest = [...chats]
        .filter((c) => c.id !== activeChatId)
        .sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!oldest) break;
      chats = chats.filter((c) => c.id !== oldest.id);
    }
  }

  try {
    localStorage.setItem(
      CHATS_KEY,
      JSON.stringify({
        activeId: activeChatId,
        chats,
      })
    );
  } catch {
    for (const chat of chats) {
      if (chat.id !== activeChatId && chat.history.length > 4) {
        chat.history = chat.history.slice(-Math.floor(chat.history.length / 2));
      }
    }
    try {
      localStorage.setItem(CHATS_KEY, JSON.stringify({ activeId: activeChatId, chats }));
    } catch {
      /* ignore */
    }
  }
  renderChatList();
}

function migrateLegacySession() {
  const legacy = localStorage.getItem(LEGACY_CHAT_KEY);
  if (!legacy) return;
  try {
    const data = JSON.parse(legacy);
    if (Array.isArray(data.history) && data.history.length) {
      const id = newChatId();
      chats.push({
        id,
        title: titleFromHistory(data.history),
        systemPrompt: "",
        history: data.history.filter((m) => m.role && m.content),
        updatedAt: data.savedAt || Date.now(),
      });
      activeChatId = id;
    }
  } catch {
    /* ignore */
  }
  localStorage.removeItem(LEGACY_CHAT_KEY);
}

function loadChats() {
  try {
    const raw = localStorage.getItem(CHATS_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data.chats)) {
        chats = data.chats
          .filter((c) => c.id && Array.isArray(c.history))
          .map((c) => ({
            id: c.id,
            title: c.title || titleFromHistory(c.history) || "New chat",
            draftTitle: c.draftTitle || "",
            systemPrompt: c.systemPrompt || "",
            history: c.history.filter((m) => m.role && m.content),
            updatedAt: c.updatedAt || Date.now(),
          }));
        activeChatId = data.activeId && chats.some((c) => c.id === data.activeId)
          ? data.activeId
          : chats[0]?.id || null;
      }
    }
  } catch {
    chats = [];
    activeChatId = null;
  }

  migrateLegacySession();

  if (!chats.length) {
    createChat({ activate: true, render: false });
  } else if (!activeChatId) {
    activeChatId = chats[0].id;
  }
}

function renderChatList() {
  if (!chatListEl) return;
  if (chatListLabel) {
    chatListLabel.textContent = chats.length ? `Chats (${chats.length})` : "Chats";
  }
  chatListEl.innerHTML = "";
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const chat of sorted) {
    const item = document.createElement("div");
    item.className = `chat-item${chat.id === activeChatId ? " active" : ""}`;
    item.title = chat.systemPrompt?.trim() || displayTitle(chat);
    item.dataset.chatId = chat.id;
    item.setAttribute("role", "button");
    item.tabIndex = 0;

    const row = document.createElement("div");
    row.className = "chat-item-row";

    const title = document.createElement("span");
    title.className = "chat-item-title";
    const shown = displayTitle(chat);
    title.textContent = shown;
    if (!chat.history.length && chat.draftTitle && chat.draftTitle !== "New chat") {
      title.classList.add("is-draft");
    }

    const del = document.createElement("button");
    del.type = "button";
    del.className = "chat-item-delete";
    del.title = "Delete chat";
    del.setAttribute("aria-label", "Delete chat");
    del.textContent = "×";

    row.appendChild(title);
    row.appendChild(del);

    const subtitle = document.createElement("span");
    subtitle.className = "chat-item-subtitle";
    if (chat.systemPrompt?.trim()) {
      subtitle.classList.add("has-instructions");
      subtitle.textContent = truncate(chat.systemPrompt, 40);
    } else {
      subtitle.textContent = "No instructions";
    }

    item.appendChild(row);
    item.appendChild(subtitle);

    item.addEventListener("click", (e) => {
      if (e.target.closest(".chat-item-delete")) return;
      selectChat(chat.id);
    });
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectChat(chat.id);
      }
    });
    del.addEventListener("click", (e) => deleteChat(chat.id, e));
    chatListEl.appendChild(item);
  }

  const activeEl = chatListEl.querySelector(".chat-item.active");
  if (activeEl) {
    activeEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function renderMessages() {
  const chat = getActiveChat();
  messagesEl.innerHTML = "";
  if (chat?.systemPrompt?.trim()) {
    appendSystemBanner(chat.systemPrompt);
  }
  if (!chat || !chat.history.length) {
    if (!chat?.systemPrompt?.trim()) renderWelcome();
    return;
  }
  for (const msg of chat.history) {
    appendMessage(msg.role === "user" ? "user" : "assistant", msg.content);
  }
}

function appendSystemBanner(text) {
  const el = document.createElement("div");
  el.className = "system-banner";
  el.innerHTML = `
    <div class="system-banner-label">Instructions for this chat</div>
    <div>${formatContent(text)}</div>
  `;
  messagesEl.appendChild(el);
}

function appendSystemNotice(text) {
  clearWelcome();
  const wrap = document.createElement("div");
  wrap.className = "message system-notice";
  wrap.innerHTML = `<div class="message-content">${formatContent(text)}</div>`;
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderWelcome() {
  messagesEl.innerHTML = `
    <div class="welcome">
      <h1>Chat locally</h1>
      <p>Local Ollama inference · Set per-chat instructions with <code>/system …</code> in the box below</p>
      <div class="suggestions">
        <button type="button" class="suggestion" data-prompt="What's the current USD to INR exchange rate?">USD → INR rate</button>
        <button type="button" class="suggestion" data-prompt="Write a Python function to merge two sorted lists.">Merge sorted lists</button>
        <button type="button" class="suggestion" data-prompt="Summarize the pros and cons of local vs cloud LLMs.">Local vs cloud LLMs</button>
      </div>
    </div>
  `;
  bindSuggestions();
}

function createChat({ activate = true, render = true } = {}) {
  if (chats.length >= MAX_CHATS) {
    alert(`Maximum ${MAX_CHATS} chats reached. Delete old chats to add more.`);
    return null;
  }
  const chat = {
    id: newChatId(),
    title: "New chat",
    systemPrompt: "",
    history: [],
    updatedAt: Date.now(),
  };
  chats.unshift(chat);
  if (activate) {
    activeChatId = chat.id;
    if (render) {
      renderMessages();
      saveChats();
      updateComposerPlaceholder();
      userInput.focus();
    }
  }
  return chat;
}

function selectChat(id) {
  if (streaming) return;
  if (id === activeChatId) {
    renderChatList();
    userInput.focus();
    return;
  }
  activeChatId = id;
  renderMessages();
  renderChatList();
  updateComposerPlaceholder();
  userInput.focus();
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify({ activeId: activeChatId, chats }));
  } catch {
    /* ignore */
  }
}

function deleteChat(id, e) {
  e.stopPropagation();
  if (streaming) return;
  const chat = chats.find((c) => c.id === id);
  if (!chat) return;
  if (chat.history.length && !confirm(`Delete "${chat.title}"?`)) return;

  chats = chats.filter((c) => c.id !== id);
  if (!chats.length) {
    createChat({ activate: true, render: true });
    return;
  }
  if (activeChatId === id) {
    activeChatId = chats[0].id;
    renderMessages();
    updateComposerPlaceholder();
  }
  saveChats();
}

function saveChat() {
  const chat = getActiveChat();
  if (!chat) return;
  chat.updatedAt = Date.now();
  saveChats();
}

/** Web search on follow-ups only when the message likely needs live data. */
function shouldWebSearch(text) {
  if (!webSearchToggle?.checked) return false;
  const chat = getActiveChat();
  if (!chat || chat.history.length <= 1) return true;
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
    })
  );
}

function applySystemPrompt(chat, text) {
  const cmd = parseSystemCommand(text);
  if (!cmd.isCommand) return false;

  if (cmd.empty) {
    appendSystemNotice("Usage: `/system Your instructions here` or `/system clear`");
    return true;
  }

  if (cmd.clear) {
    chat.systemPrompt = "";
    chat.updatedAt = Date.now();
    saveChats();
    renderMessages();
    appendSystemNotice("Instructions cleared for this chat.");
  } else {
    chat.systemPrompt = cmd.prompt;
    chat.updatedAt = Date.now();
    saveChats();
    renderMessages();
    appendSystemNotice(`Instructions set for this chat:\n\n${cmd.prompt}`);
  }

  updateComposerPlaceholder();
  return true;
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
  const chat = getActiveChat();
  const msgs = [];
  const sys = chat?.systemPrompt?.trim();
  if (sys) msgs.push({ role: "system", content: sys });
  msgs.push(...(chat?.history || []));
  return {
    model: modelSelect.value,
    messages: msgs,
    stream: true,
    fast_mode: fastModeToggle?.checked ?? false,
    web_search: shouldWebSearch(chat?.history[chat.history.length - 1]?.content || ""),
  };
}

async function sendMessage(text) {
  if (!text.trim() || streaming || !modelSelect.value) return;

  let chat = getActiveChat();
  if (!chat) {
    chat = createChat({ activate: true, render: false });
    if (!chat) return;
  }

  if (applySystemPrompt(chat, text.trim())) {
    return;
  }

  streaming = true;
  sendBtn.disabled = true;
  userInput.disabled = true;

  chat.history.push({ role: "user", content: text.trim() });
  chat.title = titleFromText(text.trim());
  chat.draftTitle = "";
  renderChatList();
  trimHistoryFor(chat);
  appendMessage("user", text.trim());

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

    chat.history.push({ role: "assistant", content: full });
    trimHistoryFor(chat);
    saveChat();
  } catch (e) {
    contentEl.classList.remove("cursor-blink");
    contentEl.innerHTML = `<span class="thinking">Error: ${escapeHtml(e.message)}</span>`;
    chat.history.pop();
    saveChat();
  } finally {
    streaming = false;
    sendBtn.disabled = false;
    userInput.disabled = false;
    userInput.focus();
  }
}

function newChat() {
  if (streaming) return;
  createChat({ activate: true, render: true });
}

let draftTitleTimer = null;
function updateDraftTitle() {
  const chat = getActiveChat();
  if (!chat || chat.history.length) return;
  const next = titleFromText(userInput.value);
  chat.draftTitle = next === "New chat" ? "" : next;
  renderChatList();
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
  clearTimeout(draftTitleTimer);
  draftTitleTimer = setTimeout(updateDraftTitle, 120);
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
  warmModel();
});
unloadOnCloseToggle.addEventListener("change", saveSettings);
modelSelect.addEventListener("change", warmModel);

window.addEventListener("beforeunload", () => {
  if (unloadOnCloseToggle.checked) unloadModels();
});
window.addEventListener("pagehide", () => {
  if (unloadOnCloseToggle.checked) unloadModels();
});

loadSettings();
loadChats();
renderChatList();
renderMessages();
saveChats();
updateComposerPlaceholder();
bindSuggestions();
loadModels();
