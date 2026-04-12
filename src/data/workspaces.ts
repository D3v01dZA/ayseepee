import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import type { WorkspaceRow } from "../types.js";

export function getWorkspace(id: string): WorkspaceRow | undefined {
  return getDb().prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined;
}

export function listWorkspaces(): WorkspaceRow[] {
  return getDb().prepare("SELECT * FROM workspaces ORDER BY created_at DESC").all() as WorkspaceRow[];
}

export function createWorkspace(params: {
  name: string;
  cwd: string;
  allowedTools?: string[];
  allowedToolsMode?: "override" | "inherit";
  systemPrompt?: string;
  permissionMode?: string;
  model?: string;
}): WorkspaceRow {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO workspaces (id, name, cwd, allowed_tools, allowed_tools_mode, system_prompt, permission_mode, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.name,
    params.cwd,
    params.allowedTools ? JSON.stringify(params.allowedTools) : null,
    params.allowedToolsMode ?? "inherit",
    params.systemPrompt ?? null,
    params.permissionMode ?? null,
    params.model ?? null,
  );
  return db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow;
}

export function updateWorkspace(id: string, fields: {
  name?: string;
  cwd?: string;
  allowedTools?: string[] | null;
  allowedToolsMode?: "override" | "inherit";
  systemPrompt?: string | null;
  permissionMode?: string;
  model?: string | null;
}): WorkspaceRow {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (fields.name !== undefined) { sets.push("name = ?"); values.push(fields.name); }
  if (fields.cwd !== undefined) { sets.push("cwd = ?"); values.push(fields.cwd); }
  if (fields.allowedTools !== undefined) {
    sets.push("allowed_tools = ?");
    values.push(fields.allowedTools ? JSON.stringify(fields.allowedTools) : null);
  }
  if (fields.allowedToolsMode !== undefined) { sets.push("allowed_tools_mode = ?"); values.push(fields.allowedToolsMode); }
  if (fields.systemPrompt !== undefined) { sets.push("system_prompt = ?"); values.push(fields.systemPrompt ?? null); }
  if (fields.permissionMode !== undefined) { sets.push("permission_mode = ?"); values.push(fields.permissionMode || null); }
  if (fields.model !== undefined) { sets.push("model = ?"); values.push(fields.model || null); }

  values.push(id);
  db.prepare(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow;
}

export function deleteWorkspace(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM permission_requests WHERE message_id IN (SELECT id FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?))").run(id);
  db.prepare("DELETE FROM message_events WHERE message_id IN (SELECT id FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?))").run(id);
  db.prepare("DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?)").run(id);
  db.prepare("DELETE FROM sessions WHERE workspace_id = ?").run(id);
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
}

export function getActiveSessionCount(workspaceId: string): number {
  const { count } = getDb()
    .prepare("SELECT COUNT(*) as count FROM sessions WHERE workspace_id = ? AND status = 'active'")
    .get(workspaceId) as { count: number };
  return count;
}
