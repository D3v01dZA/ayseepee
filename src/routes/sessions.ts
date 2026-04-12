import { Router, type RouteContext } from "../router.js";
import { runQuery, interruptQuery } from "../agent.js";
import * as Settings from "../data/settings.js";
import * as Workspaces from "../data/workspaces.js";
import * as Sessions from "../data/sessions.js";
import * as Messages from "../data/messages.js";
import type {
  SessionRow, MessageRow, MessageEventRow,
  CreateSessionBody, UpdateSessionBody, SendMessageBody, ResolvePermissionBody,
  SessionResponse, MessageResponse, MessageEventResponse,
} from "../types.js";

export function registerSessionRoutes(router: Router): void {
  // Session CRUD
  router.post("/api/v1/workspaces/:workspaceId/sessions", createSession);
  router.get("/api/v1/workspaces/:workspaceId/sessions", listSessions);
  router.get("/api/v1/sessions/:id", getSession);
  router.patch("/api/v1/sessions/:id", updateSession);
  router.delete("/api/v1/sessions/:id", deleteSession);

  // Messaging
  router.get("/api/v1/sessions/:id/messages", listMessages);
  router.post("/api/v1/sessions/:id/messages", sendMessage);
  router.get("/api/v1/messages/:id", getMessage);
  router.post("/api/v1/messages/:id/interrupt", interruptMessage);

  // Permissions
  router.post("/api/v1/permissions/:id/resolve", resolvePermission);
}

function createSession(ctx: RouteContext) {
  const { workspaceId } = ctx.params;
  if (!Workspaces.getWorkspace(workspaceId)) {
    return { status: 404, body: { error: "Workspace not found" } };
  }

  const body = (ctx.body as CreateSessionBody | undefined) ?? {};
  const row = Sessions.createSession(workspaceId, {
    name: body.name,
    model: body.model,
    permissionMode: body.permissionMode,
    allowedTools: body.allowedTools,
    allowedToolsMode: body.allowedToolsMode,
  });

  return { status: 201, body: rowToSession(row) };
}

function listSessions(ctx: RouteContext) {
  const { workspaceId } = ctx.params;
  if (!Workspaces.getWorkspace(workspaceId)) {
    return { status: 404, body: { error: "Workspace not found" } };
  }
  return { status: 200, body: Sessions.listSessions(workspaceId).map(rowToSession) };
}

function getSession(ctx: RouteContext) {
  const row = Sessions.getSession(ctx.params.id);
  if (!row) return { status: 404, body: { error: "Session not found" } };
  return { status: 200, body: rowToSession(row) };
}

function updateSession(ctx: RouteContext) {
  const row = Sessions.getSession(ctx.params.id);
  if (!row) return { status: 404, body: { error: "Session not found" } };

  const body = ctx.body as UpdateSessionBody | undefined;
  if (!body) return { status: 400, body: { error: "Request body required" } };

  const hasFields = body.name !== undefined || body.model !== undefined || body.permissionMode !== undefined || body.allowedTools !== undefined || body.allowedToolsMode !== undefined;
  if (!hasFields) return { status: 400, body: { error: "No fields to update" } };

  const updated = Sessions.updateSession(ctx.params.id, {
    name: body.name,
    model: body.model,
    permissionMode: body.permissionMode,
    allowedTools: body.allowedTools,
    allowedToolsMode: body.allowedToolsMode,
  });

  return { status: 200, body: rowToSession(updated) };
}

function deleteSession(ctx: RouteContext) {
  const row = Sessions.getSession(ctx.params.id);
  if (!row) return { status: 404, body: { error: "Session not found" } };

  // Interrupt any active messages
  for (const msgId of Sessions.getActiveMessageIds(ctx.params.id)) {
    interruptQuery(msgId);
  }

  Sessions.deleteSession(ctx.params.id);
  return { status: 204 };
}

function listMessages(ctx: RouteContext) {
  const { id: sessionId } = ctx.params;
  if (!Sessions.getSession(sessionId)) {
    return { status: 404, body: { error: "Session not found" } };
  }

  const rows = Messages.listMessages(sessionId);
  const messages: MessageResponse[] = rows.map(m => {
    const events = Messages.getMessageEvents(m.id);
    return rowToMessage(m, events.map(e => parseEvent(e)));
  });

  return { status: 200, body: messages };
}

function sendMessage(ctx: RouteContext) {
  const { id: sessionId } = ctx.params;

  const session = Sessions.getSession(sessionId);
  if (!session) return { status: 404, body: { error: "Session not found" } };

  if (session.status === "active") {
    return { status: 409, body: { error: "Session has an active query. Interrupt it first or wait." } };
  }

  const body = ctx.body as Partial<SendMessageBody> | undefined;
  if (!body?.prompt) {
    return { status: 400, body: { error: "prompt is required" } };
  }

  const workspace = Workspaces.getWorkspace(session.workspace_id);
  if (!workspace) return { status: 500, body: { error: "Workspace not found for session" } };

  const resolved = Settings.resolveSettings(Settings.getSettings(), workspace, session);

  // Auto-name session from first prompt if unnamed
  if (!session.name) {
    Sessions.autoNameSession(sessionId, body.prompt);
  }

  const message = Messages.createMessage(sessionId, body.prompt);

  runQuery({
    messageId: message.id,
    sessionId,
    prompt: body.prompt,
    cwd: workspace.cwd,
    agentSessionId: session.agent_session_id,
    allowedTools: resolved.allowedTools,
    systemPrompt: workspace.system_prompt,
    permissionMode: resolved.permissionMode,
    model: body.model ?? resolved.model,
    maxTurns: body.maxTurns ?? null,
    maxBudgetUsd: body.maxBudgetUsd ?? null,
  });

  return {
    status: 202,
    body: { id: message.id, sessionId, status: "pending" },
  };
}

function getMessage(ctx: RouteContext) {
  const { id: messageId } = ctx.params;
  const afterId = ctx.query.after ? parseInt(ctx.query.after, 10) : 0;

  const message = Messages.getMessage(messageId);
  if (!message) return { status: 404, body: { error: "Message not found" } };

  const events = Messages.getMessageEvents(messageId, afterId);
  return {
    status: 200,
    body: rowToMessage(message, events.map(e => parseEvent(e))),
  };
}

function interruptMessage(ctx: RouteContext) {
  const { id: messageId } = ctx.params;

  const message = Messages.getMessage(messageId);
  if (!message) return { status: 404, body: { error: "Message not found" } };

  if (message.status !== "streaming" && message.status !== "pending") {
    return { status: 409, body: { error: "Message is not active" } };
  }

  const interrupted = interruptQuery(messageId);
  if (interrupted) {
    Messages.interruptMessage(messageId);
  }

  return { status: 200, body: { interrupted } };
}

function resolvePermission(ctx: RouteContext) {
  const { id } = ctx.params;

  const row = Messages.getPermission(id);
  if (!row) return { status: 404, body: { error: "Permission request not found" } };
  if (row.status !== "pending") return { status: 409, body: { error: "Already resolved" } };

  const body = ctx.body as ResolvePermissionBody | undefined;
  if (!body || typeof body.allow !== "boolean") {
    return { status: 400, body: { error: "allow (boolean) is required" } };
  }

  const pattern = body.rulePattern?.trim();
  const scopes: string[] = [];

  if (pattern && body.allow) {
    const message = Messages.getMessage(row.message_id);
    const session = message ? Sessions.getSession(message.session_id) : undefined;

    if (body.addToSession && session) {
      const existing: string[] = session.allowed_tools ? JSON.parse(session.allowed_tools) : [];
      if (!existing.includes(pattern)) {
        existing.push(pattern);
        Sessions.updateSession(session.id, { allowedTools: existing });
      }
      scopes.push("session");
    }

    if (body.addToWorkspace && session) {
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

    if (body.addToGlobal) {
      const settings = Settings.getSettings();
      const existing: string[] = settings.allowed_tools ? JSON.parse(settings.allowed_tools) : [];
      if (!existing.includes(pattern)) {
        existing.push(pattern);
        Settings.updateSettings({ allowedTools: existing });
      }
      scopes.push("global");
    }
  }

  const ruleScope = scopes.length > 0 ? scopes.join(", ") : undefined;
  Messages.resolvePermission(id, body.allow, {
    message: body.message,
    rulePattern: pattern,
    ruleScope,
  });

  return { status: 200, body: { id, status: body.allow ? "allowed" : "denied", rulePattern: pattern || null, ruleScope: ruleScope || null } };
}

function parseEvent(e: MessageEventRow): MessageEventResponse {
  const data = JSON.parse(e.data);
  if (e.event_type === "permission_request" && data.id) {
    const status = Messages.getPermissionStatus(data.id);
    if (status) data.resolved = status;
  }
  return { id: e.id, type: e.event_type, data, createdAt: e.created_at };
}

function rowToMessage(row: MessageRow, events: MessageEventResponse[]): MessageResponse {
  return {
    id: row.id,
    sessionId: row.session_id,
    prompt: row.prompt,
    status: row.status,
    result: row.result,
    error: row.error,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    events,
  };
}

function rowToSession(row: SessionRow): SessionResponse {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    agentSessionId: row.agent_session_id,
    model: row.model,
    permissionMode: row.permission_mode,
    allowedTools: row.allowed_tools ? JSON.parse(row.allowed_tools) : null,
    allowedToolsMode: row.allowed_tools_mode,
    status: row.status,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}
