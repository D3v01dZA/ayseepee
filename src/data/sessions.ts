import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import type { SessionRow } from "../types.js";

export function getSession(id: string): SessionRow | undefined {
  return getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
}

export function listSessions(workspaceId: string): SessionRow[] {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY last_active_at DESC")
    .all(workspaceId) as SessionRow[];
}

export function createSession(workspaceId: string, params: {
  name?: string;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  allowedToolsMode?: "override" | "inherit";
}): SessionRow {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    "INSERT INTO sessions (id, workspace_id, name, model, permission_mode, allowed_tools, allowed_tools_mode) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, workspaceId, params.name ?? null, params.model ?? null, params.permissionMode ?? null, params.allowedTools ? JSON.stringify(params.allowedTools) : null, params.allowedToolsMode ?? "inherit");
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow;
}

export function updateSession(id: string, fields: {
  name?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  allowedTools?: string[] | null;
  allowedToolsMode?: "override" | "inherit";
}): SessionRow {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (fields.name !== undefined) { sets.push("name = ?"); values.push(fields.name ?? null); }
  if (fields.model !== undefined) { sets.push("model = ?"); values.push(fields.model || null); }
  if (fields.permissionMode !== undefined) { sets.push("permission_mode = ?"); values.push(fields.permissionMode || null); }
  if (fields.allowedTools !== undefined) {
    sets.push("allowed_tools = ?");
    values.push(fields.allowedTools ? JSON.stringify(fields.allowedTools) : null);
  }
  if (fields.allowedToolsMode !== undefined) { sets.push("allowed_tools_mode = ?"); values.push(fields.allowedToolsMode); }

  if (sets.length > 0) {
    values.push(id);
    db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow;
}

export function deleteSession(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM permission_requests WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)").run(id);
  db.prepare("DELETE FROM message_events WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)").run(id);
  db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function autoNameSession(id: string, prompt: string): void {
  const name = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
  getDb().prepare("UPDATE sessions SET name = ? WHERE id = ?").run(name, id);
}

export function getMostRecentlyActive(): SessionRow | undefined {
  return getDb()
    .prepare("SELECT * FROM sessions ORDER BY last_active_at DESC LIMIT 1")
    .get() as SessionRow | undefined;
}

export function getActiveMessageIds(sessionId: string): string[] {
  const rows = getDb()
    .prepare("SELECT id FROM messages WHERE session_id = ? AND status IN ('pending', 'streaming')")
    .all(sessionId) as Pick<import("../types.js").MessageRow, "id">[];
  return rows.map(r => r.id);
}
