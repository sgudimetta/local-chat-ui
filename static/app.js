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
const chatSearchInput = document.getElementById("chat-search");
const modelHintEl = document.getElementById("model-hint");
const repoPathInput = document.getElementById("repo-path");
const repoSetBtn = document.getElementById("repo-set-btn");
const repoHintEl = document.getElementById("repo-hint");
const modeTrigger = document.getElementById("mode-trigger");
const modeMenu = document.getElementById("mode-menu");
const modeLabel = document.getElementById("mode-label");
const modeIcon = document.getElementById("mode-icon");
const modeHintEl = document.getElementById("mode-hint");
const modePicker = document.getElementById("mode-picker");

const webSearchToggle = document.getElementById("web-search");
const fileInput = document.getElementById("file-input");
const attachmentPreview = document.getElementById("attachment-preview");
const writeApprovalEl = document.getElementById("write-approval");
const writeApprovalPath = document.getElementById("write-approval-path");
const writeApprovalPreview = document.getElementById("write-approval-preview");
const writeApproveBtn = document.getElementById("write-approve");
const writeRejectBtn = document.getElementById("write-reject");
const attachBtn = document.getElementById("attach-btn");
const fastModeToggle = document.getElementById("fast-mode");
const unloadOnCloseToggle = document.getElementById("unload-on-close");

const CHAT_MODES = {
  agent: {
    label: "Agent",
    icon: "∞",
    hint: "Explores your project automatically · file edits need your approval",
    needsRepo: true,
    activity: "Working in your project",
  },
  plan: {
    label: "Plan",
    icon: "☰",
    hint: "Read-only codebase exploration · outputs a structured plan",
    needsRepo: true,
    activity: "Exploring your project",
  },
  debug: {
    label: "Debug",
    icon: "🐛",
    hint: "Traces errors in your codebase · proposes fixes for approval",
    needsRepo: true,
    activity: "Debugging your project",
  },
  ask: {
    label: "Ask",
    icon: "💬",
    hint: "Plain chat · attach files or images to analyze",
    needsRepo: false,
    activity: "Thinking through your question",
  },
};

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
  chatMode: "ask",
  repoPath: "",
};

/** @type {{ id: string, title: string, draftTitle?: string, systemPrompt: string, history: { role: string, content: string }[], updatedAt: number }[]} */
let chats = [];
let activeChatId = null;
let streaming = false;
let saveServerTimer = null;
let chatFilterQuery = "";
let streamAbort = null;
let systemRamGb = null;
let availableModels = [];
/** @type {{ kind: 'image'|'file', name: string, dataUrl?: string, base64?: string, text?: string, truncated?: boolean }[]} */
let pendingAttachments = [];

const MAX_ATTACH_BYTES = 2 * 1024 * 1024;
const MAX_ATTACH_TEXT_CHARS = 48_000;
const MAX_ATTACH_COUNT = 5;
/** Extensions parsed on the server (PDF, Office, etc.) */
const SERVER_PARSE_EXT = new Set([
  ".pdf", ".doc", ".docx", ".rtf", ".odt",
  ".xls", ".xlsx", ".ppt", ".pptx",
]);
/** Extensions blocked entirely — not readable */
const BINARY_EXT = new Set([
  ".zip", ".gz", ".bz2", ".xz", ".7z", ".rar", ".tar",
  ".exe", ".dll", ".dmg", ".pkg", ".deb", ".rpm", ".msi",
  ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".flac",
  ".wasm", ".bin", ".iso", ".img",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pyc", ".pyo", ".class", ".o", ".so", ".dylib", ".a",
  ".apk", ".ipa",
]);

function hasAttachments() {
  return pendingAttachments.length > 0;
}

function hasImageAttachments() {
  return pendingAttachments.some((a) => a.kind === "image");
}

function attachmentPayload() {
  const fromPending = pendingAttachments
    .filter((a) => a.kind === "file" && a.text)
    .map((a) => ({ name: a.name, text: a.text, truncated: a.truncated }));
  if (fromPending.length) return fromPending;
  const chat = getActiveChat();
  const last = chat?.history?.[chat.history.length - 1];
  if (last?.role === "user" && last._attachments?.length) return last._attachments;
  return [];
}

function embedAttachmentsInMessages(msgs, files) {
  if (!files.length) return msgs;
  const blocks = files.map(
    (f) =>
      `### ${f.name}${f.truncated ? " (truncated)" : ""}\n\`\`\`\n${f.text}\n\`\`\``,
  );
  const fileSection = blocks.join("\n\n");
  const out = msgs.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "user") {
      const ask = (out[i].content || "").trim() || "Analyze the attached file(s).";
      out[i].content =
        `${ask}\n\n` +
        `[${files.length} attached file(s) — respond using this content only]\n\n` +
        fileSection;
      break;
    }
  }
  return out;
}
let repoRoot = null;
let pendingAgentState = null;
let chatMode = "ask";

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
  if (!chat.history.length && !chat.systemPrompt?.trim()) return "New chat";
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

function setChatMode(mode) {
  if (!CHAT_MODES[mode]) mode = "ask";
  chatMode = mode;
  if (modeLabel) modeLabel.textContent = CHAT_MODES[mode].label;
  if (modeIcon) modeIcon.textContent = CHAT_MODES[mode].icon;
  if (modeHintEl) modeHintEl.textContent = CHAT_MODES[mode].hint;
  modeMenu?.querySelectorAll(".mode-option").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  updateComposerPlaceholder();
  saveSettings();
}

function toggleModeMenu(open) {
  if (!modeMenu || !modeTrigger) return;
  const show = open ?? modeMenu.classList.contains("hidden");
  modeMenu.classList.toggle("hidden", !show);
  modeTrigger.setAttribute("aria-expanded", show ? "true" : "false");
}

function isRepoMode() {
  return CHAT_MODES[chatMode]?.needsRepo === true;
}

function updateComposerPlaceholder() {
  const chat = getActiveChat();
  if (!chat) {
    if (isRepoMode()) {
      userInput.placeholder = repoRoot
        ? `${CHAT_MODES[chatMode].label} mode — ask about your project…`
        : "Set project folder in sidebar first…";
    } else {
      userInput.placeholder = "Ask anything…";
    }
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
    if (saved.chatMode) setChatMode(saved.chatMode);
    if (repoPathInput && saved.repoPath) repoPathInput.value = saved.repoPath;
    const panel = document.getElementById("settings-panel");
    if (panel) panel.open = saved.optionsOpen ?? false;
    if (chatSearchInput && saved.chatSearch) {
      chatSearchInput.value = saved.chatSearch;
      chatFilterQuery = saved.chatSearch;
    }
  } catch {
    webSearchToggle.checked = DEFAULTS.webSearch;
    fastModeToggle.checked = DEFAULTS.fastMode;
    unloadOnCloseToggle.checked = DEFAULTS.unloadOnClose;
  }
}

function saveSettings() {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      webSearch: webSearchToggle.checked,
      fastMode: fastModeToggle.checked,
      unloadOnClose: unloadOnCloseToggle.checked,
      chatMode,
      repoPath: repoPathInput?.value?.trim() || "",
      optionsOpen: document.getElementById("settings-panel")?.open ?? false,
      model: modelSelect?.value || "",
      chatSearch: chatFilterQuery,
    }),
  );
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

function normalizeChat(raw) {
  if (!raw?.id || !Array.isArray(raw.history)) return null;
  return {
    id: raw.id,
    title: raw.title || titleFromHistory(raw.history) || "New chat",
    draftTitle: raw.draftTitle || "",
    systemPrompt: raw.systemPrompt || "",
    history: raw.history.filter((m) => m.role && m.content),
    updatedAt: raw.updatedAt || Date.now(),
  };
}

function parseChatsArray(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeChat).filter(Boolean);
}

function mergeChatStores(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const chat of list) {
      const existing = byId.get(chat.id);
      if (!existing || chat.updatedAt >= existing.updatedAt) {
        byId.set(chat.id, chat);
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function chatsPayload() {
  return {
    activeId: activeChatId,
    chats: chats.map((c) => ({
      id: c.id,
      title: c.title,
      draftTitle: c.draftTitle || "",
      systemPrompt: c.systemPrompt || "",
      history: c.history,
      updatedAt: c.updatedAt,
    })),
    updatedAt: Date.now(),
  };
}

function loadChatsFromLocalStorage() {
  try {
    const raw = localStorage.getItem(CHATS_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return parseChatsArray(data.chats);
  } catch {
    return [];
  }
}

function saveChatsToLocalStorage() {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(chatsPayload()));
  } catch {
    for (const chat of chats) {
      if (chat.id !== activeChatId && chat.history.length > 4) {
        chat.history = chat.history.slice(-Math.floor(chat.history.length / 2));
      }
    }
    try {
      localStorage.setItem(CHATS_KEY, JSON.stringify(chatsPayload()));
    } catch {
      /* ignore */
    }
  }
}

async function persistChatsToServer({ keepalive = false } = {}) {
  try {
    await fetch("/api/chats", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatsPayload()),
      keepalive,
    });
  } catch {
    /* server may be stopping */
  }
}

function pruneChatsIfNeeded() {
  while (chats.length > MAX_CHATS) {
    const removable = [...chats]
      .filter((c) => c.id !== activeChatId && !c.history.length && !c.systemPrompt?.trim())
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (removable) {
      chats = chats.filter((c) => c.id !== removable.id);
      continue;
    }
    const oldest = [...chats]
      .filter((c) => c.id !== activeChatId)
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!oldest) break;
    chats = chats.filter((c) => c.id !== oldest.id);
  }
}

function saveChats() {
  pruneChatsIfNeeded();
  saveChatsToLocalStorage();
  renderChatList();
  clearTimeout(saveServerTimer);
  saveServerTimer = setTimeout(() => persistChatsToServer(), 300);
}

async function flushChats() {
  clearTimeout(saveServerTimer);
  saveServerTimer = null;
  pruneChatsIfNeeded();
  saveChatsToLocalStorage();
  renderChatList();
  await persistChatsToServer();
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
    }
  } catch {
    /* ignore */
  }
  localStorage.removeItem(LEGACY_CHAT_KEY);
}

async function loadChats() {
  let serverChats = [];

  try {
    const res = await fetch("/api/chats");
    if (res.ok) {
      const serverData = await res.json();
      serverChats = parseChatsArray(serverData.chats);
    }
  } catch {
    /* offline or server starting */
  }

  const localChats = loadChatsFromLocalStorage();
  chats = mergeChatStores(serverChats, localChats);

  migrateLegacySession();

  // Always show welcome on open/refresh — chats stay in the sidebar.
  activeChatId = null;

  if (chats.length) {
    await flushChats();
  }
}

function chatMatchesFilter(chat, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (displayTitle(chat).toLowerCase().includes(q)) return true;
  if (chat.draftTitle?.toLowerCase().includes(q)) return true;
  if (chat.systemPrompt?.toLowerCase().includes(q)) return true;
  return chat.history.some((m) => m.content?.toLowerCase().includes(q));
}

function renderChatList() {
  if (!chatListEl) return;
  const query = chatFilterQuery.trim();
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  const filtered = sorted.filter((c) => chatMatchesFilter(c, query));
  if (chatListLabel) {
    if (query) {
      chatListLabel.textContent = `Recent (${filtered.length}/${chats.length})`;
    } else {
      chatListLabel.textContent = chats.length ? `Recent (${chats.length})` : "Recent";
    }
  }
  chatListEl.innerHTML = "";
  if (!filtered.length && query) {
    const empty = document.createElement("div");
    empty.className = "chat-list-empty";
    empty.textContent = "No chats match your search";
    chatListEl.appendChild(empty);
    return;
  }
  for (const chat of filtered) {
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
  if (!chat) {
    renderWelcome();
    return;
  }
  if (chat.systemPrompt?.trim()) {
    appendSystemBanner(chat.systemPrompt);
  }
  if (!chat.history.length) {
    if (!chat.systemPrompt?.trim()) renderWelcome();
    return;
  }
  for (const msg of chat.history) {
    const isLast = msg === chat.history[chat.history.length - 1];
    appendMessage(msg.role === "user" ? "user" : "assistant", msg.content, {
      showActions: isLast && !streaming,
    });
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
  saveChats(); // activeId only — no need to flush full history
}

async function deleteChat(id, e) {
  e.stopPropagation();
  if (streaming) return;
  const chat = chats.find((c) => c.id === id);
  if (!chat) return;
  if (chat.history.length && !confirm(`Delete "${displayTitle(chat)}"?`)) return;

  chats = chats.filter((c) => c.id !== id);
  if (!chats.length) {
    activeChatId = null;
    renderMessages();
    renderChatList();
    updateComposerPlaceholder();
    await flushChats();
    return;
  }
  if (activeChatId === id) {
    activeChatId = null;
    renderMessages();
    updateComposerPlaceholder();
  }
  await flushChats();
}

function saveChat() {
  const chat = getActiveChat();
  if (!chat) return;
  chat.updatedAt = Date.now();
  saveChats();
}

/** Web search ON → search by default for any non-creative query (ChatGPT-style). */
const WEB_FORCE_PREFIX = /^\/search\s+/i;

const WEB_EXPLICIT_SEARCH =
  /\b(look up online|search the web|search online|find online|check online|google this)\b/i;

/** Pure creative/code tasks — skip web even when toggle is on. */
const WEB_LOCAL_CREATIVE =
  /\b(draft|write|compose|rewrite|proofread|edit)\b.{0,40}\b(email|e-?mail|letter|essay|poem|story|blog|resume|cv|cover letter|thank you note)\b/i;

const WEB_LOCAL_CODE =
  /\b(fix my code|debug this|refactor this|implement (?:a |the )?(?:function|class|method|feature|api)|write (?:me )?(?:a )?(?:function|class|script|program|unit test)s?)\b/i;

function isClearlyLocalCreative(text) {
  const t = text.trim();
  if (!t || /^\/(?:system|s)\b/i.test(t)) return true;
  if (WEB_LOCAL_CREATIVE.test(t)) return true;
  if (WEB_LOCAL_CODE.test(t)) return true;
  return false;
}

const WEB_LIVE_REQUIRED =
  /\b(current|today'?s?|latest|right now|as of now|as of today|this week|this month|live\b|real[- ]?time)\b/i;

const WEB_LIVE_TOPIC_PATTERNS = [
  /\b(weather|forecast|temperature|rain|snow|humidity|wind speed)\b/i,
  /\b(exchange rate|forex|fx|usd\s*to|eur\s*to|inr\s*to|gbp\s*to|dollar[s]?\s+to|rupee[s]?\s+to)\b/i,
  /\b(bitcoin|ethereum|crypto(?:currency)?|btc|eth|solana|dogecoin)\s*(price|cost|worth|rate)?\b/i,
  /\b(what time is it|time in\s+|time is it in\s+)\b/i,
  /\b(who won|final score|game score|match score|live score|standings)\b/i,
  /\b(next|upcoming|schedule|fixture|when is|where is)\b/i,
  /\b(f1|formula\s*one|formula\s*1|grand\s*prix|nfl|nba|mlb|epl|premier league|world\s*cup|fifa)\b/i,
  /\b(stock price|share price|market cap)\b/i,
  /\b(breaking|headline|news today|news about)\b/i,
];

function matchesLiveTopics(text) {
  return WEB_LIVE_TOPIC_PATTERNS.some((p) => p.test(text));
}

const WEB_LOCAL_ONLY =
  /\b(explain|why\s+(?:is|are|do|does|did)|how\s+(?:do|does|can|to|would)|help me understand|what(?:'s| is) the difference|compare|pros and cons|advantages and disadvantages|teach me|walk me through|step by step|in my own words|roleplay|pretend|conversation about|chat about|recommend|suggest (?:some|a few|movies|books|restaurants))\b/i;

function needsFactVerification(text) {
  const t = text.trim();
  if (!t || WEB_LOCAL_ONLY.test(t)) return false;
  if (
    /\b(latest|current|newest|most recent)\b.{0,40}\b(version|release|jdk|java|python|node\.?js|typescript|golang|\bgo\b|rust|kotlin|swift|react|angular|vue|spring|\.net|dotnet|ubuntu|ios|android|chrome|firefox|safari|windows|ollama|llama)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/\b(what|which)\s+(?:is\s+)?(?:the\s+)?(?:latest|current|newest)\b/i.test(t)) return true;
  if (/\bwhen\s+(?:was|is)\s+.+\b(?:released|launched|announced|general availability|ga)\b/i.test(t)) {
    return true;
  }
  if (/\b(?:is|are)\s+.+\b(?:still\s+supported|end[- ]of[- ]life|eol)\b/i.test(t)) return true;
  return false;
}

function needsLiveWebSearch(text) {
  const t = text.trim();
  if (!t) return false;
  if (WEB_FORCE_PREFIX.test(t)) return true;
  if (WEB_EXPLICIT_SEARCH.test(t)) return true;
  if (isClearlyLocalCreative(t)) return false;
  return true;
}

const WEB_CREATIVE_SKIP =
  /\b(draft|write|compose|rewrite|proofread|edit|email|e-?mail|letter|message to|subject line|cover letter|resume|cv|essay|poem|story|blog|tone|grammar|spelling|translate|summarize|summary|brainstorm|ideas for|outline|reply to|respond to|thank you note|make it (sound|shorter|longer)|in my own words|conversation|chat about|roleplay|pretend)\b/i;

function shouldWebSearch(text) {
  if (!webSearchToggle?.checked) return false;
  const t = text.trim();
  if (!t) return false;
  return needsLiveWebSearch(t);
}

function isForcedWebSearch(text) {
  return WEB_FORCE_PREFIX.test(text.trim());
}

function queryForWebSearch(text) {
  return text.trim().replace(WEB_FORCE_PREFIX, "").trim();
}

const DEFAULT_ASSISTANT_PROMPT =
  "You are a knowledgeable, careful assistant. Accuracy and clarity matter more than speed.\n\n" +
  "Before you answer (silently — do not show this planning):\n" +
  "- Identify what the user is really asking and which context applies.\n" +
  "- Outline the key points you will cover.\n\n" +
  "In your reply:\n" +
  "- Give only the final, polished answer — no visible brainstorming or 'let me think' preamble.\n" +
  "- Be specific and structured (short intro, then bullets or steps where helpful).\n" +
  "- If uncertain, say so briefly rather than guessing or telling the user to look elsewhere.\n\n" +
  "Answer from your own knowledge for explanations, writing, coding, advice, and comparisons.";

const ATTACHMENT_SYSTEM_PROMPT =
  "The user attached file(s). The FULL file contents are in their message below.\n\n" +
  "You MUST:\n" +
  "- Read and analyze the ACTUAL file contents\n" +
  "- Answer the user's question using what's IN those files\n" +
  "- NEVER give generic advice about 'how to analyze' or analysis frameworks\n" +
  "- If they say 'Analyze', analyze THE ATTACHED FILE(S), not analysis in general";

const CODING_QUERY =
  /\b(code|function|class|method|bug|error|stack\s*trace|regex|refactor|implement|debug|compile|syntax|typescript|javascript|python|kotlin|rust|golang|react|vue|angular|spring\s*boot|dockerfile|sql|api\s+endpoint|unit\s+test)\b/i;

function pickCoderModel(models) {
  const priority = [
    (m) => /qwen2\.5-coder:32b|qwen3-coder/.test(m),
    (m) => /deepseek-coder/.test(m),
    (m) => /codestral/.test(m),
    (m) => /qwen2\.5-coder/.test(m),
    (m) => /deepseek-r1:32b|deepseek-r1:14b/.test(m),
    (m) => /starcoder/.test(m),
  ];
  for (const test of priority) {
    const match = models.find(test);
    if (match) return match;
  }
  return null;
}

function isCreativeQuery(text) {
  return WEB_CREATIVE_SKIP.test(text.trim()) || WEB_LOCAL_ONLY.test(text.trim());
}

function pickModelForTurn(text) {
  const selected = modelSelect.value;
  const t = text.trim();
  if (hasImageAttachments()) {
    const vision = pickVisionModel(availableModels);
    if (vision) return vision;
  }
  if (!t || needsFactVerification(t) || !CODING_QUERY.test(t)) return selected;
  const coder = pickCoderModel(availableModels);
  return coder || selected;
}

function pickVisionModel(models) {
  const priority = [
    (m) => /llava|llama3\.2-vision|bakllava|moondream|minicpm-v|qwen2\.5vl|qwen3-vl/i.test(m),
  ];
  for (const test of priority) {
    const match = models.find(test);
    if (match) return match;
  }
  return models.find((m) => /vision|vl|llava/i.test(m)) || null;
}

async function loadRepoRoot() {
  try {
    const res = await fetch("/api/repo");
    if (!res.ok) return;
    const data = await res.json();
    repoRoot = data.root || null;
    if (repoRoot && repoPathInput && !repoPathInput.value) {
      repoPathInput.value = repoRoot;
    }
    updateRepoHint();
  } catch {
    /* ignore */
  }
}

function updateRepoHint() {
  if (!repoHintEl) return;
  if (repoRoot) {
    repoHintEl.textContent = repoRoot
      ? `Project: ${repoRoot.split("/").slice(-2).join("/")}`
      : "Set folder for Agent, Plan & Debug modes";
  }
}

async function setRepoPath(path) {
  const res = await fetch("/api/repo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not set project folder");
  repoRoot = data.root;
  if (repoPathInput) repoPathInput.value = repoRoot;
  saveSettings();
  updateRepoHint();
  return repoRoot;
}

function renderAttachmentPreview() {
  if (!attachmentPreview) return;
  attachmentPreview.innerHTML = "";
  if (!pendingAttachments.length) {
    attachmentPreview.classList.add("hidden");
    return;
  }
  attachmentPreview.classList.remove("hidden");
  pendingAttachments.forEach((att, idx) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    if (att.kind === "image") {
      chip.innerHTML = `<img src="${att.dataUrl}" alt="" /><button type="button" aria-label="Remove">×</button>`;
    } else {
      chip.innerHTML = `<span class="attachment-file-icon">📄</span><span class="attachment-file-name">${escapeHtml(att.name)}</span><button type="button" aria-label="Remove">×</button>`;
    }
    chip.querySelector("button").addEventListener("click", () => {
      pendingAttachments.splice(idx, 1);
      renderAttachmentPreview();
    });
    attachmentPreview.appendChild(chip);
  });
}

function fileExtension(name) {
  const m = name.match(/(\.[^./\\]+)$/);
  return m ? m[1].toLowerCase() : "";
}

function isKnownBinaryFile(file) {
  const ext = fileExtension(file.name);
  if (BINARY_EXT.has(ext)) return true;
  if (SERVER_PARSE_EXT.has(ext)) return false;
  if (file.type.startsWith("video/") || file.type.startsWith("audio/")) return true;
  if (file.type === "application/zip") return true;
  return false;
}

function needsServerParse(file) {
  return SERVER_PARSE_EXT.has(fileExtension(file.name));
}

async function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function parseFileOnServer(file) {
  const data = await readFileAsBase64(file);
  const res = await fetch("/api/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, data }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || "Could not parse file");
  return out;
}

function looksLikeBinaryText(text) {
  if (!text) return false;
  const sample = text.slice(0, 12_000);
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13)) control++;
  }
  return control / sample.length > 0.03;
}

async function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

async function addAttachmentFile(file) {
  if (!file) return;
  if (pendingAttachments.length >= MAX_ATTACH_COUNT) {
    alert(`Maximum ${MAX_ATTACH_COUNT} attachments`);
    return;
  }
  if (file.size > MAX_ATTACH_BYTES) {
    alert(`"${file.name}" is too large (max ${MAX_ATTACH_BYTES / 1024} KB)`);
    return;
  }

  const isImage =
    file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/i.test(file.name);

  if (isImage) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const base64 = String(dataUrl).split(",")[1] || "";
    pendingAttachments.push({ kind: "image", name: file.name, dataUrl, base64 });
    const vision = pickVisionModel(availableModels);
    if (vision && modelSelect) {
      modelSelect.value = vision;
      updateModelHint(availableModels);
    }
  } else {
    if (isKnownBinaryFile(file)) {
      alert(`"${file.name}" is not a supported attachment type.`);
      return;
    }
    let text;
    let truncated = false;
    try {
      if (needsServerParse(file)) {
        const parsed = await parseFileOnServer(file);
        text = parsed.text || "";
        truncated = Boolean(parsed.truncated);
      } else {
        text = await readFileAsText(file);
        if (looksLikeBinaryText(text)) {
          alert(`"${file.name}" appears to be binary, not text.`);
          return;
        }
        if (text.length > MAX_ATTACH_TEXT_CHARS) {
          text = text.slice(0, MAX_ATTACH_TEXT_CHARS);
          truncated = true;
        }
      }
    } catch (e) {
      alert(`Could not read "${file.name}": ${e.message || e}`);
      return;
    }
    if (!text.trim()) {
      alert(`No readable text found in "${file.name}".`);
      return;
    }
    pendingAttachments.push({ kind: "file", name: file.name, text, truncated });
  }
  renderAttachmentPreview();
}

function showWriteApproval(proposal) {
  return new Promise((resolve) => {
    if (!writeApprovalEl) {
      resolve(false);
      return;
    }
    writeApprovalPath.textContent = proposal.path;
    writeApprovalPreview.textContent = proposal.content;
    writeApprovalEl.classList.remove("hidden");

    function cleanup(result) {
      writeApprovalEl.classList.add("hidden");
      writeApproveBtn.removeEventListener("click", onApprove);
      writeRejectBtn.removeEventListener("click", onReject);
      resolve(result);
    }
    function onApprove() {
      cleanup(true);
    }
    function onReject() {
      cleanup(false);
    }
    writeApproveBtn.addEventListener("click", onApprove);
    writeRejectBtn.addEventListener("click", onReject);
  });
}

function renderAgentSteps(container, steps) {
  if (!steps?.length || !container) return;
  const details = document.createElement("details");
  details.className = "agent-steps";
  details.open = false;
  const summary = document.createElement("summary");
  summary.textContent = `Agent used ${steps.length} tool step(s)`;
  const list = document.createElement("div");
  for (const s of steps) {
    const line = document.createElement("div");
    line.textContent = `• ${s.tool}${s.args?.path ? `: ${s.args.path}` : ""}`;
    list.appendChild(line);
  }
  details.appendChild(summary);
  details.appendChild(list);
  container.appendChild(details);
}

async function runAgent(chat, userText) {
  streaming = true;
  setComposerStreaming(true);
  const modeCfg = CHAT_MODES[chatMode] || CHAT_MODES.agent;
  const placeholder = createAssistantPlaceholder(false, false, false);
  placeholder.setActivity(modeCfg.activity);
  const messageWrap = placeholder.wrap;
  const contentEl = placeholder.contentEl;
  streamAbort = new AbortController();

  const buildMsgs = () => {
    const msgs = [];
    const sys = chat?.systemPrompt?.trim();
    if (sys) msgs.push({ role: "system", content: sys });
    for (const m of chat.history) {
      msgs.push({ role: m.role, content: m.content });
    }
    return msgs;
  };

  try {
    let messages = buildMsgs();
    let finalContent = "";
    let allSteps = [];

    while (true) {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: pickModelForTurn(userText),
          messages: pendingAgentState?.messages || messages,
          mode: chatMode,
          fast_mode: fastModeToggle?.checked ?? false,
          approved_write: pendingAgentState?.approved_write,
          attachments: attachmentPayload(),
        }),
        signal: streamAbort.signal,
      });
      const approvedWrite = pendingAgentState?.approved_write;
      pendingAgentState = null;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Agent request failed");

      if (data.steps?.length) allSteps = allSteps.concat(data.steps);
      messages = data.messages || messages;

      if (data.status === "awaiting_approval" && data.proposal) {
        placeholder.setActivity("Waiting for your approval");
        const approved = await showWriteApproval(data.proposal);
        if (approved) {
          pendingAgentState = { approved_write: data.proposal, messages };
          placeholder.setActivity("Applying change");
          continue;
        }
        messages.push({
          role: "user",
          content: "[Tool result]\nUser rejected the proposed file write.",
        });
        continue;
      }

      if (data.status === "error") throw new Error(data.error || "Agent failed");
      finalContent = data.content || "";
      break;
    }

    placeholder.clearActivity();
    if (finalContent) {
      contentEl.innerHTML = formatContent(finalContent);
      renderAgentSteps(messageWrap.querySelector(".message-body"), allSteps);
      chat.history.push({ role: "assistant", content: finalContent });
      trimHistoryFor(chat);
      chat.updatedAt = Date.now();
      await flushChats();
      attachMessageActions(messageWrap, "assistant", finalContent);
    } else {
      messageWrap.remove();
    }
  } catch (e) {
    if (e.name !== "AbortError") {
      placeholder.clearActivity();
      contentEl.innerHTML = `<span class="thinking">Error: ${escapeHtml(e.message)}</span>`;
    } else {
      messageWrap.remove();
    }
  } finally {
    streaming = false;
    streamAbort = null;
    setComposerStreaming(false);
    userInput.focus();
  }
}

function getMessageBody(messageEl) {
  if (!messageEl) return null;
  let body = messageEl.querySelector(".message-body");
  if (body) return body;
  const content = messageEl.querySelector(".message-content");
  if (!content) return messageEl;
  body = document.createElement("div");
  body.className = "message-body";
  content.parentNode.insertBefore(body, content);
  body.appendChild(content);
  return body;
}

function renderSourceChips(messageEl, searchMeta) {
  if (!messageEl || !searchMeta) return;
  const body = getMessageBody(messageEl);
  body.querySelector(".message-sources")?.remove();
  const label = searchMeta.source_label;
  const sources = searchMeta.sources || [];
  if (!label && !sources.length) return;

  const wrap = document.createElement("div");
  wrap.className = "message-sources";

  if (label) {
    const chip = document.createElement("span");
    chip.className = `source-chip${searchMeta.live_data ? " live" : ""}`;
    chip.textContent = searchMeta.live_data ? `Live · ${label.replace(/^Live ·\s*/, "")}` : label;
    wrap.appendChild(chip);
  }

  const seen = new Set();
  for (const src of sources.slice(0, 3)) {
    const title = src.title || "Source";
    if (seen.has(title)) continue;
    seen.add(title);
    const chip = document.createElement("span");
    chip.className = "source-chip source-link";
    chip.title = src.snippet || title;
    if (src.url && !src.url.startsWith("local://")) {
      const href = src.url.startsWith("//") ? `https:${src.url}` : src.url;
      chip.innerHTML = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(title.slice(0, 48))}</a>`;
    } else {
      chip.textContent = title.slice(0, 48);
    }
    wrap.appendChild(chip);
  }

  body.appendChild(wrap);
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

function pickBestModel(models, ramGb = systemRamGb) {
  const has32 = (m) => /32b|70b/.test(m);
  const has14 = (m) => /14b/.test(m);
  const has8 = (m) => /8b/.test(m);

  const priority = [
    (m) => /qwen3:32b|qwen3\.6:32b|qwen2\.5:32b/.test(m),
    (m) => /deepseek-r1:32b/.test(m),
    (m) => /qwen2\.5-coder:32b|qwen3-coder/.test(m),
    (m) => /deepseek-r1:14b|qwen3:14b/.test(m),
    (m) => /deepseek-coder/.test(m),
    (m) => /qwen3:8b|deepseek-r1:8b/.test(m),
    (m) => /llama3\.1:8b|llama3:8b/.test(m),
    (m) => /70b/.test(m),
    (m) => /32b/.test(m),
    (m) => /14b/.test(m),
    (m) => /8b/.test(m),
  ];

  if (ramGb != null) {
    if (ramGb >= 48) {
      const m32 = models.find(has32);
      if (m32) return m32;
    }
    if (ramGb >= 24) {
      const m14 = models.find(has14);
      if (m14) return m14;
    }
    const m8 = models.find(has8);
    if (m8) return m8;
  }

  for (const test of priority) {
    const match = models.find(test);
    if (match) return match;
  }
  return models[0];
}

function updateModelHint(models) {
  if (!modelHintEl) return;
  const ram = systemRamGb;
  const has32 = models.some((m) => /32b|70b/.test(m));
  const selected = modelSelect?.value || "";
  const is32 = /32b|70b/.test(selected);

  if (has32 && is32) {
    modelHintEl.textContent = ram
      ? `${ram} GB RAM detected — great fit for ${selected}`
      : `Using ${selected} — best quality on this machine`;
    return;
  }
  if (ram != null && ram >= 48 && !has32) {
    modelHintEl.textContent = "64 GB+ Mac? Run: ollama pull qwen3:32b";
    return;
  }
  if (ram != null && ram >= 24 && !models.some((m) => /14b|32b|70b/.test(m))) {
    modelHintEl.textContent = "More RAM? Try: ollama pull qwen3:14b";
    return;
  }
  modelHintEl.textContent = "";
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

let baselineStatus = "Connecting…";

function setActivityLabel(label) {
  if (statusText) statusText.textContent = label;
}

function clearActivityLabel() {
  setActivityLabel(baselineStatus);
}

function setStatus(ok, text) {
  statusDot.className = "status-dot " + (ok ? "ok" : "err");
  baselineStatus = text;
  if (!streaming) statusText.textContent = text;
}

function initialActivityLabel(useWeb, forced, verify) {
  if (verify) return "Checking sources";
  if (!useWeb) return "Thinking through your question";
  if (forced) return "Searching the web";
  return "Fetching live data";
}

function activityLabelFromMeta(meta) {
  if (meta?.verify_facts) return "Verifying answer";
  if (meta?.direct_answer) {
    const h = meta.handler;
    if (h === "weather") return "Fetched weather";
    if (h === "fx") return "Fetched exchange rate";
    if (h === "crypto") return "Fetched crypto price";
    if (h === "espn") return "Fetched live scores";
    if (h === "time") return "Checked time";
    return "Fetched live data";
  }
  if (meta?.web_search) return "Thinking";
  return "Thinking";
}

function createAssistantPlaceholder(useWeb, forced, verify) {
  const label = initialActivityLabel(useWeb, forced, verify);
  setActivityLabel(`${label}…`);

  const wrap = document.createElement("div");
  wrap.className = "message assistant message-activity";
  wrap.innerHTML = `
    <div class="message-role">Assistant</div>
    <div class="message-body">
      <div class="activity-status">
        <span class="activity-indicator" aria-hidden="true"></span>
        <span class="activity-label">${escapeHtml(label)}…</span>
      </div>
      <div class="message-content"></div>
    </div>
  `;
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const activityEl = wrap.querySelector(".activity-status");
  const labelEl = wrap.querySelector(".activity-label");
  const contentEl = wrap.querySelector(".message-content");

  return {
    wrap,
    contentEl,
    setActivity(text) {
      if (labelEl) labelEl.textContent = `${text}…`;
      setActivityLabel(`${text}…`);
    },
    clearActivity() {
      activityEl?.remove();
      clearActivityLabel();
      wrap.classList.remove("message-activity");
    },
  };
}

async function loadModels() {
  try {
    const [modelsRes, systemRes] = await Promise.all([
      fetch("/api/models"),
      fetch("/api/system").catch(() => null),
    ]);
    if (!modelsRes.ok) throw new Error(await modelsRes.text());
    if (systemRes?.ok) {
      const sys = await systemRes.json();
      systemRamGb = sys.ram_gb ?? null;
    }

    const data = await modelsRes.json();
    modelSelect.innerHTML = "";
    const models = (data.models || []).map((m) => m.name).sort();
    availableModels = models;
    if (!models.length) {
      modelSelect.innerHTML = '<option value="">No models found</option>';
      setStatus(false, "No Ollama models");
      updateModelHint([]);
      return;
    }
    for (const name of models) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      modelSelect.appendChild(opt);
    }

    let savedModel = "";
    try {
      savedModel = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}").model || "";
    } catch {
      /* ignore */
    }
    if (savedModel && models.includes(savedModel)) {
      modelSelect.value = savedModel;
    } else {
      modelSelect.value = pickBestModel(models);
      saveSettings();
    }

    updateModelHint(models);
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

/** Hide internal reasoning from models that emit … blocks. */
function visibleAssistantText(raw) {
  if (!raw) return "";
  const closeTag = "<" + "/think>";
  const openTag = "<" + "think>";
  let text = raw.replace(new RegExp(`[\\s\\S]*?${closeTag}\\s*`, "gi"), "");
  const open = text.indexOf(openTag);
  if (open !== -1) text = text.slice(0, open);
  return text.trimStart();
}

function appendMessage(role, content, { streaming: isStream = false, showActions = false, images = [], files = [] } = {}) {
  clearWelcome();
  const wrap = document.createElement("div");
  wrap.className = `message ${role}`;
  const roleLabel = role === "user" ? "You" : "Assistant";
  let imageHtml = "";
  for (const src of images) {
    imageHtml += `<img class="message-image" src="${src}" alt="Attached image" />`;
  }
  let fileHtml = "";
  if (files.length) {
    fileHtml = `<div class="message-files">${files.map((f) => `<span class="message-file-chip">📄 ${escapeHtml(f)}</span>`).join("")}</div>`;
  }
  wrap.innerHTML = `
    <div class="message-role">${roleLabel}</div>
    <div class="message-body">
      <div class="message-content${isStream ? " cursor-blink" : ""}">${formatContent(content)}</div>
      ${fileHtml}
      ${imageHtml}
    </div>
  `;
  messagesEl.appendChild(wrap);
  if (showActions) attachMessageActions(wrap, role, content);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrap.querySelector(".message-content");
}

function attachMessageActions(wrap, role, content) {
  const body = wrap.querySelector(".message-body");
  if (!body || body.querySelector(".message-actions")) return;

  const actions = document.createElement("div");
  actions.className = "message-actions";

  if (role === "assistant") {
    const regen = document.createElement("button");
    regen.type = "button";
    regen.className = "message-action";
    regen.textContent = "Regenerate";
    regen.addEventListener("click", () => regenerateLast());

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "message-action";
    copy.textContent = "Copy";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(content);
        copy.textContent = "Copied";
        setTimeout(() => {
          copy.textContent = "Copy";
        }, 1500);
      } catch {
        /* ignore */
      }
    });

    actions.appendChild(regen);
    actions.appendChild(copy);
  } else if (role === "user") {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "message-action";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => editLastUserMessage());
    actions.appendChild(edit);
  }

  body.appendChild(actions);
}

function finalizeAssistantMessage(wrap, contentEl, content, { stopped = false } = {}) {
  contentEl.classList.remove("cursor-blink");
  if (content) {
    contentEl.innerHTML = formatContent(content);
  }
  if (stopped) {
    const note = document.createElement("div");
    note.className = "message-stopped";
    note.textContent = "Generation stopped";
    contentEl.appendChild(note);
  }
  attachMessageActions(wrap, "assistant", content);
}

function setComposerStreaming(active) {
  sendBtn.disabled = false;
  sendBtn.classList.toggle("is-streaming", active);
  sendBtn.setAttribute("aria-label", active ? "Stop generating" : "Send");
  userInput.disabled = active;
}

function stopGeneration() {
  streamAbort?.abort();
}

function buildPayload() {
  const chat = getActiveChat();
  const files = attachmentPayload();
  const msgs = [];
  const sys = chat?.systemPrompt?.trim();
  const lastUser = chat?.history[chat.history.length - 1]?.content || "";
  const verify = needsFactVerification(lastUser);
  const useWeb = files.length ? false : shouldWebSearch(lastUser);
  if (sys) {
    msgs.push({
      role: "system",
      content: files.length ? `${sys}\n\n${ATTACHMENT_SYSTEM_PROMPT}` : sys,
    });
  } else if (!useWeb) {
    msgs.push({
      role: "system",
      content: files.length ? ATTACHMENT_SYSTEM_PROMPT : DEFAULT_ASSISTANT_PROMPT,
    });
  }
  msgs.push(...(chat?.history || []));
  const finalMsgs = files.length ? embedAttachmentsInMessages(msgs, files) : msgs;
  const payload = {
    model: pickModelForTurn(lastUser),
    messages: finalMsgs,
    stream: true,
    fast_mode: fastModeToggle?.checked ?? false,
    web_search: useWeb,
    web_search_force: useWeb || isForcedWebSearch(lastUser) || verify,
    verify_facts: verify,
    web_search_query: useWeb ? queryForWebSearch(lastUser) : undefined,
  };
  if (hasImageAttachments()) {
    payload.images = pendingAttachments.filter((a) => a.kind === "image").map((a) => a.base64);
  }
  if (files.length) payload.attachments = files;
  return payload;
}

async function sendMessage(text, { regenerate = false } = {}) {
  const trimmed = text.trim();
  const attached = hasAttachments();
  if ((!trimmed && !attached) || streaming || !modelSelect.value) return;

  let chat = getActiveChat();
  if (!chat) {
    chat = createChat({ activate: true, render: false });
    if (!chat) return;
  }

  if (!regenerate && applySystemPrompt(chat, trimmed)) {
    return;
  }

  const fileNames = pendingAttachments.filter((a) => a.kind === "file").map((a) => a.name);
  const imageUrls = pendingAttachments.filter((a) => a.kind === "image").map((a) => a.dataUrl);
  const attachLabel = [];
  if (fileNames.length) attachLabel.push(`${fileNames.length} file(s)`);
  if (imageUrls.length) attachLabel.push(`${imageUrls.length} image(s)`);
  const displayText = trimmed || (attachLabel.length ? `(see attached ${attachLabel.join(", ")})` : "");

  if (!regenerate) {
    const filePayload = pendingAttachments
      .filter((a) => a.kind === "file" && a.text)
      .map((a) => ({ name: a.name, text: a.text, truncated: a.truncated }));
    chat.history.push({
      role: "user",
      content: displayText,
      attachNote: attachLabel.length ? attachLabel.join(", ") : undefined,
      _attachments: filePayload.length ? filePayload : undefined,
    });
    chat.title = titleFromText(displayText);
    chat.draftTitle = "";
    chat.updatedAt = Date.now();
    renderChatList();
    trimHistoryFor(chat);
    appendMessage("user", displayText, { images: imageUrls, files: fileNames });
    saveChats();
  }

  const useAgent = isRepoMode() && repoRoot && !hasImageAttachments() && !attachmentPayload().length;
  if (isRepoMode() && !repoRoot) {
    appendSystemNotice("Set your **project folder** in the sidebar to use " + CHAT_MODES[chatMode].label + " mode.");
    pendingAttachments = [];
    renderAttachmentPreview();
    return;
  }
  if (useAgent) {
    await runAgent(chat, displayText);
  } else {
    await runGeneration(chat, displayText);
  }
  pendingAttachments = [];
  renderAttachmentPreview();
}

async function regenerateLast() {
  if (streaming) return;
  const chat = getActiveChat();
  if (!chat?.history.length) return;

  while (chat.history.length && chat.history[chat.history.length - 1].role === "assistant") {
    chat.history.pop();
  }
  const lastUser = chat.history[chat.history.length - 1];
  if (!lastUser || lastUser.role !== "user") return;

  renderMessages();
  await sendMessage(lastUser.content, { regenerate: true });
}

function editLastUserMessage() {
  if (streaming) return;
  const chat = getActiveChat();
  if (!chat?.history.length) return;

  while (chat.history.length && chat.history[chat.history.length - 1].role === "assistant") {
    chat.history.pop();
  }
  const lastUser = chat.history.pop();
  if (!lastUser || lastUser.role !== "user") return;

  chat.updatedAt = Date.now();
  userInput.value = lastUser.content;
  userInput.style.height = "auto";
  userInput.style.height = `${Math.min(userInput.scrollHeight, 200)}px`;
  renderMessages();
  renderChatList();
  saveChats();
  userInput.focus();
}

async function runGeneration(chat, userText) {
  streaming = true;
  setComposerStreaming(true);

  const useWeb = shouldWebSearch(userText);
  const forced = isForcedWebSearch(userText);
  const verify = needsFactVerification(userText);
  const placeholder = createAssistantPlaceholder(useWeb, forced, verify);
  const messageWrap = placeholder.wrap;
  let contentEl = placeholder.contentEl;
  let full = "";
  let activityCleared = false;
  let stopped = false;
  streamAbort = new AbortController();

  function onFirstContent() {
    if (activityCleared) return;
    activityCleared = true;
    placeholder.clearActivity();
    contentEl.classList.add("cursor-blink");
  }

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload()),
      signal: streamAbort.signal,
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
          const meta = chunk.search_meta;
          placeholder.setActivity(activityLabelFromMeta(meta));
          renderSourceChips(messageWrap, meta);
          if (meta.direct_answer && !full) {
            onFirstContent();
          }
        }
        if (chunk.message?.content) {
          full += chunk.message.content;
          const visible = visibleAssistantText(full);
          if (visible) onFirstContent();
          contentEl.innerHTML = visible ? formatContent(visible) : "";
          if (visible) contentEl.classList.add("cursor-blink");
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        if (chunk.done) {
          contentEl.classList.remove("cursor-blink");
        }
      }
    }

    const answer = visibleAssistantText(full) || full.trim();
    if (answer) {
      chat.history.push({ role: "assistant", content: answer });
      trimHistoryFor(chat);
      chat.updatedAt = Date.now();
      await flushChats();
      finalizeAssistantMessage(messageWrap, contentEl, answer);
    } else {
      messageWrap.remove();
    }
  } catch (e) {
    if (e.name === "AbortError") {
      stopped = true;
      const answer = visibleAssistantText(full) || full.trim();
      if (answer) {
        chat.history.push({ role: "assistant", content: answer });
        trimHistoryFor(chat);
        chat.updatedAt = Date.now();
        await flushChats();
        finalizeAssistantMessage(messageWrap, contentEl, answer, { stopped: true });
      } else {
        messageWrap.remove();
      }
    } else {
      contentEl.classList.remove("cursor-blink");
      placeholder.clearActivity();
      contentEl.innerHTML = `<span class="thinking">Error: ${escapeHtml(e.message)}</span>`;
      const last = chat.history[chat.history.length - 1];
      if (last?.role === "user" && last.content === userText.trim()) {
        /* keep user message */
      }
      await flushChats();
    }
  } finally {
    streaming = false;
    streamAbort = null;
    placeholder.clearActivity();
    setComposerStreaming(false);
    userInput.focus();
  }
}

async function newChat() {
  if (streaming) return;

  const chat = createChat({ activate: true, render: false });
  if (!chat) return;

  userInput.value = "";
  userInput.style.height = "auto";
  renderMessages();
  renderChatList();
  updateComposerPlaceholder();
  userInput.focus();
  await flushChats();
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
  if (e.key === "Escape" && streaming) {
    e.preventDefault();
    stopGeneration();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (streaming) {
    stopGeneration();
    return;
  }
  const text = userInput.value;
  userInput.value = "";
  userInput.style.height = "auto";
  sendMessage(text);
});

sendBtn.addEventListener("click", (e) => {
  if (streaming) {
    e.preventDefault();
    stopGeneration();
  }
});

chatSearchInput?.addEventListener("input", () => {
  chatFilterQuery = chatSearchInput.value;
  saveSettings();
  renderChatList();
});

newChatBtn?.addEventListener("click", newChat);
stopBtn.addEventListener("click", stopServer);

webSearchToggle.addEventListener("change", saveSettings);
fastModeToggle.addEventListener("change", () => {
  saveSettings();
  trimHistory();
  warmModel();
});
unloadOnCloseToggle.addEventListener("change", saveSettings);
modeTrigger?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleModeMenu();
});
modeMenu?.querySelectorAll(".mode-option").forEach((btn) => {
  btn.addEventListener("click", () => {
    setChatMode(btn.dataset.mode);
    toggleModeMenu(false);
  });
});
document.addEventListener("click", (e) => {
  if (!modePicker?.contains(e.target)) toggleModeMenu(false);
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "i") {
    e.preventDefault();
    setChatMode("agent");
    userInput.focus();
  }
});
repoSetBtn?.addEventListener("click", async () => {
  const path = repoPathInput?.value?.trim();
  if (!path) return;
  try {
    await setRepoPath(path);
    appendSystemNotice(`Project folder set to:\n\n${repoRoot}`);
  } catch (e) {
    appendSystemNotice(`Could not set project folder: ${e.message}`);
  }
});
attachBtn?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", () => {
  for (const file of fileInput.files || []) {
    addAttachmentFile(file);
  }
  fileInput.value = "";
});
document.getElementById("settings-panel")?.addEventListener("toggle", saveSettings);
modelSelect.addEventListener("change", () => {
  saveSettings();
  updateModelHint([...modelSelect.options].map((o) => o.value).filter(Boolean));
  warmModel();
});

window.addEventListener("beforeunload", () => {
  clearTimeout(saveServerTimer);
  persistChatsToServer({ keepalive: true });
  if (unloadOnCloseToggle.checked) unloadModels();
});
window.addEventListener("pagehide", () => {
  clearTimeout(saveServerTimer);
  persistChatsToServer({ keepalive: true });
  if (unloadOnCloseToggle.checked) unloadModels();
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "n") {
    e.preventDefault();
    newChat();
  }
});

async function bootstrap() {
  loadSettings();
  setChatMode(chatMode);
  await loadChats();
  await loadRepoRoot();
  if (repoPathInput?.value?.trim() && !repoRoot) {
    try {
      await setRepoPath(repoPathInput.value.trim());
    } catch {
      /* saved path may be invalid on this machine */
    }
  }
  renderChatList();
  renderMessages();
  updateComposerPlaceholder();
  bindSuggestions();
  loadModels();
}

bootstrap();
