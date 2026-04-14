import { Router, type RouteContext } from "../router.js";
import { runQuery, interruptQuery } from "../agent.js";
import { marked } from "marked";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as Settings from "../data/settings.js";
import * as Workspaces from "../data/workspaces.js";
import * as Sessions from "../data/sessions.js";
import * as Messages from "../data/messages.js";
import type {
  WorkspaceRow, SessionRow, MessageRow, MessageEventRow, PermissionRequestRow,
} from "../types.js";

const execAsync = promisify(exec);

marked.setOptions({ breaks: true, gfm: true });

// --- HTML escape ---
function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// --- Route registration ---
export function registerViewRoutes(router: Router): void {
  router.get("/views/init", initView);
  router.get("/views/settings", settingsView);
  router.patch("/views/settings", updateSettingsView);
  router.get("/views/workspaces", listWorkspacesView);
  router.get("/views/workspaces/:wid/activate", activateWorkspaceView);
  router.get("/views/sessions/:sid/activate", activateSessionView);
  router.get("/views/poll-message/:mid", pollMessageView);
  router.post("/views/sessions/:sid/messages", sendMessageView);
  router.post("/views/sessions/:sid/interrupt", interruptSessionView);
  router.get("/views/sessions/:sid/input-bar", inputBarView);
  router.get("/views/sessions/:sid/check-messages", checkMessagesView);
  router.post("/views/permissions/:id/resolve", resolvePermissionView);
  router.post("/views/permissions/:id/always-allow", alwaysAllowView);
  router.get("/views/sessions/:sid/git-diff", gitDiffView);
  router.get("/views/sessions/:sid/changes", sessionChangesView);
  router.get("/views/sessions/:sid/files", fileBrowserView);
  router.get("/views/sessions/:sid/file-content", fileContentView);
}

// --- Render helpers ---

function renderWorkspaceList(workspaces: WorkspaceRow[], activeId?: string, oob = false): string {
  const oobAttr = oob ? ` hx-swap-oob="outerHTML"` : "";
  const activeAttr = activeId ? ` data-active-workspace="${activeId}"` : "";
  const items = workspaces.length === 0
    ? `<li style="color:var(--text-dim);padding:8px 12px;font-size:13px">No workspaces yet</li>`
    : workspaces.map(w => `
      <li class="sidebar-item${w.id === activeId ? " active" : ""}"
          hx-get="/views/workspaces/${w.id}/activate"
          hx-target="#session-list" hx-swap="outerHTML">
        <span>${esc(w.name)}</span>
        <span style="display:flex;align-items:center;gap:4px">
          <button class="btn btn-sm" onclick="event.stopPropagation();showEditWorkspace('${w.id}')" title="Edit workspace">&#9881;</button>
          <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteWorkspace('${w.id}')">&times;</button>
        </span>
      </li>`).join("");
  return `<ul id="workspace-list" class="sidebar-list"${oobAttr}${activeAttr}>${items}</ul>`;
}

function renderSessionList(sessions: SessionRow[], activeId?: string, oob = false): string {
  const oobAttr = oob ? ` hx-swap-oob="outerHTML"` : "";
  const items = sessions.length === 0
    ? `<li style="color:var(--text-dim);padding:8px 12px;font-size:13px">No sessions yet</li>`
    : sessions.map(s => `
      <li class="sidebar-item${s.id === activeId ? " active" : ""}"
          hx-get="/views/sessions/${s.id}/activate"
          hx-target="#main-panel" hx-swap="innerHTML">
        <span>${esc(s.name || s.id.slice(0, 8))}</span>
        <span style="display:flex;align-items:center;gap:4px">
          <span class="status status-${s.status}">${s.status}</span>
          <button class="btn btn-sm" onclick="event.stopPropagation();showEditSession('${s.id}')" title="Edit session">&#9881;</button>
          <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteSession('${s.id}')">&times;</button>
        </span>
      </li>`).join("");
  return `<ul id="session-list" class="sidebar-list"${oobAttr}>${items}</ul>`;
}

function renderSessionHeader(session: SessionRow, workspace: WorkspaceRow, oob = false): string {
  const oobAttr = oob ? ` hx-swap-oob="outerHTML"` : "";
  const settings = Settings.getSettings();
  const resolved = Settings.resolveSettings(settings, workspace, session);
  return `<div class="main-header" id="session-header"${oobAttr}>
    <button class="hamburger" onclick="toggleSidebar()">&#9776;</button>
    <div>
      <h2 id="main-title" onclick="renameSession('${session.id}')" style="cursor:pointer" title="Click to rename">${esc(session.name || session.id.slice(0, 8))}</h2>
      <div class="meta">${esc(workspace.cwd)}</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <button class="btn btn-sm" onclick="showFileBrowser('${session.id}')" title="Browse files">Files</button>
      <button class="btn btn-sm" onclick="showSessionChanges('${session.id}')" title="All changes this session">Changes</button>
      <button class="btn btn-sm" onclick="showGitDiff('${session.id}')" title="Git diff">Diff</button>
      <span class="meta">${esc(shortModel(resolved.model))} · ${esc(permModeLabel(resolved.permissionMode))}</span>
    </div>
  </div>`;
}

function renderFullSession(
  workspaces: WorkspaceRow[], workspace: WorkspaceRow,
  sessions: SessionRow[], session: SessionRow,
): string {
  const messages = Messages.listMessages(session.id);
  const renderedMessages = messages.map(m => {
    const events = Messages.getAllMessageEvents(m.id);
    return renderMessageGroup(m, events);
  }).join("");
  const emptyMsg = messages.length === 0
    ? `<div id="empty-messages" style="color:var(--text-dim);text-align:center;margin-top:40px;font-size:13px">No messages yet. Send a prompt to begin.</div>`
    : "";

  return [
    renderSessionList(sessions, session.id),
    renderWorkspaceList(workspaces, workspace.id, true),
    `<div id="main-panel" class="main" hx-swap-oob="innerHTML">
      ${renderSessionHeader(session, workspace)}
      <div class="messages" id="messages-feed">${emptyMsg}${renderedMessages}</div>
      ${renderInputBar(session.id)}
    </div>`,
  ].join("\n");
}

function renderInputBar(sessionId: string, oob = false): string {
  const session = Sessions.getSession(sessionId);
  const oobAttr = oob ? ` hx-swap-oob="outerHTML"` : "";

  return `<div id="input-bar-wrapper"${oobAttr} data-session-id="${sessionId}" data-session-status="${session?.status || "idle"}">
    <div id="queue-list"></div>
    <form class="input-bar" id="input-bar"
        hx-post="/views/sessions/${sessionId}/messages"
        hx-target="#messages-feed" hx-swap="beforeend"
        hx-on::after-request="onMessageSent(event)">
      <button type="button" class="btn btn-stop hidden" id="stop-btn" title="Stop" onclick="interruptSession('${sessionId}')">&#9632;</button>
      <input type="text" name="prompt" placeholder="Send a message..." autocomplete="off">
      <button type="submit" class="btn btn-primary">Send</button>
    </form>
  </div>`;
}

function renderMessageGroup(message: MessageRow, events: MessageEventRow[]): string {
  const isActive = message.status === "pending" || message.status === "streaming";
  // Don't poll while a permission is pending — it resets the interactive form
  const hasPendingPerm = events.some(e => {
    if (e.event_type !== "permission_request") return false;
    const d = JSON.parse(e.data);
    const status = Messages.getPermissionStatus(d.id);
    return !status || status === "pending";
  });
  const pollAttr = isActive && !hasPendingPerm
    ? ` hx-get="/views/poll-message/${message.id}" hx-trigger="every 1s" hx-swap="outerHTML"`
    : "";

  const failedToolIds = collectFailedToolIds(events);

  return `<div class="message-group" id="msg-${message.id}"${pollAttr}>
    <div class="message-prompt">
      <div class="label">You</div>
      ${esc(message.prompt)}
    </div>
    <div class="message-events">
      ${renderEvents(message, events, failedToolIds)}
    </div>
  </div>`;
}

function renderEvents(message: MessageRow, events: MessageEventRow[], failedToolIds = new Set<string>()): string {
  const isActive = message.status === "pending" || message.status === "streaming";

  if (events.length === 0) {
    return isActive ? `<div class="event"><span class="event-type">waiting...</span></div>` : "";
  }

  // Render non-result events, then files section, then result event
  const resultEvents: MessageEventRow[] = [];
  const otherEvents: MessageEventRow[] = [];
  for (const e of events) {
    if (e.event_type.startsWith("result")) resultEvents.push(e);
    else otherEvents.push(e);
  }

  const rendered = otherEvents.map(e => renderEvent(e, message.id, failedToolIds)).join("");
  const resultRendered = resultEvents.map(e => renderEvent(e, message.id, failedToolIds)).join("");

  if (message.status === "error") {
    const errText = message.error || "Error";
    return rendered +`<div class="event"><div class="event-result error">${esc(errText)}</div></div>`;
  }

  if (isActive) {
    const hasPendingPerm = events.some(e => {
      if (e.event_type !== "permission_request") return false;
      const d = JSON.parse(e.data);
      const status = Messages.getPermissionStatus(d.id);
      return !status || status === "pending";
    });
    const label = hasPendingPerm ? "waiting for permission..." : "streaming...";
    return rendered +`<div class="event"><span class="event-type">${label}</span></div>`;
  }
  return rendered +resultRendered;
}

function renderEvent(e: MessageEventRow, messageId: string, failedToolIds = new Set<string>()): string {
  const data = JSON.parse(e.data);

  // Assistant message
  if (data.type === "assistant") {
    const parts: string[] = [];
    const content = data.message?.content || [];
    for (const block of content) {
      if (block.type === "text" && block.text?.trim()) {
        parts.push(`<div class="event-assistant">${renderMarkdown(block.text.trim())}</div>`);
      } else if (block.type === "tool_use") {
        parts.push(renderToolUse(block, failedToolIds));
      }
    }
    return parts.length ? `<div class="event">${parts.join("")}</div>` : "";
  }

  // Permission request
  if (e.event_type === "permission_request") {
    const permRow = Messages.getPermission(data.id as string);
    const inner = (permRow && permRow.status !== "pending")
      ? renderResolvedPermission(permRow)
      : renderPermissionActions(data, messageId);
    if (permRow && permRow.status !== "pending") {
      return `<div class="event">${inner}</div>`;
    }
    return `<div class="event"><div class="event-permission" id="perm-${data.id}">
      <div class="perm-title">${esc(data.title || data.tool_name)}</div>
      ${data.description ? `<div class="perm-desc">${esc(data.description)}</div>` : ""}
      ${inner}
    </div></div>`;
  }

  // Result
  if (e.event_type.startsWith("result")) {
    const isError = data.is_error;
    const model = data.modelUsage ? Object.keys(data.modelUsage)[0] : null;
    const usage = model && data.modelUsage ? data.modelUsage[model] : null;
    const modelTag = model ? `<span class="event-model">${esc(shortModel(model))}</span> ` : "";
    const errorText = isError && data.error ? esc(data.error) : "";

    const parts: string[] = [];
    if (model) parts.push(shortModel(model));
    if (usage) {
      const used = (usage.inputTokens || 0) + (usage.outputTokens || 0);
      const total = usage.contextWindow || 0;
      if (total) parts.push(`${used.toLocaleString()} / ${total.toLocaleString()} tokens`);
      else if (used) parts.push(`${used.toLocaleString()} tokens`);
    }
    if (data.total_cost_usd) parts.push(`$${data.total_cost_usd.toFixed(4)}`);
    if (data.duration_ms) parts.push(`${(data.duration_ms / 1000).toFixed(1)}s`);

    return `<div class="event"><div class="event-result ${isError ? "error" : ""}">
      ${errorText}
      <div class="cost">${parts.join(" · ")}</div>
    </div></div>`;
  }

  // Tool result — skip if the tool_use was denied/failed
  if (data.type === "user" && data.tool_use_result !== undefined) {
    const content = data.message?.content || [];
    const isError = content.some((b: { type: string; is_error?: boolean; tool_use_id?: string }) =>
      b.type === "tool_result" && b.is_error && b.tool_use_id && failedToolIds.has(b.tool_use_id));
    if (isError) return "";
    const result = formatToolResult(data.tool_use_result);
    if (!result) return "";
    return `<div class="event"><div class="event-tool-result">${esc(result)}</div></div>`;
  }

  // Tool use summary
  if (data.type === "tool_use_summary") {
    return `<div class="event"><div class="event-tool-result">${esc(data.summary)}</div></div>`;
  }

  // Skip init system events
  if (data.type === "system" && data.subtype === "init") return "";

  return "";
}

// --- Formatting helpers ---

function permModeLabel(mode: string): string {
  const map: Record<string, string> = { default: "Default", acceptEdits: "Accept Edits", bypassPermissions: "Bypass Permissions", plan: "Plan" };
  return map[mode] || mode || "Default";
}

function shortModel(model: string): string {
  const map: Record<string, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
  return map[model] || model;
}

function renderMarkdown(text: string): string {
  return marked.parse(text) as string;
}

function formatToolResult(result: unknown): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null) {
    const obj = result as Record<string, unknown>;
    if ("structuredPatch" in obj || ("filePath" in obj && ("oldString" in obj || "newString" in obj))) {
      return "";
    }
    if ("file" in obj && typeof obj.file === "object" && obj.file !== null && "filePath" in (obj.file as Record<string, unknown>)) {
      return "";
    }
    if ("stdout" in obj || "stderr" in obj) {
      const parts: string[] = [];
      if (obj.stdout) parts.push(String(obj.stdout));
      if (obj.stderr) parts.push(String(obj.stderr));
      return parts.join("\n").trim();
    }
  }
  if (Array.isArray(result)) {
    return result.map((r: Record<string, unknown>) => r.text || r.content || JSON.stringify(r)).join("\n");
  }
  return JSON.stringify(result, null, 2);
}

function renderToolUse(block: { id?: string; name: string; input?: Record<string, unknown> }, failedToolIds = new Set<string>()): string {
  const input = block.input || {};
  const failed = block.id ? failedToolIds.has(block.id) : false;

  if (block.name === "Edit" && input.file_path && !failed) {
    const oldStr = String(input.old_string || "");
    const newStr = String(input.new_string || "");
    const oldLines = oldStr.split("\n").map(l => `<div class="diff-del">-${esc(l)}</div>`).join("");
    const newLines = newStr.split("\n").map(l => `<div class="diff-add">+${esc(l)}</div>`).join("");
    return `<div class="event-tool-use">
      <span class="tool-name">Edit</span> <span class="file-path">${esc(String(input.file_path))}</span>
      <div class="file-diff">${oldLines}${newLines}</div>
    </div>`;
  }

  if (block.name === "Write" && input.file_path && !failed) {
    const content = String(input.content || "");
    const lines = content.split("\n").map(l => `<div class="diff-add">+${esc(l)}</div>`).join("");
    return `<div class="event-tool-use">
      <span class="tool-name">Write</span> <span class="file-path">${esc(String(input.file_path))}</span>
      <div class="file-diff">${lines}</div>
    </div>`;
  }

  if (failed && (block.name === "Edit" || block.name === "Write") && input.file_path) {
    return `<div class="event-tool-use">
      <span class="tool-name">${esc(block.name)}</span> <span class="file-path">${esc(String(input.file_path))}</span> <span style="color:var(--red);font-size:11px">(denied)</span>
    </div>`;
  }

  return `<div class="event-tool-use">
    <span class="tool-name">${esc(block.name)}</span>
    <div class="tool-input">${esc(formatToolInput(input))}</div>
  </div>`;
}

function formatToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return String(input || "");
  return Object.entries(input as Record<string, unknown>).map(([k, v]) => {
    const val = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    return `${k}: ${val}`;
  }).join("\n");
}

// --- Route handlers ---

function initView() {
  const workspaces = Workspaces.listWorkspaces();
  if (workspaces.length === 0) {
    return {
      status: 200,
      html: renderWorkspaceList(workspaces, undefined, true),
    };
  }

  // Find the most recently active session across all workspaces
  const lastSession = Sessions.getMostRecentlyActive();
  const workspace = lastSession
    ? Workspaces.getWorkspace(lastSession.workspace_id) ?? workspaces[0]
    : workspaces[0];
  const sessions = Sessions.listSessions(workspace.id);

  if (!lastSession || sessions.length === 0) {
    return {
      status: 200,
      html: [
        renderWorkspaceList(workspaces, workspace.id, true),
        renderSessionList(sessions, undefined, true),
        `<div id="main-panel" class="main" hx-swap-oob="innerHTML">
          <div class="main-header"><button class="hamburger" onclick="toggleSidebar()">&#9776;</button><h2>Select a session</h2></div>
          <div class="main-empty">Create a session to get started</div>
        </div>`,
      ].join("\n"),
    };
  }

  // Select that session (it may be in this workspace's list)
  const session = sessions.find(s => s.id === lastSession.id) ?? sessions[0];
  const messages = Messages.listMessages(session.id);
  const renderedMessages = messages.map(m => {
    const events = Messages.getAllMessageEvents(m.id);
    return renderMessageGroup(m, events);
  }).join("");
  const emptyMsg = messages.length === 0
    ? `<div id="empty-messages" style="color:var(--text-dim);text-align:center;margin-top:40px;font-size:13px">No messages yet. Send a prompt to begin.</div>`
    : "";

  return {
    status: 200,
    html: [
      renderWorkspaceList(workspaces, workspace.id, true),
      renderSessionList(sessions, session.id, true),
      `<div id="main-panel" class="main" hx-swap-oob="innerHTML">
        ${renderSessionHeader(session, workspace)}
        <div class="messages" id="messages-feed">${emptyMsg}${renderedMessages}</div>
        ${renderInputBar(session.id)}
      </div>`,
    ].join("\n"),
  };
}

function listWorkspacesView() {
  return { status: 200, html: renderWorkspaceList(Workspaces.listWorkspaces()) };
}

function activateWorkspaceView(ctx: RouteContext) {
  const { wid } = ctx.params;
  const workspace = Workspaces.getWorkspace(wid);
  if (!workspace) return { status: 404, html: "" };

  const sessions = Sessions.listSessions(wid);

  if (sessions.length > 0) {
    const session = sessions[0];
    return { status: 200, html: renderFullSession(Workspaces.listWorkspaces(), workspace, sessions, session) };
  }

  return {
    status: 200,
    html: [
      renderSessionList(sessions),
      renderWorkspaceList(Workspaces.listWorkspaces(), wid, true),
      `<div id="main-panel" class="main" hx-swap-oob="innerHTML">
        <div class="main-header"><button class="hamburger" onclick="toggleSidebar()">&#9776;</button><h2>Select a session</h2></div>
        <div class="main-empty">Create a session to get started</div>
      </div>`,
    ].join("\n"),
  };
}

function activateSessionView(ctx: RouteContext) {
  const { sid } = ctx.params;

  const session = Sessions.getSession(sid);
  if (!session) return { status: 404, html: "<div>Session not found</div>" };

  const workspace = Workspaces.getWorkspace(session.workspace_id)!;
  const sessions = Sessions.listSessions(session.workspace_id);
  const messages = Messages.listMessages(sid);

  const renderedMessages = messages.map(m => {
    const events = Messages.getAllMessageEvents(m.id);
    return renderMessageGroup(m, events);
  }).join("");

  const emptyMsg = messages.length === 0
    ? `<div id="empty-messages" style="color:var(--text-dim);text-align:center;margin-top:40px;font-size:13px">No messages yet. Send a prompt to begin.</div>`
    : "";

  return {
    status: 200,
    html: [
      renderSessionHeader(session, workspace),
      `<div class="messages" id="messages-feed">${emptyMsg}${renderedMessages}</div>`,
      renderInputBar(sid),
      renderSessionList(sessions, sid, true),
    ].join("\n"),
  };
}

function pollMessageView(ctx: RouteContext) {
  const { mid } = ctx.params;

  const message = Messages.getMessage(mid);
  if (!message) return { status: 404, html: "" };

  const events = Messages.getAllMessageEvents(mid);
  let html = renderMessageGroup(message, events);

  // When message completes, refresh session list (status -> idle)
  if (message.status === "complete" || message.status === "error") {
    const session = Sessions.getSession(message.session_id)!;
    html += renderSessionList(Sessions.listSessions(session.workspace_id), session.id, true);
  }

  return { status: 200, html };
}

function sendMessageView(ctx: RouteContext) {
  const { sid } = ctx.params;
  const body = ctx.body as Record<string, string> | undefined;
  const prompt = body?.prompt?.trim();

  if (!prompt) return { status: 400, html: "" };

  const session = Sessions.getSession(sid);
  if (!session) return { status: 404, html: "" };
  if (session.status === "active") return { status: 409, html: "" };

  const workspace = Workspaces.getWorkspace(session.workspace_id);
  if (!workspace) return { status: 500, html: "" };

  const resolved = Settings.resolveSettings(Settings.getSettings(), workspace, session);

  // Auto-name session from first prompt
  if (!session.name) {
    Sessions.autoNameSession(sid, prompt);
  }

  const message = Messages.createMessage(sid, prompt);

  runQuery({
    messageId: message.id,
    sessionId: sid,
    prompt,
    cwd: workspace.cwd,
    agentSessionId: session.agent_session_id,
    allowedTools: resolved.allowedTools,
    systemPrompt: workspace.system_prompt,
    permissionMode: resolved.permissionMode,
    model: resolved.model,
    maxTurns: null,
    maxBudgetUsd: null,
  });

  let html = renderMessageGroup(message, []);

  // Refresh session list (status -> active) and header (if renamed)
  html += renderSessionList(Sessions.listSessions(session.workspace_id), sid, true);

  if (!session.name) {
    const updated = Sessions.getSession(sid)!;
    html += renderSessionHeader(updated, workspace, true);
  }

  return { status: 200, html };
}

function settingsView() {
  return { status: 200, html: renderSettingsPanel(Settings.getSettings()) };
}

function updateSettingsView(ctx: RouteContext) {
  const body = ctx.body as Record<string, string> | undefined;
  if (!body) return { status: 400, html: "" };

  const allowedTools = body.allowedTools?.trim()
    ? body.allowedTools.split("\n").map(s => s.trim()).filter(Boolean)
    : null;

  const updated = Settings.updateSettings({
    model: body.model || undefined,
    permissionMode: body.permissionMode || undefined,
    allowedTools,
  });

  return { status: 200, html: renderSettingsPanel(updated) };
}

function renderSettingsPanel(settings: import("../types.js").SettingsRow): string {
  const tools = settings.allowed_tools ? JSON.parse(settings.allowed_tools).join("\n") : "";
  return `<div id="settings-panel">
    <div class="main-header">
      <button class="hamburger" onclick="toggleSidebar()">&#9776;</button>
      <h2>Global Settings</h2>
    </div>
    <div style="padding:20px;max-width:500px">
      <form hx-patch="/views/settings" hx-target="#settings-panel" hx-swap="outerHTML">
        <label style="display:block;font-size:12px;color:var(--text-dim);margin-bottom:4px">Default Model</label>
        <select name="model" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;font-size:13px;margin-bottom:12px">
          <option value="sonnet"${settings.model === "sonnet" ? " selected" : ""}>Sonnet</option>
          <option value="opus"${settings.model === "opus" ? " selected" : ""}>Opus</option>
          <option value="haiku"${settings.model === "haiku" ? " selected" : ""}>Haiku</option>
        </select>
        <label style="display:block;font-size:12px;color:var(--text-dim);margin-bottom:4px">Default Permission Mode</label>
        <select name="permissionMode" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;font-size:13px;margin-bottom:12px">
          <option value="default"${settings.permission_mode === "default" ? " selected" : ""}>Default</option>
          <option value="acceptEdits"${settings.permission_mode === "acceptEdits" ? " selected" : ""}>Accept Edits</option>
          <option value="bypassPermissions"${settings.permission_mode === "bypassPermissions" ? " selected" : ""}>Bypass Permissions</option>
          <option value="plan"${settings.permission_mode === "plan" ? " selected" : ""}>Plan</option>
        </select>
        <label style="display:block;font-size:12px;color:var(--text-dim);margin-bottom:4px">Default Allowed Tools <span style="font-style:italic">(one per line)</span></label>
        <textarea name="allowedTools" rows="6" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;font-size:13px;font-family:var(--mono);resize:vertical;margin-bottom:4px" placeholder="e.g.&#10;Read&#10;Glob&#10;Grep&#10;Bash(git *)&#10;Bash(npm *)">${esc(tools)}</textarea>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:16px">
          Tool names: Read, Edit, Write, Glob, Grep, Bash<br>
          Bash patterns: Bash(git *), Bash(npm *), Bash(*)
        </div>
        <button type="submit" class="btn btn-primary">Save</button>
      </form>
    </div>
  </div>`;
}

function renderPermissionActions(data: Record<string, unknown>, messageId: string): string {
  const permId = data.id as string;
  const toolName = data.tool_name as string;
  const input = data.input as Record<string, unknown> | undefined;

  // Build pattern suggestions
  const suggestions: { label: string; pattern: string }[] = [];

  if (toolName === "Bash" && input?.command) {
    const cmd = String(input.command);
    const prefix = cmd.split(/\s+/).slice(0, 1)[0];
    suggestions.push({ label: `Bash(${cmd})`, pattern: `Bash(${cmd})` });
    if (prefix && prefix !== cmd) {
      suggestions.push({ label: `Bash(${prefix} *)`, pattern: `Bash(${prefix} *)` });
    }
    suggestions.push({ label: "Bash(*)", pattern: "Bash(*)" });
  } else {
    suggestions.push({ label: toolName, pattern: toolName });
  }

  const suggestBtns = suggestions.map(s =>
    `<button class="btn btn-sm" style="background:rgba(88,166,255,0.15);color:var(--accent);border:1px solid rgba(88,166,255,0.3);font-family:var(--mono);font-size:11px;"
            onclick="this.closest('.perm-allow-rule').querySelector('input[type=text]').value='${esc(s.pattern).replace(/'/g, "\\'")}';">${esc(s.label)}</button>`
  ).join("");

  const target = `#msg-${messageId}`;

  return `<div class="perm-actions">
    <button class="btn btn-sm" style="background:var(--green);color:#000;border:none;"
            hx-post="/views/permissions/${permId}/resolve" hx-vals='{"allow":"true"}'
            hx-target="${target}" hx-swap="outerHTML">Allow</button>
    <button class="btn btn-sm" style="background:var(--red);color:#fff;border:none;"
            hx-post="/views/permissions/${permId}/resolve" hx-vals='{"allow":"false"}'
            hx-target="${target}" hx-swap="outerHTML">Deny</button>
  </div>
  <div class="perm-allow-rule" style="margin-top:8px;padding:8px;background:rgba(88,166,255,0.04);border:1px solid rgba(88,166,255,0.1);border-radius:6px;">
    <div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Allow rule</div>
    <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">${suggestBtns}</div>
    <input type="text" value="${esc(suggestions[0].pattern)}" placeholder="Pattern..."
           style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:11px;font-family:var(--mono);margin-bottom:6px;">
    <div style="display:flex;flex-direction:column;gap:4px;font-size:11px;margin-bottom:6px">
      <label><input type="checkbox" name="session" checked style="accent-color:var(--accent);margin-right:4px;"> Session</label>
      <label><input type="checkbox" name="workspace" style="accent-color:var(--accent);margin-right:4px;"> Workspace</label>
      <label><input type="checkbox" name="global" style="accent-color:var(--accent);margin-right:4px;"> Global</label>
    </div>
    <button class="btn btn-sm btn-primary"
            onclick="(function(el){var r=el.closest('.perm-allow-rule');var p=r.querySelector('input[type=text]').value;var s=r.querySelector('input[name=session]').checked;var w=r.querySelector('input[name=workspace]').checked;var g=r.querySelector('input[name=global]').checked;htmx.ajax('POST','/views/permissions/${permId}/always-allow',{target:document.getElementById('msg-${messageId}'),swap:'outerHTML',values:{pattern:p,session:s,workspace:w,global:g}});})(this)">Allow &amp; Add Rule</button>
  </div>`;
}

function resolvePermissionView(ctx: RouteContext) {
  const { id } = ctx.params;
  const body = ctx.body as Record<string, string> | undefined;

  const row = Messages.getPermission(id);
  if (!row) return { status: 404, html: "" };

  if (row.status === "pending") {
    const allow = body?.allow === "true";
    Messages.resolvePermission(id, allow);
  }

  // Return full message group so polling resumes
  return { status: 200, html: renderFullMessageGroup(row.message_id) };
}

function alwaysAllowView(ctx: RouteContext) {
  const { id } = ctx.params;
  const body = ctx.body as Record<string, string> | undefined;
  const pattern = body?.pattern?.trim();

  if (!pattern) return { status: 400, html: "" };

  const row = Messages.getPermission(id);
  if (!row) return { status: 404, html: "" };

  const message = Messages.getMessage(row.message_id);
  if (!message) return { status: 404, html: "" };

  const session = Sessions.getSession(message.session_id);
  if (!session) return { status: 404, html: "" };

  const scopes: string[] = [];

  // Add to session
  if (body?.session === "true") {
    const existing: string[] = session.allowed_tools ? JSON.parse(session.allowed_tools) : [];
    if (!existing.includes(pattern)) {
      existing.push(pattern);
      Sessions.updateSession(session.id, { allowedTools: existing });
    }
    scopes.push("session");
  }

  // Add to workspace
  if (body?.workspace === "true") {
    const workspace = Workspaces.getWorkspace(session.workspace_id);
    if (workspace) {
      const existing: string[] = workspace.allowed_tools ? JSON.parse(workspace.allowed_tools) : [];
      if (!existing.includes(pattern)) {
        existing.push(pattern);
        Workspaces.updateWorkspace(workspace.id, { allowedTools: existing });
      }
    }
    scopes.push("workspace");
  }

  // Add to global
  if (body?.global === "true") {
    const settings = Settings.getSettings();
    const existing: string[] = settings.allowed_tools ? JSON.parse(settings.allowed_tools) : [];
    if (!existing.includes(pattern)) {
      existing.push(pattern);
      Settings.updateSettings({ allowedTools: existing });
    }
    scopes.push("global");
  }

  // Resolve the permission as allowed with rule info
  const scopeLabel = scopes.length > 0 ? scopes.join(", ") : "once";
  if (row.status === "pending") {
    Messages.resolvePermission(id, true, { rulePattern: pattern, ruleScope: scopeLabel });
  }

  // Return full message group so polling resumes
  return { status: 200, html: renderFullMessageGroup(row.message_id) };
}

function interruptSessionView(ctx: RouteContext) {
  const { sid } = ctx.params;
  const session = Sessions.getSession(sid);
  if (!session) return { status: 404, html: "" };

  // Interrupt active messages — abort the query and update DB immediately
  const activeIds = Sessions.getActiveMessageIds(sid);
  for (const mid of activeIds) {
    interruptQuery(mid);
    Messages.interruptMessage(mid);
  }

  // Return updated input bar + OOB message groups and session list
  let html = renderInputBar(sid);
  for (const mid of activeIds) {
    const msg = Messages.getMessage(mid);
    if (msg) {
      const evts = Messages.getAllMessageEvents(mid);
      const msgHtml = renderMessageGroup(msg, evts);
      if (msgHtml) {
        html += msgHtml.replace(`id="msg-${mid}"`, `id="msg-${mid}" hx-swap-oob="outerHTML"`);
      }
    }
  }
  html += renderSessionList(Sessions.listSessions(session.workspace_id), sid, true);

  return { status: 200, html };
}

function checkMessagesView(ctx: RouteContext) {
  const { sid } = ctx.params;
  const session = Sessions.getSession(sid);
  if (!session) return { status: 404, html: "" };

  const messages = Messages.listMessages(sid);
  const html = messages.map(m => {
    const events = Messages.getAllMessageEvents(m.id);
    return renderMessageGroup(m, events);
  }).join("") || `<div id="empty-messages" style="color:var(--text-dim);text-align:center;margin-top:40px;font-size:13px">No messages yet. Send a prompt to begin.</div>`;

  // Also sync session list status
  return { status: 200, html: html + renderSessionList(Sessions.listSessions(session.workspace_id), sid, true) };
}

function inputBarView(ctx: RouteContext) {
  const { sid } = ctx.params;
  return { status: 200, html: renderInputBar(sid) };
}

function renderFullMessageGroup(messageId: string): string {
  const message = Messages.getMessage(messageId);
  if (!message) return "";
  const events = Messages.getAllMessageEvents(messageId);
  return renderMessageGroup(message, events);
}

function renderResolvedPermission(row: PermissionRequestRow): string {
  const status = row.status === "allowed" ? "Allowed" : "Denied";
  const extra = row.rule_pattern
    ? ` <span style="font-family:var(--mono);font-size:10px;color:var(--accent)">(rule: ${esc(row.rule_pattern)} \u2192 ${esc(row.rule_scope || "session")})</span>`
    : "";
  return `<div class="event-permission" id="perm-${row.id}">
    <div class="perm-title">${esc(row.title || row.tool_name)}</div>
    ${row.description ? `<div class="perm-desc">${esc(row.description)}</div>` : ""}
    <div class="perm-resolved">${status}${extra}</div>
  </div>`;
}

function collectFailedToolIds(events: MessageEventRow[]): Set<string> {
  const failed = new Set<string>();
  for (const e of events) {
    const data = JSON.parse(e.data);
    if (data.type !== "user") continue;
    const content = data.message?.content || [];
    for (const block of content) {
      if (block.type === "tool_result" && block.is_error) {
        failed.add(block.tool_use_id);
      }
    }
  }
  return failed;
}

// --- Session changes ---

function sessionChangesView(ctx: RouteContext) {
  const { sid } = ctx.params;
  const session = Sessions.getSession(sid);
  if (!session) return { status: 404, html: "" };

  const messages = Messages.listMessages(sid);
  interface FileChange {
    originalFile: string | null;
    edits: Array<{ old: string; new: string }>;
    writes: string[];
  }
  const fileChanges = new Map<string, FileChange>();

  for (const msg of messages) {
    const events = Messages.getAllMessageEvents(msg.id);
    const failed = collectFailedToolIds(events);

    // Map tool_use_id -> tool_use block for correlating results
    const toolUseMap = new Map<string, { name: string; input: Record<string, unknown> }>();

    for (const e of events) {
      const data = JSON.parse(e.data);

      if (data.type === "assistant") {
        for (const block of (data.message?.content || [])) {
          if (block.type !== "tool_use" || !block.input?.file_path) continue;
          if (block.id && failed.has(block.id)) continue;
          toolUseMap.set(block.id, block);

          const path = block.input.file_path;
          let entry = fileChanges.get(path);
          if (!entry) {
            entry = { originalFile: null, edits: [], writes: [] };
            fileChanges.set(path, entry);
          }

          if (block.name === "Edit" && block.input.old_string && block.input.new_string) {
            entry.edits.push({ old: block.input.old_string, new: block.input.new_string });
          } else if (block.name === "Write" && block.input.content) {
            entry.writes.push(block.input.content);
          }
        }
      }

      // Capture originalFile from Edit tool results
      if (data.type === "user" && data.tool_use_result && typeof data.tool_use_result === "object") {
        const result = data.tool_use_result as Record<string, unknown>;
        if (result.filePath && result.originalFile != null) {
          const path = String(result.filePath);
          const entry = fileChanges.get(path);
          if (entry && entry.originalFile === null) {
            entry.originalFile = String(result.originalFile);
          }
        }
      }
    }
  }

  if (fileChanges.size === 0) {
    return { status: 200, html: `<div class="diff-empty">No file changes in this session</div>` };
  }

  const parts: string[] = [];
  for (const [path, changes] of fileChanges) {
    let original = "";
    let current = "";

    if (changes.writes.length > 0) {
      // File was created/written — original is empty, current is last write
      original = "";
      current = changes.writes[changes.writes.length - 1];
    } else if (changes.originalFile !== null) {
      // Have the full original from Edit tool result
      original = changes.originalFile;
      current = original;
    }

    // Apply edits sequentially on top of current state
    for (const ed of changes.edits) {
      current = current.replace(ed.old, ed.new);
    }

    // Diff original vs final
    const origLines = original.split("\n");
    const finalLines = current.split("\n");
    const diffHtml = renderLineDiff(origLines, finalLines);

    parts.push(`<div class="diff-file"><div class="diff-file-header">${esc(path)}</div>${diffHtml}</div>`);
  }

  return { status: 200, html: parts.join("") };
}

function renderLineDiff(origLines: string[], finalLines: string[]): string {
  // Simple LCS-based line diff
  const m = origLines.length;
  const n = finalLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = origLines[i - 1] === finalLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  let i = m, j = n;
  const ops: Array<{ type: "ctx" | "del" | "add"; line: string }> = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && origLines[i - 1] === finalLines[j - 1]) {
      ops.push({ type: "ctx", line: origLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "add", line: finalLines[j - 1] });
      j--;
    } else {
      ops.push({ type: "del", line: origLines[i - 1] });
      i--;
    }
  }
  ops.reverse();

  const parts: string[] = [];
  let oldNum = 0, newNum = 0;
  for (const op of ops) {
    const oldLn = op.type === "add" ? "" : String(++oldNum);
    const newLn = op.type === "del" ? "" : String(++newNum);
    const cls = op.type === "del" ? "diff-del" : op.type === "add" ? "diff-add" : "diff-ctx";
    const prefix = op.type === "del" ? "-" : op.type === "add" ? "+" : " ";
    parts.push(`<div class="${cls}"><span class="diff-ln">${oldLn}</span><span class="diff-ln">${newLn}</span>${prefix}${esc(op.line)}</div>`);
  }

  return parts.join("");
}

// --- Git diff viewer ---

async function gitDiffView(ctx: RouteContext) {
  const { sid } = ctx.params;
  const session = Sessions.getSession(sid);
  if (!session) return { status: 404, html: "" };

  const workspace = Workspaces.getWorkspace(session.workspace_id);
  if (!workspace) return { status: 404, html: "" };

  try {
    const { stdout } = await execAsync("git diff HEAD", { cwd: workspace.cwd, maxBuffer: 1024 * 1024 * 5 });
    const diffHtml = stdout.trim() ? renderDiff(stdout) : `<div class="diff-empty">No changes</div>`;
    return { status: 200, html: diffHtml };
  } catch {
    return { status: 200, html: `<div class="diff-empty">Not a git repository</div>` };
  }
}

function renderDiff(raw: string): string {
  const lines = raw.split("\n");
  const parts: string[] = [];
  let inFile = false;
  let fileName = "";

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      if (inFile) parts.push("</div>");
      const match = line.match(/b\/(.+)$/);
      fileName = match ? match[1] : line;
      parts.push(`<div class="diff-file"><div class="diff-file-header">${esc(fileName)}</div>`);
      inFile = true;
    } else if (line.startsWith("@@")) {
      const hunkMatch = line.match(/^@@\s+(.+?)\s+@@\s*(.*)/);
      const range = hunkMatch ? hunkMatch[1] : line;
      const ctx = hunkMatch?.[2] || "";
      parts.push(`<div class="diff-hunk">${esc(range)} ${esc(ctx)}</div>`);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      parts.push(`<div class="diff-add">${esc(line)}</div>`);
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      parts.push(`<div class="diff-del">${esc(line)}</div>`);
    } else if (line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++") || line.startsWith("new file") || line.startsWith("deleted file")) {
      // skip meta lines
    } else {
      parts.push(`<div class="diff-ctx">${esc(line)}</div>`);
    }
  }
  if (inFile) parts.push("</div>");

  return parts.join("\n");
}

// --- File browser ---

async function fileBrowserView(ctx: RouteContext) {
  const { sid } = ctx.params;
  const session = Sessions.getSession(sid);
  if (!session) return { status: 404, html: "" };

  const workspace = Workspaces.getWorkspace(session.workspace_id);
  if (!workspace) return { status: 404, html: "" };

  const subdir = ctx.query.path || "";
  const showHidden = ctx.query.hidden === "true";
  const open = subdir ? [subdir] : [];

  const { readdir, stat } = await import("node:fs/promises");
  const { join, relative } = await import("node:path");

  const root = workspace.cwd;
  const absDir = subdir ? join(root, subdir) : root;
  const rel = subdir ? relative(root, absDir) : "";
  if (rel.startsWith("..")) return { status: 400, html: "" };

  try {
    let entries = await readdir(absDir, { withFileTypes: true });
    if (!showHidden) entries = entries.filter(e => !e.name.startsWith("."));
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const items = await Promise.all(entries.map(async e => {
      let size = "";
      try {
        const s = await stat(join(absDir, e.name));
        if (s.isFile()) size = formatSize(s.size);
      } catch {}
      const isDir = e.isDirectory();
      const childPath = subdir ? subdir + "/" + e.name : e.name;
      if (isDir) {
        return `<div class="fb-item fb-dir" onclick="browseDir('${esc(childPath)}')">
          <span class="fb-icon">&#128193;</span> ${esc(e.name)}/
        </div>`;
      }
      return `<div class="fb-item fb-file" onclick="viewFile('${esc(childPath)}')" style="cursor:pointer">
        <span class="fb-icon">&middot;</span> ${esc(e.name)} <span class="fb-size">${size}</span>
      </div>`;
    }));

    // Breadcrumbs
    const pathParts = subdir ? subdir.split("/").filter(Boolean) : [];
    let crumbs = `<span class="fb-crumb" onclick="browseDir('')">${esc(workspace.name)}</span>`;
    let built = "";
    for (const p of pathParts) {
      built += (built ? "/" : "") + p;
      const target = built;
      crumbs += ` / <span class="fb-crumb" onclick="browseDir('${esc(target)}')">${esc(p)}</span>`;
    }

    return {
      status: 200,
      html: `<div class="fb-path">${crumbs}</div>
        <div class="fb-list">${items.join("")}</div>`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to read directory";
    return { status: 200, html: `<div class="diff-empty">${esc(msg)}</div>` };
  }
}

async function fileContentView(ctx: RouteContext) {
  const { sid } = ctx.params;
  const session = Sessions.getSession(sid);
  if (!session) return { status: 404, html: "" };

  const workspace = Workspaces.getWorkspace(session.workspace_id);
  if (!workspace) return { status: 404, html: "" };

  const filePath = ctx.query.path;
  if (!filePath) return { status: 400, html: "" };

  const { join, relative } = await import("node:path");
  const { readFile } = await import("node:fs/promises");

  const absPath = join(workspace.cwd, filePath);
  const rel = relative(workspace.cwd, absPath);
  if (rel.startsWith("..")) return { status: 400, html: "" };

  const breadcrumbs = `<div class="fb-path"><span class="fb-crumb" onclick="browseDir('')">${esc(workspace.name)}</span>${filePath.split("/").filter(Boolean).reduce((acc: string, p: string, i: number, arr: string[]) => {
    const partial = arr.slice(0, i + 1).join("/");
    if (i === arr.length - 1) return acc + ` / <span>${esc(p)}</span>`;
    return acc + ` / <span class="fb-crumb" onclick="browseDir('${esc(partial)}')">${esc(p)}</span>`;
  }, "")}</div>`;

  try {
    const content = await readFile(absPath, "utf-8");
    const lines = content.split("\n");
    const numbered = lines.map((l, i) =>
      `<div class="diff-ctx"><span class="diff-ln">${i + 1}</span> ${esc(l)}</div>`
    ).join("");
    return {
      status: 200,
      html: `${breadcrumbs}<div class="diff-body" style="flex:1;overflow:auto;font-family:var(--mono);font-size:12px;line-height:1.6">${numbered}</div>`,
    };
  } catch {
    return { status: 200, html: `${breadcrumbs}<div class="diff-empty">Unable to read file</div>` };
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
