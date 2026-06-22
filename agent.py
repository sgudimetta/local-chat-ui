"""Agent loop with repo tools — read/grep auto, write needs approval."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any

from repo_tools import auto_gather_context, get_repo_root, grep_repo, list_tree, read_file, write_file

OLLAMA_BASE = __import__("os").environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
MAX_AGENT_STEPS = 8

TOOL_DOCS = """Available tools — respond with EXACTLY one tool block when you need to act (no other text in that message):

```tool
{"action": "list_files", "path": ""}
```

```tool
{"action": "read_file", "path": "relative/path.py"}
```

```tool
{"action": "grep", "pattern": "searchTerm", "path": ""}
```
"""

WRITE_TOOL = """
```tool
{"action": "write_file", "path": "relative/path.py", "content": "full file contents"}
```
"""

MODE_SYSTEM = {
    "agent": (
        "You are a coding agent with access to the user's project folder.\n\n"
        + TOOL_DOCS
        + WRITE_TOOL
        + "\nRules:\n"
        "- Project context may already be provided — use tools when you need more.\n"
        "- Use list_files to explore, read_file before editing, grep to find symbols.\n"
        "- write_file requires user approval — propose the complete new file content.\n"
        "- When done, give a final answer WITHOUT a tool block.\n"
        "- Paths are relative to the project root.\n"
    ),
    "plan": (
        "You are a planning assistant exploring a codebase. READ-ONLY — you cannot modify files.\n\n"
        + TOOL_DOCS
        + "\nRules:\n"
        "- Explore with list_files, read_file, and grep.\n"
        "- Produce a clear plan: steps, files to change, risks. Do NOT use write_file.\n"
        "- When done, give a structured plan WITHOUT a tool block.\n"
    ),
    "debug": (
        "You are a debugging assistant with access to the user's project folder.\n\n"
        + TOOL_DOCS
        + WRITE_TOOL
        + "\nRules:\n"
        "- Start by grepping for error messages, stack traces, and related symbols.\n"
        "- Read the files involved; explain root cause and minimal fix.\n"
        "- Propose write_file only when a code fix is needed (user must approve).\n"
        "- When done, give diagnosis + fix WITHOUT a tool block.\n"
    ),
}

TOOL_BLOCK = re.compile(r"```tool\s*\n(\{[\s\S]*?\})\s*\n```", re.MULTILINE)


def _ollama_chat(payload: dict, timeout: int = 300) -> dict:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{OLLAMA_BASE}/api/chat",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def _parse_tool_call(text: str) -> dict | None:
    m = TOOL_BLOCK.search(text)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return None


def _run_tool(action: dict, *, allow_write: bool) -> tuple[str, dict | None]:
    """Returns (result_text, write_proposal or None)."""
    name = action.get("action", "")
    try:
        if name == "list_files":
            path = action.get("path", "")
            entries = list_tree(path, max_entries=80)
            lines = [f"{e['type']:4} {e['path']}" for e in entries[:80]]
            return "Project files:\n" + "\n".join(lines), None
        if name == "read_file":
            data = read_file(action.get("path", ""))
            note = " [truncated]" if data["truncated"] else ""
            return f"File {data['path']}{note}:\n{data['content']}", None
        if name == "grep":
            matches = grep_repo(action.get("pattern", ""), action.get("path", ""))
            if not matches:
                return "No matches.", None
            lines = [f"{m['path']}:{m['line']}: {m['text']}" for m in matches]
            return "Matches:\n" + "\n".join(lines), None
        if name == "write_file":
            if not allow_write:
                return "Error: This mode is read-only. Do not write files.", None
            path = action.get("path", "")
            content = action.get("content", "")
            if not path:
                return "Error: write_file needs path", None
            return "", {"path": path, "content": content}
        return f"Unknown action: {name}", None
    except ValueError as e:
        return f"Tool error: {e}", None


def _last_user_text(messages: list[dict]) -> str:
    for m in reversed(messages):
        if m.get("role") == "user":
            c = m.get("content", "")
            if isinstance(c, str) and not c.startswith("[Tool result]"):
                return c
    return ""


def run_agent(
    messages: list[dict],
    *,
    model: str,
    mode: str = "agent",
    fast_mode: bool = False,
    approved_write: dict | None = None,
    perf_options: dict | None = None,
    attachments: list[dict] | None = None,
) -> dict[str, Any]:
    if get_repo_root() is None:
        return {"status": "error", "error": "No project folder set"}

    mode = mode if mode in MODE_SYSTEM else "agent"
    allow_write = mode in ("agent", "debug")
    opts = perf_options or {}
    steps: list[dict] = []

    if approved_write:
        path = approved_write.get("path", "")
        content = approved_write.get("content", "")
        try:
            write_file(path, content)
            result = f"Write applied: {path} ({len(content)} chars)"
            steps.append({"tool": "write_file", "path": path, "ok": True})
        except ValueError as e:
            result = f"Write failed: {e}"
            steps.append({"tool": "write_file", "path": path, "ok": False, "error": str(e)})
        messages = list(messages)
        messages.append({"role": "user", "content": f"[Tool result]\n{result}"})
    else:
        messages = list(messages)
        user_q = _last_user_text(messages)
        ctx = auto_gather_context(user_q)
        if ctx:
            messages.insert(0, {"role": "system", "content": ctx})
            steps.append({"tool": "auto_context", "result_preview": ctx[:300]})
        if attachments:
            blocks = []
            for a in attachments:
                name = a.get("name") or "file"
                text = a.get("text") or ""
                if text.strip():
                    note = " (truncated)" if a.get("truncated") else ""
                    blocks.append(f"--- Attached: {name}{note} ---\n{text}")
            if blocks:
                attach_ctx = "User-attached files:\n\n" + "\n\n".join(blocks)
                messages.insert(0, {"role": "system", "content": attach_ctx})
                steps.append({"tool": "attachments", "result_preview": attach_ctx[:300]})

    system = MODE_SYSTEM[mode]
    root = get_repo_root()
    sys_msgs = [{"role": "system", "content": f"{system}\n\nProject root: {root}"}]
    working = sys_msgs + [m for m in messages if m.get("role") in ("user", "assistant", "system")]

    for step in range(MAX_AGENT_STEPS):
        payload: dict[str, Any] = {
            "model": model,
            "messages": working,
            "stream": False,
            "keep_alive": "30m",
            "options": opts,
        }
        try:
            resp = _ollama_chat(payload)
        except urllib.error.URLError as e:
            return {"status": "error", "error": str(e), "messages": working, "steps": steps}

        msg = resp.get("message") or {}
        content = (msg.get("content") or "").strip()
        working.append({"role": "assistant", "content": content})

        tool = _parse_tool_call(content)
        if not tool:
            visible = re.sub(TOOL_BLOCK, "", content).strip()
            return {
                "status": "done",
                "content": visible or content,
                "messages": working,
                "steps": steps,
                "mode": mode,
            }

        result, proposal = _run_tool(tool, allow_write=allow_write)
        action = tool.get("action", "")
        steps.append({"tool": action, "args": tool, "result_preview": result[:500] if result else None})

        if proposal:
            visible = re.sub(TOOL_BLOCK, "", content).strip()
            return {
                "status": "awaiting_approval",
                "proposal": proposal,
                "content": visible,
                "messages": working,
                "steps": steps,
                "mode": mode,
            }

        working.append({"role": "user", "content": f"[Tool result]\n{result}"})

    return {
        "status": "done",
        "content": "Reached the step limit. Try a more specific question.",
        "messages": working,
        "steps": steps,
        "mode": mode,
    }
