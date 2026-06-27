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
const lowRamModeToggle = document.getElementById("low-ram-mode");
const autoUnloadPressureToggle = document.getElementById("auto-unload-pressure");
const autoUnloadIdleToggle = document.getElementById("auto-unload-idle");
const ramBarFill = document.getElementById("ram-bar-fill");
const ramPctEl = document.getElementById("ram-pct");
const resourceModelEl = document.getElementById("resource-model");
const resourceWarnEl = document.getElementById("resource-warn");
const freeRamBtn = document.getElementById("free-ram-btn");
const composerStatusEl = document.getElementById("composer-status");

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
    hint: "Plain chat · attach or ⌘V paste screenshots to analyze",
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
  lowRamMode: false,
  autoUnloadOnPressure: false,
  autoUnloadIdle: false,
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
    if (lowRamModeToggle) lowRamModeToggle.checked = saved.lowRamMode ?? DEFAULTS.lowRamMode;
    if (autoUnloadPressureToggle) {
      autoUnloadPressureToggle.checked = saved.autoUnloadOnPressure ?? DEFAULTS.autoUnloadOnPressure;
    }
    if (autoUnloadIdleToggle) autoUnloadIdleToggle.checked = saved.autoUnloadIdle ?? DEFAULTS.autoUnloadIdle;
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
    if (lowRamModeToggle) lowRamModeToggle.checked = DEFAULTS.lowRamMode;
    if (autoUnloadPressureToggle) autoUnloadPressureToggle.checked = DEFAULTS.autoUnloadOnPressure;
    if (autoUnloadIdleToggle) autoUnloadIdleToggle.checked = DEFAULTS.autoUnloadIdle;
  }
}

function saveSettings() {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      webSearch: webSearchToggle.checked,
      fastMode: fastModeToggle.checked,
      unloadOnClose: unloadOnCloseToggle.checked,
      lowRamMode: lowRamModeToggle?.checked ?? false,
      autoUnloadOnPressure: autoUnloadPressureToggle?.checked ?? false,
      autoUnloadIdle: autoUnloadIdleToggle?.checked ?? false,
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

/** Web search ON → search only when the message needs live or factual lookup. */
const WEB_FORCE_PREFIX = /^\/search\s+/i;

const WEB_EXPLICIT_SEARCH =
  /\b(look up online|search the web|search online|find online|check online|google this)\b/i;

/** Social / ack messages — never hit the web. */
const CONVERSATIONAL_ONLY =
  /^(?:(?:thanks?(?:\s+(?:a\s+lot|so\s+much|very\s+much))?|thank\s+you(?:\s+so\s+much|\s+very\s+much)?|thx|ty|cheers|much\s+appreciated|appreciate\s+it)|(?:that(?:'s| is)\s+(?:helpful|great|perfect|awesome|good|useful))|(?:ok(?:ay)?|k|cool|nice|great|perfect|got\s+it|understood|makes\s+sense|sounds\s+good|will\s+do|noted|awesome|lovely|brilliant)|(?:hello|hi|hey|yo|good\s+(?:morning|afternoon|evening|night))|(?:how\s+(?:are\s+you|you\s+doing|goes\s+it))|(?:bye|goodbye|see\s+(?:you|ya)|take\s+care|later)|(?:yes|no|yep|nope|sure)|(?:can\s+you\s+)?(?:elaborate|explain\s+more|tell\s+me\s+more|go\s+on|continue|more\s+detail|expand(?:\s+on\s+that)?|say\s+more))(?:[!.?\s,]*)*$/iu;

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
  if (
    /\b(what|which)\s+(?:is\s+)?(?:the\s+)?(?:latest|current|newest)\b.{0,35}\b(version|release|jdk|java|python|node|typescript|golang|rust|kotlin|swift|react|angular|ubuntu|debian|macos|ios|android|chrome|firefox|windows|ollama|llama|gpt|claude|gemini)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/\bwhen\s+(?:was|is)\s+.+\b(?:released|launched|announced|general availability|ga)\b/i.test(t)) {
    return true;
  }
  if (/\b(?:is|are)\s+.+\b(?:still\s+supported|end[- ]of[- ]life|eol)\b/i.test(t)) return true;
  return false;
}

function isConversationalOnly(text) {
  const t = text.trim();
  if (!t || t.length > 120) return false;
  if (CONVERSATIONAL_ONLY.test(t)) return true;
  if (
    t.length <= 20 &&
    !/\?/.test(t) &&
    !looksLikeFactualLookup(t) &&
    !WEB_LOCAL_ONLY.test(t) &&
    !/\b(who|what|when|where|why|how|which)\b/i.test(t)
  ) {
    return /^[\w\s'".,!-]+$/i.test(t);
  }
  return false;
}

function looksLikeFactualLookup(text) {
  const t = text.trim();
  if (!t) return false;
  if (WEB_FORCE_PREFIX.test(t) || WEB_EXPLICIT_SEARCH.test(t)) return true;
  if (needsFactVerification(t)) return true;
  if (matchesLiveTopics(t)) return true;
  if (WEB_LIVE_REQUIRED.test(t)) return true;
  if (
    /\b(odi|test|t20|stats|statistics|weather|price|score|population|capital|who won|exchange rate|headline|news today)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/^(?:who|what|when|where|which|how many|how much|tell me|give me|show me|list|is there|are there)\b/i.test(t)) {
    return true;
  }
  if (/\?\s*$/.test(t) && !WEB_LOCAL_ONLY.test(t)) return true;
  if (/\b(what is|what's|who is|who's|where is|when is|how old)\b/i.test(t)) return true;
  return false;
}

function needsLiveWebSearch(text) {
  const t = text.trim();
  if (!t) return false;
  if (WEB_FORCE_PREFIX.test(t)) return true;
  if (WEB_EXPLICIT_SEARCH.test(t)) return true;
  if (isClearlyLocalCreative(t)) return false;
  if (isConversationalOnly(t)) return false;
  if (WEB_LOCAL_ONLY.test(t) && !looksLikeFactualLookup(t)) return false;
  return looksLikeFactualLookup(t);
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
  "You are a knowledgeable, careful assistant in an ongoing conversation. Accuracy and clarity matter.\n\n" +
  "Use the full thread — the latest message may be a follow-up, thanks, or clarification on what came before.\n\n" +
  "Before you answer (silently — do not show planning):\n" +
  "- Decide what the user wants now: new facts, explanation, writing help, or a brief social reply.\n" +
  "- For thanks, hi, ok, got it: one short warm sentence — do not repeat the prior answer or search the web.\n" +
  "- For follow-ups (e.g. 'what about test stats?'), use context from earlier messages.\n\n" +
  "In your reply:\n" +
  "- Give only the final, polished answer — no visible brainstorming.\n" +
  "- Be specific and structured when the question needs detail; stay brief for social messages.\n" +
  "- If uncertain, say so briefly rather than guessing.\n\n" +
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

async function handleComposerPaste(e) {
  if (userInput?.disabled || attachBtn?.disabled) return;
  const cd = e.clipboardData;
  if (!cd?.items?.length) return;

  const imageItems = [...cd.items].filter((item) => item.type.startsWith("image/"));
  if (!imageItems.length) return;

  e.preventDefault();
  for (const item of imageItems) {
    const blob = item.getAsFile();
    if (!blob) continue;
    const ext = (item.type.split("/")[1] || "png").replace("jpeg", "jpg");
    const name = `screenshot-${Date.now()}.${ext}`;
    const file = new File([blob], name, { type: blob.type || item.type });
    await addAttachmentFile(file);
  }
  userInput?.focus();
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
    streamStartedAt = 0;
    lastStreamActivityAt = 0;
    setComposerStreaming(false);
    userInput.focus();
    refreshComposerState();
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
  const tier = memoryTier(ramGb);
  const safeForTiny = models.filter((m) => isLightModel(m));

  if (tier === "tiny" && safeForTiny.length) {
    const prefer = [
      (m) => /llama3\.2:1b|llama3\.2:3b/.test(m),
      (m) => /llama3\.1:8b|llama3:8b/.test(m),
      (m) => /1b|3b/.test(m),
      (m) => /8b|7b/.test(m),
    ];
    for (const test of prefer) {
      const match = safeForTiny.find(test);
      if (match) return match;
    }
    return safeForTiny[0];
  }

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
  const tier = memoryTier(ram);
  const selected = modelSelect?.value || "";
  const is32 = isHeavyModel(selected);
  const is14 = isMediumModel(selected);

  if (tier === "tiny") {
    if (is32 || is14) {
      modelHintEl.textContent = `⚠ ${ram} GB RAM — ${selected} is too large. Use llama3.2:1b or llama3.1:8b`;
    } else {
      modelHintEl.textContent = `${ram} GB RAM — enable Low RAM mode in Options if Cursor feels sluggish`;
    }
    return;
  }

  const has32 = models.some((m) => isHeavyModel(m));
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
      body: JSON.stringify({ model, fast_mode: fastModeToggle?.checked ?? false, low_ram_mode: lowRamModeToggle?.checked ?? false, ram_tier: memoryTier() }),
    });
  } catch {
    /* non-fatal */
  }
}

let lastChatActivity = Date.now();
let lastAutoUnloadAt = 0;
let resourcePollTimer = null;
let systemSnapshot = null;
let streamStartedAt = 0;
let lastStreamActivityAt = 0;
let composerBlockedSince = 0;
let healInProgress = false;
let healthWatchdogTimer = null;
let lastHealAt = 0;

const IDLE_UNLOAD_MS = 10 * 60 * 1000;
const IDLE_UNLOAD_MS_TINY = 5 * 60 * 1000;
const AUTO_UNLOAD_COOLDOWN_MS = 3 * 60 * 1000;
const STREAM_STALL_MS = 2 * 60 * 1000;
const STREAM_STALL_MS_TINY = 90 * 1000;
const STREAM_MAX_MS = 12 * 60 * 1000;
const STREAM_MAX_MS_TINY = 8 * 60 * 1000;
const COMPOSER_STUCK_MS = 25 * 1000;
const HEAL_COOLDOWN_MS = 45 * 1000;

function memoryTier(ramGb = systemRamGb) {
  if (ramGb == null) return "normal";
  if (ramGb <= 8) return "tiny";
  return "normal";
}

function idleUnloadMs() {
  return memoryTier() === "tiny" ? IDLE_UNLOAD_MS_TINY : IDLE_UNLOAD_MS;
}

function streamStallMs() {
  return memoryTier() === "tiny" ? STREAM_STALL_MS_TINY : STREAM_STALL_MS;
}

function streamMaxMs() {
  return memoryTier() === "tiny" ? STREAM_MAX_MS_TINY : STREAM_MAX_MS;
}

function isHeavyModel(name) {
  return /32b|70b|34b|405b/i.test(name || "");
}

function isMediumModel(name) {
  return /14b|13b|22b/i.test(name || "");
}

function isLightModel(name) {
  return /1b|3b|7b|8b/i.test(name || "") && !isHeavyModel(name) && !isMediumModel(name);
}

function applyRamTierDefaults(ramGb) {
  if (!ramGb || ramGb > 8) return;
  const key = "ramTierDefaults_tiny";
  if (localStorage.getItem(key)) return;
  localStorage.setItem(key, "1");

  if (lowRamModeToggle) lowRamModeToggle.checked = true;
  if (autoUnloadPressureToggle) autoUnloadPressureToggle.checked = true;
  if (autoUnloadIdleToggle) autoUnloadIdleToggle.checked = true;
  saveSettings();
  appendSystemNotice(
    `**${ramGb} GB RAM detected** — Low RAM mode and auto-free options are on. ` +
      "Use **llama3.2:1b** or **llama3.1:8b** only; 14B/32B models will choke the system.",
  );
}

function touchChatActivity() {
  lastChatActivity = Date.now();
}

async function fetchSystemSnapshot() {
  try {
    const res = await fetch("/api/system", { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function applyResourceUi(snap) {
  systemSnapshot = snap;
  if (!snap) {
    if (resourceModelEl) resourceModelEl.textContent = "Memory stats unavailable";
    return;
  }

  const pct = snap.ram_used_pct;
  if (ramBarFill && pct != null) {
    ramBarFill.style.width = `${Math.min(100, pct)}%`;
    ramBarFill.classList.remove("warn", "critical");
    if (snap.memory_pressure === "critical") ramBarFill.classList.add("critical");
    else if (snap.memory_pressure === "warn") ramBarFill.classList.add("warn");
  }
  if (ramPctEl) {
    ramPctEl.textContent = pct != null ? `${Math.round(pct)}%` : "—";
  }

  const models = snap.ollama_models || [];
  if (resourceModelEl) {
    if (models.length) {
      const names = models.map((m) => m.name).join(", ");
      resourceModelEl.textContent = `Model in RAM: ${names} (~${snap.ollama_vram_gb ?? "?"} GB)`;
    } else if (serverRunning) {
      resourceModelEl.textContent = "No model loaded in RAM";
    } else {
      resourceModelEl.textContent = "Chat stopped · Ollama may still be running";
    }
  }

  const showFree = models.length > 0 && serverRunning;
  if (freeRamBtn) {
    freeRamBtn.classList.toggle("hidden", !showFree);
    freeRamBtn.disabled = !serverRunning || serverActionInProgress;
  }

  if (resourceWarnEl) {
    if (snap.memory_pressure !== "normal" && snap.memory_message) {
      resourceWarnEl.textContent = snap.memory_message;
      resourceWarnEl.classList.remove("hidden");
    } else {
      resourceWarnEl.classList.add("hidden");
      resourceWarnEl.textContent = "";
    }
  }

  if (statusDot && !streaming) {
    if (snap.memory_pressure === "critical") statusDot.className = "status-dot warn";
  }
  refreshComposerState();
}

async function maybeAutoFreeRam(snap) {
  if (!snap || streaming || serverActionInProgress || !serverRunning) return;
  const models = snap.ollama_models || [];
  if (!models.length) return;
  if (Date.now() - lastAutoUnloadAt < AUTO_UNLOAD_COOLDOWN_MS) return;

  let reason = null;
  if (autoUnloadPressureToggle?.checked && snap.should_unload) {
    reason = snap.memory_message || "System memory is tight.";
  }
  if (
    autoUnloadIdleToggle?.checked &&
    Date.now() - lastChatActivity >= idleUnloadMs()
  ) {
    reason = `Idle for ${memoryTier() === "tiny" ? "5+" : "10+"} minutes.`;
  }
  if (!reason) return;

  lastAutoUnloadAt = Date.now();
  appendSystemNotice(`**Auto freeing model RAM** — ${reason}`);
  await unloadModels();
  await refreshResources();
}

async function refreshResources() {
  const snap = await fetchSystemSnapshot();
  applyResourceUi(snap);
  await maybeAutoFreeRam(snap);
  scheduleResourcePoll();
  return snap;
}

function scheduleResourcePoll() {
  clearInterval(resourcePollTimer);
  const tick = () => {
    if (serverActionInProgress) return;
    refreshResources();
  };
  const intervalMs =
    systemSnapshot?.memory_pressure === "critical"
      ? 15000
      : systemSnapshot?.memory_pressure === "warn"
        ? 30000
        : 60000;
  resourcePollTimer = setInterval(tick, intervalMs);
}

async function freeModelRam() {
  if (!serverRunning) return;
  freeRamBtn.disabled = true;
  try {
    const res = await fetch("/api/unload", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    const names = (data.unloaded || []).join(", ") || "models";
    appendSystemNotice(`Freed RAM — unloaded **${names}** from memory.\n\nOllama is still running; the next message will reload the model.`);
    await refreshResources();
  } catch (e) {
    alert(`Could not free RAM: ${e.message || e}`);
  } finally {
    if (freeRamBtn) freeRamBtn.disabled = !serverRunning;
  }
}
let serverRunning = true;
let serverActionInProgress = false;
let serverPollTimer = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchServerStatus() {
  try {
    const res = await fetch("/api/server/status", { cache: "no-store" });
    if (!res.ok) return { running: false };
    return await res.json();
  } catch {
    return { running: false };
  }
}

async function waitForServerState(running, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await fetchServerStatus();
    if (Boolean(st.running) === running) return st;
    await sleep(350);
  }
  return fetchServerStatus();
}

function getComposerBlockReason() {
  if (streaming) {
    return {
      level: "info",
      message: "Generating reply… press Send or Esc to stop.",
      canSend: true,
      canType: false,
      action: null,
      actionLabel: null,
    };
  }
  if (serverActionInProgress) {
    return {
      level: "warn",
      message: "Server is starting or stopping — wait a moment.",
      canSend: false,
      canType: false,
      action: null,
      actionLabel: null,
    };
  }
  if (!serverRunning) {
    return {
      level: "warn",
      message: "Send is off because the chat worker is stopped. Start it to continue.",
      canSend: false,
      canType: false,
      action: "start_server",
      actionLabel: "Start server",
    };
  }
  const modelLabel = modelSelect?.options[modelSelect.selectedIndex]?.textContent?.trim() || "";
  if (!modelSelect?.value) {
    if (/unavailable|offline/i.test(modelLabel)) {
      return {
        level: "error",
        message: "Send is off — Ollama is not reachable. Start it with: brew services start ollama",
        canSend: false,
        canType: true,
        action: "retry_models",
        actionLabel: "Retry connection",
      };
    }
    if (/no models/i.test(modelLabel)) {
      return {
        level: "warn",
        message: "Send is off — no models installed. Run: ollama pull llama3.1:8b",
        canSend: false,
        canType: true,
        action: "retry_models",
        actionLabel: "Refresh models",
      };
    }
    if (/stopped/i.test(modelLabel)) {
      return {
        level: "warn",
        message: "Send is off — chat worker is stopped.",
        canSend: false,
        canType: false,
        action: "start_server",
        actionLabel: "Start server",
      };
    }
    return {
      level: "warn",
      message: "Send is off — pick a model in the sidebar.",
      canSend: false,
      canType: true,
      action: "retry_models",
      actionLabel: "Load models",
    };
  }
  const selected = modelSelect.value;
  if (memoryTier() === "tiny" && (isHeavyModel(selected) || isMediumModel(selected))) {
    return {
      level: "error",
      message: `${selected} is too large for ${systemRamGb} GB RAM — switch to llama3.2:1b or llama3.1:8b`,
      canSend: false,
      canType: true,
      action: "retry_models",
      actionLabel: "Pick safe model",
    };
  }
  if (systemSnapshot?.memory_pressure === "critical" && systemSnapshot?.should_unload) {
    return {
      level: "error",
      message: `Memory tight (${systemSnapshot.memory_message || "system is under pressure"}). Free model RAM or use Stop server.`,
      canSend: true,
      canType: true,
      action: "free_ram",
      actionLabel: "Free model RAM",
    };
  }
  return {
    level: "ok",
    message: "",
    canSend: true,
    canType: true,
    action: null,
    actionLabel: null,
  };
}

function renderComposerStatus(reason, { healing = false, stuck = false } = {}) {
  if (!composerStatusEl) return;
  if (healing) {
    composerStatusEl.className = "composer-status healing" + (stuck ? " pulse" : "");
    composerStatusEl.innerHTML = `<span class="composer-status-text">Recovering connection…</span>`;
    composerStatusEl.classList.remove("hidden");
    return;
  }
  if (!reason || reason.level === "ok" || !reason.message) {
    composerStatusEl.className = "composer-status hidden";
    composerStatusEl.innerHTML = "";
    composerStatusEl.classList.add("hidden");
    return;
  }
  composerStatusEl.className = `composer-status ${reason.level}` + (stuck ? " pulse" : "");
  let html = `<span class="composer-status-text">${escapeHtml(reason.message)}</span>`;
  if (reason.action && reason.actionLabel) {
    html += `<button type="button" class="composer-status-action" data-composer-action="${reason.action}">${escapeHtml(reason.actionLabel)}</button>`;
  }
  if (stuck) {
    html += `<button type="button" class="composer-status-action" data-composer-action="heal">Recover now</button>`;
  }
  composerStatusEl.innerHTML = html;
  composerStatusEl.classList.remove("hidden");
}

function refreshComposerState() {
  const reason = getComposerBlockReason();
  const canInteract = serverRunning && !serverActionInProgress;
  const stuck =
    !reason.canSend && !streaming && composerBlockedSince > 0 &&
    Date.now() - composerBlockedSince > COMPOSER_STUCK_MS;

  if (!reason.canSend && !streaming) {
    if (!composerBlockedSince) composerBlockedSince = Date.now();
  } else {
    composerBlockedSince = 0;
  }

  if (streaming) {
    sendBtn.disabled = false;
    sendBtn.classList.remove("is-blocked");
    userInput.disabled = true;
  } else {
    userInput.disabled = !canInteract || !reason.canType;
    const sendOff = !reason.canSend || !canInteract || !modelSelect?.value;
    sendBtn.disabled = sendOff;
    sendBtn.classList.toggle("is-blocked", sendOff);
  }

  if (attachBtn) attachBtn.disabled = !canInteract;
  if (modelSelect) modelSelect.disabled = !canInteract;
  if (newChatBtn) newChatBtn.disabled = !canInteract;

  sendBtn.title = reason.message || (streaming ? "Stop generating" : "Send message");
  userInput.title = reason.canType ? "" : reason.message;

  if (!healInProgress) {
    if (streaming && reason.canSend) {
      composerStatusEl.classList.add("hidden");
    } else {
      renderComposerStatus(reason, { stuck });
    }
  }
}

function setComposerEnabled(on) {
  refreshComposerState();
}

function resetStreamingState(notice) {
  streaming = false;
  streamAbort = null;
  streamStartedAt = 0;
  lastStreamActivityAt = 0;
  setComposerStreaming(false);
  if (notice) appendSystemNotice(notice);
  refreshComposerState();
}

async function runComposerAction(action) {
  if (action === "start_server") await startServer();
  else if (action === "retry_models") await loadModels();
  else if (action === "free_ram") await freeModelRam();
  else if (action === "heal") await attemptSelfHeal(true);
  refreshComposerState();
}

async function attemptSelfHeal(force = false) {
  if (healInProgress) return false;
  if (!force && Date.now() - lastHealAt < HEAL_COOLDOWN_MS) return false;
  healInProgress = true;
  lastHealAt = Date.now();
  renderComposerStatus(null, { healing: true });

  try {
    if (streaming) {
      streamAbort?.abort();
      resetStreamingState("Stopped a stuck request so you can try again.");
    }

    const st = await fetchServerStatus();
    if (!st.running) {
      appendSystemNotice("Chat worker was down — **restarting** automatically.");
      const res = await fetch("/api/server/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) throw new Error(data.error || "Could not restart worker");
      await waitForServerState(true, 25000);
      applyServerUi(true);
    } else if (!modelSelect?.value) {
      await loadModels();
    }

    const snap = await refreshResources();
    if (snap?.should_unload && autoUnloadPressureToggle?.checked) {
      await unloadModels();
      appendSystemNotice("Freed model RAM automatically — memory was critically low.");
    }

    appendSystemNotice("**Recovered** — you can send again.");
    return true;
  } catch (e) {
    appendSystemNotice(`Recovery failed: ${e.message || e}. Try **Start server** or **Free model RAM**.`);
    return false;
  } finally {
    healInProgress = false;
    refreshComposerState();
  }
}

function scheduleHealthWatchdog() {
  clearInterval(healthWatchdogTimer);
  healthWatchdogTimer = setInterval(async () => {
    if (healInProgress || serverActionInProgress) return;

    if (streaming && streamStartedAt) {
      const silent = lastStreamActivityAt ? Date.now() - lastStreamActivityAt : Date.now() - streamStartedAt;
      const total = Date.now() - streamStartedAt;
      const maxMs = streamMaxMs();
      const stallMs = streamStallMs();
      if (total > maxMs || silent > stallMs) {
        appendSystemNotice(
          total > maxMs
            ? "Request took too long — stopping and freeing resources."
            : "No response from model (memory or Ollama stall) — recovering…",
        );
        streamAbort?.abort();
        if (
          memoryTier() === "tiny" &&
          systemSnapshot?.ollama_vram_gb > 0 &&
          autoUnloadPressureToggle?.checked
        ) {
          await unloadModels();
        }
        resetStreamingState("Request timed out. Try again, or enable **Low RAM mode** in Options.");
        await attemptSelfHeal(true);
        return;
      }
    }

    if (!streaming && sendBtn?.disabled && serverRunning && composerBlockedSince &&
        Date.now() - composerBlockedSince > COMPOSER_STUCK_MS) {
      await attemptSelfHeal(false);
    }

    try {
      const st = await fetchServerStatus();
      if (serverRunning && !st.running && !streaming) {
        applyServerUi(false);
        appendSystemNotice("Chat worker stopped unexpectedly — click **Start server** or wait for auto-recovery.");
        await attemptSelfHeal(false);
      }
    } catch {
      /* ignore transient network blips */
    }
  }, 15000);
}

composerStatusEl?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-composer-action]");
  if (!btn) return;
  runComposerAction(btn.dataset.composerAction);
});

function showStoppedWelcome() {
  messagesEl.innerHTML = `
    <div class="welcome">
      <h1>Server stopped</h1>
      <p>Model RAM freed. Click <strong>Start server</strong> in the sidebar to chat again.</p>
      <p class="welcome-sub">Your chats are saved in the sidebar.</p>
    </div>
  `;
}

function applyServerUi(running) {
  serverRunning = running;
  if (!stopBtn) return;
  stopBtn.disabled = serverActionInProgress;
  stopBtn.classList.toggle("btn-start", !running);
  stopBtn.classList.toggle("btn-stop", running);
  stopBtn.textContent = running ? "Stop server" : "Start server";
  stopBtn.title = running
    ? "Stop chat worker and free model RAM"
    : "Start chat worker (auto-frees port if needed)";
  const footerHint = document.getElementById("footer-hint");
  if (footerHint) {
    footerHint.textContent = running
      ? "Stop unloads model RAM · Ollama app keeps running"
      : "Start server to chat again — no Terminal needed";
  }
  setComposerEnabled(running);
  if (!running && !streaming) {
    if (getActiveChat()?.history?.length) {
      renderMessages();
    } else {
      showStoppedWelcome();
    }
  }
}

async function refreshServerStatus() {
  const st = await fetchServerStatus();
  applyServerUi(Boolean(st.running));
  if (st.running) {
    setStatus(Boolean(st.ollama_ok), st.ollama_ok ? "Connected" : "Ollama offline");
  } else {
    setStatus(false, "Server stopped");
  }
  return st;
}

function scheduleServerPoll() {
  clearInterval(serverPollTimer);
  serverPollTimer = setInterval(() => {
    if (serverActionInProgress) return;
    fetchServerStatus().then((st) => {
      if (Boolean(st.running) !== serverRunning) {
        applyServerUi(Boolean(st.running));
        if (st.running) {
          loadModels();
          renderMessages();
        }
      }
    });
  }, 15000);
}

async function toggleServer() {
  if (serverActionInProgress) return;
  if (serverRunning) await stopServer();
  else await startServer();
}

async function stopServer() {
  if (
    !confirm(
      "Stop the chat worker and unload models from RAM?\n\n" +
        "• Ollama keeps running (not quit)\n" +
        "• Cursor should feel snappier\n" +
        "• Click Start server to chat again",
    )
  ) {
    return;
  }
  serverActionInProgress = true;
  refreshComposerState();
  stopBtn.disabled = true;
  stopBtn.textContent = "Stopping…";
  streamAbort?.abort();
  streaming = false;
  setComposerStreaming(false);
  try {
    await fetch("/api/shutdown", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await waitForServerState(false, 12000);
    applyServerUi(false);
    setStatus(false, "Server stopped");
    await refreshResources();
  } catch (e) {
    alert(`Stop failed: ${e.message || e}`);
    await refreshServerStatus();
  } finally {
    serverActionInProgress = false;
    applyServerUi(serverRunning);
    refreshComposerState();
  }
}

async function startServer() {
  serverActionInProgress = true;
  refreshComposerState();
  stopBtn.disabled = true;
  stopBtn.textContent = "Starting…";
  setStatus(false, "Starting server…");
  try {
    const res = await fetch("/api/server/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      throw new Error(data.error || "Could not start server");
    }
    const st = await waitForServerState(true, 25000);
    if (!st.running) {
      throw new Error("Server did not become ready in time");
    }
    applyServerUi(true);
    clearWelcome();
    renderMessages();
    await loadModels();
    setStatus(true, `Connected · ${modelSelect.value || "ready"}`);
    await refreshResources();
  } catch (e) {
    alert(`Start failed: ${e.message || e}`);
    applyServerUi(false);
    setStatus(false, "Server stopped");
  } finally {
    serverActionInProgress = false;
    applyServerUi(serverRunning);
    refreshComposerState();
  }
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
    if (h === "web") return "Searched the web";
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
  if (!serverRunning) {
    modelSelect.innerHTML = '<option value="">Server stopped</option>';
    return;
  }
  try {
    const [modelsRes, systemRes] = await Promise.all([
      fetch("/api/models"),
      fetch("/api/system").catch(() => null),
    ]);
    if (!modelsRes.ok) throw new Error(await modelsRes.text());
    if (systemRes?.ok) {
      const sys = await systemRes.json();
      systemRamGb = sys.ram_gb ?? null;
      applyResourceUi(sys);
      applyRamTierDefaults(systemRamGb);
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
      if (memoryTier() === "tiny" && (isHeavyModel(savedModel) || isMediumModel(savedModel))) {
        modelSelect.value = pickBestModel(models);
        saveSettings();
      } else {
        modelSelect.value = savedModel;
      }
    } else {
      modelSelect.value = pickBestModel(models);
      saveSettings();
    }

    updateModelHint(models);
    setStatus(true, `Ollama · ${models.length} model(s)`);
    warmModel();
    refreshResources();
  } catch (e) {
    setStatus(false, "Ollama offline");
    modelSelect.innerHTML = '<option value="">Unavailable</option>';
    showError("Cannot reach Ollama. Start it with: brew services start ollama");
  } finally {
    refreshComposerState();
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
  sendBtn.classList.toggle("is-streaming", active);
  sendBtn.setAttribute("aria-label", active ? "Stop generating" : "Send");
  if (active) {
    streamStartedAt = Date.now();
    lastStreamActivityAt = Date.now();
  } else {
    streamStartedAt = 0;
    lastStreamActivityAt = 0;
  }
  refreshComposerState();
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
    low_ram_mode: lowRamModeToggle?.checked ?? false,
    ram_tier: memoryTier(),
    web_search: useWeb,
    web_search_force: useWeb && (isForcedWebSearch(lastUser) || verify),
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
  touchChatActivity();
  const trimmed = text.trim();
  const attached = hasAttachments();
  if (!serverRunning) {
    refreshComposerState();
    appendSystemNotice("Chat worker is stopped — click **Start server** in the sidebar.");
    return;
  }
  if (!trimmed && !attached) return;
  if (streaming) return;
  if (!modelSelect.value) {
    refreshComposerState();
    appendSystemNotice(getComposerBlockReason().message || "Pick a model in the sidebar.");
    return;
  }

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
      const msg = err.error || "Chat request failed";
      if (res.status === 502 || res.status === 503) {
        throw new Error(`${msg} — worker may have crashed (low memory?). Trying to recover…`);
      }
      throw new Error(msg);
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
          lastStreamActivityAt = Date.now();
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
      if (/502|503|fetch|network|ollama|memory|crash|recover/i.test(String(e.message))) {
        await attemptSelfHeal(true);
      }
    }
  } finally {
    streaming = false;
    streamAbort = null;
    streamStartedAt = 0;
    lastStreamActivityAt = 0;
    placeholder.clearActivity();
    setComposerStreaming(false);
    userInput.focus();
    refreshResources();
    refreshComposerState();
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
  if (sendBtn.disabled) {
    refreshComposerState();
    const reason = getComposerBlockReason();
    if (reason.action) runComposerAction(reason.action);
    else if (reason.message) appendSystemNotice(reason.message);
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
stopBtn.addEventListener("click", toggleServer);

webSearchToggle.addEventListener("change", saveSettings);
fastModeToggle.addEventListener("change", () => {
  saveSettings();
  trimHistory();
  warmModel();
});
unloadOnCloseToggle.addEventListener("change", saveSettings);
lowRamModeToggle?.addEventListener("change", saveSettings);
autoUnloadPressureToggle?.addEventListener("change", saveSettings);
autoUnloadIdleToggle?.addEventListener("change", saveSettings);
freeRamBtn?.addEventListener("click", freeModelRam);
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
userInput?.addEventListener("paste", (e) => {
  handleComposerPaste(e);
});
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
  refreshComposerState();
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

const SIDEBAR_WIDTH_KEY = "sidebarWidth";
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;

function applySidebarWidth(px) {
  const width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px));
  document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
  return width;
}

function initSidebarResize() {
  const resizer = document.getElementById("sidebar-resizer");
  if (!resizer) return;

  try {
    const saved = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || "", 10);
    if (saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) applySidebarWidth(saved);
  } catch {
    /* ignore */
  }

  let startX = 0;
  let startWidth = 0;

  const onMove = (clientX) => {
    const next = applySidebarWidth(startWidth + clientX - startX);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
  };

  const stop = () => {
    document.body.classList.remove("sidebar-resizing");
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", stop);
    window.removeEventListener("touchmove", onTouchMove);
    window.removeEventListener("touchend", stop);
  };

  const onMouseMove = (e) => onMove(e.clientX);
  const onTouchMove = (e) => {
    if (e.touches[0]) onMove(e.touches[0].clientX);
  };

  const start = (clientX) => {
    startX = clientX;
    startWidth = document.getElementById("sidebar")?.getBoundingClientRect().width || 260;
    document.body.classList.add("sidebar-resizing");
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", stop);
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", stop);
  };

  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    start(e.clientX);
  });
  resizer.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches[0]) start(e.touches[0].clientX);
    },
    { passive: true },
  );
  resizer.addEventListener("keydown", (e) => {
    const sidebar = document.getElementById("sidebar");
    const current = sidebar?.getBoundingClientRect().width || 260;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(applySidebarWidth(current - 16)));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(applySidebarWidth(current + 16)));
    }
  });
}

async function bootstrap() {
  loadSettings();
  initSidebarResize();
  setChatMode(chatMode);
  await loadChats();
  await refreshServerStatus();
  scheduleServerPoll();
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
  await refreshResources();
  scheduleResourcePoll();
  scheduleHealthWatchdog();
  if (serverRunning) {
    loadModels();
  }
}

bootstrap();
