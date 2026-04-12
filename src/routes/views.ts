import { Router, type RouteContext } from "../router.js";
import { runQuery } from "../agent.js";
import * as Settings from "../data/settings.js";
import * as Workspaces from "../data/workspaces.js";
import * as Sessions from "../data/sessions.js";
import * as Messages from "../data/messages.js";
import type {
  WorkspaceRow, SessionRow, MessageRow, MessageEventRow, PermissionRequestRow,
} from "../types.js";

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
  router.post("/views/permissions/:id/resolve", resolvePermissionView);
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
    <div class="meta">${esc(shortModel(resolved.model))} · ${esc(permModeLabel(resolved.permissionMode))}</div>
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

function renderInputBar(sessionId: string): string {
  return `<form class="input-bar" id="input-bar"
      hx-post="/views/sessions/${sessionId}/messages"
      hx-target="#messages-feed" hx-swap="beforeend"
      hx-on::after-request="if(event.detail.successful){this.querySelector('input[name=prompt]').value='';var e=document.getElementById('empty-messages');if(e)e.remove();var f=document.getElementById('messages-feed');if(f)f.scrollTop=f.scrollHeight;}">
    <input type="text" name="prompt" placeholder="Send a message..." autocomplete="off">
    <button type="submit" class="btn btn-primary">Send</button>
  </form>`;
}

function renderMessageGroup(message: MessageRow, events: MessageEventRow[]): string {
  const isActive = message.status === "pending" || message.status === "streaming";
  const pollAttr = isActive
    ? ` hx-get="/views/poll-message/${message.id}" hx-trigger="every 1s" hx-swap="outerHTML"`
    : "";
  return `<div class="message-group" id="msg-${message.id}"${pollAttr}>
    <div class="message-prompt">
      <div class="label">You</div>
      ${esc(message.prompt)}
    </div>
    <div class="message-events">
      ${renderEvents(message, events)}
    </div>
  </div>`;
}

function renderEvents(message: MessageRow, events: MessageEventRow[]): string {
  const isActive = message.status === "pending" || message.status === "streaming";

  if (events.length === 0) {
    return isActive ? `<div class="event"><span class="event-type">waiting...</span></div>` : "";
  }

  const rendered = events.map(e => renderEvent(e)).join("");

  if (isActive) {
    return rendered + `<div class="event"><span class="event-type">streaming...</span></div>`;
  }
  return rendered;
}

function renderEvent(e: MessageEventRow): string {
  const data = JSON.parse(e.data);

  // Assistant message
  if (data.type === "assistant") {
    const parts: string[] = [];
    const content = data.message?.content || [];
    for (const block of content) {
      if (block.type === "text" && block.text?.trim()) {
        parts.push(`<div class="event-assistant">${esc(block.text.trim())}</div>`);
      } else if (block.type === "tool_use") {
        parts.push(`<div class="event-tool-use">
          <span class="tool-name">${esc(block.name)}</span>
          <div class="tool-input">${esc(formatToolInput(block.input))}</div>
        </div>`);
      }
    }
    return parts.length ? `<div class="event">${parts.join("")}</div>` : "";
  }

  // Permission request
  if (e.event_type === "permission_request") {
    const status = Messages.getPermissionStatus(data.id);
    const inner = (status && status !== "pending")
      ? `<div class="perm-resolved">${status === "allowed" ? "Allowed" : "Denied"}</div>`
      : `<div class="perm-actions">
          <button class="btn btn-sm" style="background:var(--green);color:#000;border:none;"
                  hx-post="/views/permissions/${data.id}/resolve" hx-vals='{"allow":"true"}'
                  hx-target="closest .event-permission" hx-swap="outerHTML">Allow</button>
          <button class="btn btn-sm" style="background:var(--red);color:#fff;border:none;"
                  hx-post="/views/permissions/${data.id}/resolve" hx-vals='{"allow":"false"}'
                  hx-target="closest .event-permission" hx-swap="outerHTML">Deny</button>
        </div>`;
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
    const modelTag = model ? `<span class="event-model">${esc(shortModel(model))}</span> ` : "";
    const errorText = isError && data.error ? esc(data.error) : "";
    return `<div class="event"><div class="event-result ${isError ? "error" : ""}">
      ${errorText}
      <div class="cost">${modelTag}${data.total_cost_usd ? "$" + data.total_cost_usd.toFixed(4) : ""} ${data.duration_ms ? (data.duration_ms / 1000).toFixed(1) + "s" : ""}</div>
    </div></div>`;
  }

  // Tool result
  if (data.type === "user" && data.tool_use_result !== undefined) {
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

function formatToolResult(result: unknown): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null) {
    const obj = result as Record<string, unknown>;
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

function resolvePermissionView(ctx: RouteContext) {
  const { id } = ctx.params;
  const body = ctx.body as Record<string, string> | undefined;

  const row = Messages.getPermission(id);
  if (!row) return { status: 404, html: "" };

  if (row.status !== "pending") {
    return { status: 200, html: renderResolvedPermission(row) };
  }

  const allow = body?.allow === "true";
  const updated = Messages.resolvePermission(id, allow);
  return { status: 200, html: renderResolvedPermission(updated) };
}

function renderResolvedPermission(row: PermissionRequestRow): string {
  const status = row.status === "allowed" ? "Allowed" : "Denied";
  return `<div class="event-permission" id="perm-${row.id}">
    <div class="perm-title">${esc(row.title || row.tool_name)}</div>
    ${row.description ? `<div class="perm-desc">${esc(row.description)}</div>` : ""}
    <div class="perm-resolved">${status}</div>
  </div>`;
}
