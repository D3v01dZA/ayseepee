import { randomUUID } from "node:crypto";
import { Router, type RouteContext } from "../router.js";
import { getDb } from "../db.js";
import { runQuery, interruptQuery } from "../agent.js";

export function registerSessionRoutes(router: Router): void {
  // Session CRUD
  router.post("/api/v1/workspaces/:workspaceId/sessions", createSession);
  router.get("/api/v1/workspaces/:workspaceId/sessions", listSessions);
  router.get("/api/v1/sessions/:id", getSession);
  router.delete("/api/v1/sessions/:id", deleteSession);

  // Messaging
  router.get("/api/v1/sessions/:id/messages", listMessages);
  router.post("/api/v1/sessions/:id/messages", sendMessage);
  router.get("/api/v1/messages/:id", getMessage);
  router.post("/api/v1/messages/:id/interrupt", interruptMessage);
}

function createSession(ctx: RouteContext) {
  const db = getDb();
  const { workspaceId } = ctx.params;

  const workspace = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId);
  if (!workspace) return { status: 404, body: { error: "Workspace not found" } };

  const body = (ctx.body as { name?: string; model?: string; permissionMode?: string } | undefined) ?? {};
  const id = randomUUID();

  db.prepare(
    "INSERT INTO sessions (id, workspace_id, name, model, permission_mode) VALUES (?, ?, ?, ?, ?)"
  ).run(id, workspaceId, body.name ?? null, body.model ?? null, body.permissionMode ?? null);

  return { status: 201, body: rowToSession(db.prepare("SELECT * FROM sessions WHERE id = ?").get(id)) };
}

function listSessions(ctx: RouteContext) {
  const db = getDb();
  const { workspaceId } = ctx.params;

  const workspace = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId);
  if (!workspace) return { status: 404, body: { error: "Workspace not found" } };

  const rows = db
    .prepare("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY last_active_at DESC")
    .all(workspaceId);
  return { status: 200, body: rows.map(rowToSession) };
}

function getSession(ctx: RouteContext) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(ctx.params.id);
  if (!row) return { status: 404, body: { error: "Session not found" } };
  return { status: 200, body: rowToSession(row) };
}

function deleteSession(ctx: RouteContext) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(ctx.params.id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return { status: 404, body: { error: "Session not found" } };

  // Interrupt any active messages
  const activeMessages = db
    .prepare("SELECT id FROM messages WHERE session_id = ? AND status IN ('pending', 'streaming')")
    .all(ctx.params.id) as { id: string }[];
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

  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  if (!session) return { status: 404, body: { error: "Session not found" } };

  const rows = db
    .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
    .all(sessionId) as Record<string, unknown>[];

  const messages = rows.map((m) => {
    const events = db
      .prepare("SELECT id, event_type, data, created_at FROM message_events WHERE message_id = ? ORDER BY id")
      .all(m.id as string) as { id: number; event_type: string; data: string; created_at: string }[];

    return {
      id: m.id,
      sessionId: m.session_id,
      prompt: m.prompt,
      status: m.status,
      result: m.result,
      error: m.error,
      costUsd: m.cost_usd,
      durationMs: m.duration_ms,
      createdAt: m.created_at,
      completedAt: m.completed_at,
      events: events.map((e) => ({
        id: e.id,
        type: e.event_type,
        data: JSON.parse(e.data),
        createdAt: e.created_at,
      })),
    };
  });

  return { status: 200, body: messages };
}

function sendMessage(ctx: RouteContext) {
  const db = getDb();
  const { id: sessionId } = ctx.params;

  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
    | Record<string, unknown>
    | undefined;
  if (!session) return { status: 404, body: { error: "Session not found" } };

  if (session.status === "active") {
    return { status: 409, body: { error: "Session has an active query. Interrupt it first or wait." } };
  }

  const body = ctx.body as {
    prompt?: string;
    model?: string;
    maxTurns?: number;
    maxBudgetUsd?: number;
  };
  if (!body?.prompt) {
    return { status: 400, body: { error: "prompt is required" } };
  }

  const workspace = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(session.workspace_id as string) as
    | Record<string, unknown>
    | undefined;
  if (!workspace) return { status: 500, body: { error: "Workspace not found for session" } };

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
    cwd: workspace.cwd as string,
    agentSessionId: (session.agent_session_id as string) ?? null,
    allowedTools: workspace.allowed_tools ? JSON.parse(workspace.allowed_tools as string) : null,
    systemPrompt: (workspace.system_prompt as string) ?? null,
    permissionMode: (session.permission_mode as string) ?? (workspace.permission_mode as string),
    model: (body.model ?? session.model ?? null) as string | null,
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

  const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as
    | Record<string, unknown>
    | undefined;
  if (!message) return { status: 404, body: { error: "Message not found" } };

  const events = db
    .prepare("SELECT id, event_type, data, created_at FROM message_events WHERE message_id = ? AND id > ? ORDER BY id")
    .all(messageId, afterId) as { id: number; event_type: string; data: string; created_at: string }[];

  return {
    status: 200,
    body: {
      id: message.id,
      sessionId: message.session_id,
      prompt: message.prompt,
      status: message.status,
      result: message.result,
      error: message.error,
      costUsd: message.cost_usd,
      durationMs: message.duration_ms,
      createdAt: message.created_at,
      completedAt: message.completed_at,
      events: events.map((e) => ({
        id: e.id,
        type: e.event_type,
        data: JSON.parse(e.data),
        createdAt: e.created_at,
      })),
    },
  };
}

function interruptMessage(ctx: RouteContext) {
  const db = getDb();
  const { id: messageId } = ctx.params;

  const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as
    | Record<string, unknown>
    | undefined;
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
      message.session_id as string
    );
  }

  return { status: 200, body: { interrupted } };
}

function rowToSession(row: unknown): Record<string, unknown> {
  const r = row as Record<string, unknown>;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    agentSessionId: r.agent_session_id,
    model: r.model,
    permissionMode: r.permission_mode,
    status: r.status,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
  };
}
