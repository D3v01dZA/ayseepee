import { randomUUID } from "node:crypto";
import { Router, type RouteContext } from "../router.js";
import { getDb } from "../db.js";
import { runQuery, interruptQuery } from "../agent.js";
import type {
  SessionRow, WorkspaceRow, MessageRow, MessageEventRow, PermissionRequestRow,
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
  const db = getDb();
  const { workspaceId } = ctx.params;

  const workspace = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as WorkspaceRow | undefined;
  if (!workspace) return { status: 404, body: { error: "Workspace not found" } };

  const body = (ctx.body as CreateSessionBody | undefined) ?? {};
  const id = randomUUID();

  db.prepare(
    "INSERT INTO sessions (id, workspace_id, name, model, permission_mode) VALUES (?, ?, ?, ?, ?)"
  ).run(id, workspaceId, body.name ?? null, body.model ?? null, body.permissionMode ?? null);

  return { status: 201, body: rowToSession(db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow) };
}

function listSessions(ctx: RouteContext) {
  const db = getDb();
  const { workspaceId } = ctx.params;

  const workspace = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as WorkspaceRow | undefined;
  if (!workspace) return { status: 404, body: { error: "Workspace not found" } };

  const rows = db
    .prepare("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY last_active_at DESC")
    .all(workspaceId) as SessionRow[];
  return { status: 200, body: rows.map(rowToSession) };
}

function getSession(ctx: RouteContext) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(ctx.params.id) as SessionRow | undefined;
  if (!row) return { status: 404, body: { error: "Session not found" } };
  return { status: 200, body: rowToSession(row) };
}

function updateSession(ctx: RouteContext) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(ctx.params.id) as SessionRow | undefined;
  if (!row) return { status: 404, body: { error: "Session not found" } };

  const body = ctx.body as UpdateSessionBody | undefined;
  if (!body) return { status: 400, body: { error: "Request body required" } };

  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) {
    fields.push("name = ?");
    values.push(body.name ?? null);
  }
  if (body.model !== undefined) {
    fields.push("model = ?");
    values.push(body.model || null);
  }
  if (body.permissionMode !== undefined) {
    fields.push("permission_mode = ?");
    values.push(body.permissionMode || null);
  }

  if (fields.length === 0) {
    return { status: 400, body: { error: "No fields to update" } };
  }

  values.push(ctx.params.id);
  db.prepare(`UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`).run(...values);

  const updated = db.prepare("SELECT * FROM sessions WHERE id = ?").get(ctx.params.id) as SessionRow;
  return { status: 200, body: rowToSession(updated) };
}

function deleteSession(ctx: RouteContext) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(ctx.params.id) as SessionRow | undefined;
  if (!row) return { status: 404, body: { error: "Session not found" } };

  // Interrupt any active messages
  const activeMessages = db
    .prepare("SELECT id FROM messages WHERE session_id = ? AND status IN ('pending', 'streaming')")
    .all(ctx.params.id) as Pick<MessageRow, "id">[];
  for (const msg of activeMessages) {
    interruptQuery(msg.id);
  }

  db.prepare("DELETE FROM message_events WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)").run(
    ctx.params.id
  );
  db.prepare("DELETE FROM messages WHERE session_id = ?").run(ctx.params.id);
  db.prepare("DELETE FROM sessions WHERE id = ?").run(ctx.params.id);
  return { status: 204 };
}

function listMessages(ctx: RouteContext) {
  const db = getDb();
  const { id: sessionId } = ctx.params;

  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
  if (!session) return { status: 404, body: { error: "Session not found" } };

  const rows = db
    .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
    .all(sessionId) as MessageRow[];

  const messages: MessageResponse[] = rows.map((m) => {
    const events = db
      .prepare("SELECT id, event_type, data, created_at FROM message_events WHERE message_id = ? ORDER BY id")
      .all(m.id) as MessageEventRow[];

    return rowToMessage(m, events.map((e) => parseEvent(db, e)));
  });

  return { status: 200, body: messages };
}

function sendMessage(ctx: RouteContext) {
  const db = getDb();
  const { id: sessionId } = ctx.params;

  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
  if (!session) return { status: 404, body: { error: "Session not found" } };

  if (session.status === "active") {
    return { status: 409, body: { error: "Session has an active query. Interrupt it first or wait." } };
  }

  const body = ctx.body as Partial<SendMessageBody> | undefined;
  if (!body?.prompt) {
    return { status: 400, body: { error: "prompt is required" } };
  }

  const workspace = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(session.workspace_id) as
    WorkspaceRow | undefined;
  if (!workspace) return { status: 500, body: { error: "Workspace not found for session" } };

  // Auto-name session from first prompt if unnamed
  if (!session.name) {
    const autoName = body.prompt.length > 60 ? body.prompt.slice(0, 57) + "..." : body.prompt;
    db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(autoName, sessionId);
  }

  const messageId = randomUUID();
  db.prepare("INSERT INTO messages (id, session_id, prompt) VALUES (?, ?, ?)").run(
    messageId,
    sessionId,
    body.prompt
  );

  runQuery({
    messageId,
    sessionId,
    prompt: body.prompt,
    cwd: workspace.cwd,
    agentSessionId: session.agent_session_id,
    allowedTools: workspace.allowed_tools ? JSON.parse(workspace.allowed_tools) : null,
    systemPrompt: workspace.system_prompt,
    permissionMode: session.permission_mode || workspace.permission_mode || "default",
    model: body.model ?? session.model ?? null,
    maxTurns: body.maxTurns ?? null,
    maxBudgetUsd: body.maxBudgetUsd ?? null,
  });

  return {
    status: 202,
    body: { id: messageId, sessionId, status: "pending" },
  };
}

function getMessage(ctx: RouteContext) {
  const db = getDb();
  const { id: messageId } = ctx.params;
  const afterId = ctx.query.after ? parseInt(ctx.query.after, 10) : 0;

  const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRow | undefined;
  if (!message) return { status: 404, body: { error: "Message not found" } };

  const events = db
    .prepare("SELECT id, event_type, data, created_at FROM message_events WHERE message_id = ? AND id > ? ORDER BY id")
    .all(messageId, afterId) as MessageEventRow[];

  return {
    status: 200,
    body: rowToMessage(message, events.map((e) => parseEvent(db, e))),
  };
}

function interruptMessage(ctx: RouteContext) {
  const db = getDb();
  const { id: messageId } = ctx.params;

  const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRow | undefined;
  if (!message) return { status: 404, body: { error: "Message not found" } };

  if (message.status !== "streaming" && message.status !== "pending") {
    return { status: 409, body: { error: "Message is not active" } };
  }

  const interrupted = interruptQuery(messageId);
  if (interrupted) {
    db.prepare("UPDATE messages SET status = 'error', error = 'interrupted', completed_at = datetime('now') WHERE id = ?").run(
      messageId
    );
    db.prepare("UPDATE sessions SET status = 'idle', last_active_at = datetime('now') WHERE id = ?").run(
      message.session_id
    );
  }

  return { status: 200, body: { interrupted } };
}

function resolvePermission(ctx: RouteContext) {
  const db = getDb();
  const { id } = ctx.params;

  const row = db.prepare("SELECT * FROM permission_requests WHERE id = ?").get(id) as PermissionRequestRow | undefined;
  if (!row) return { status: 404, body: { error: "Permission request not found" } };
  if (row.status !== "pending") return { status: 409, body: { error: "Already resolved" } };

  const body = ctx.body as ResolvePermissionBody | undefined;
  if (!body || typeof body.allow !== "boolean") {
    return { status: 400, body: { error: "allow (boolean) is required" } };
  }

  db.prepare(
    "UPDATE permission_requests SET status = ?, response = ?, resolved_at = datetime('now') WHERE id = ?"
  ).run(body.allow ? "allowed" : "denied", body.message ?? null, id);

  return { status: 200, body: { id, status: body.allow ? "allowed" : "denied" } };
}

function parseEvent(db: ReturnType<typeof getDb>, e: MessageEventRow): MessageEventResponse {
  const data = JSON.parse(e.data);
  if (e.event_type === "permission_request" && data.id) {
    const perm = db.prepare("SELECT status FROM permission_requests WHERE id = ?").get(data.id) as
      Pick<PermissionRequestRow, "status"> | undefined;
    if (perm) data.resolved = perm.status;
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
    status: row.status,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}
