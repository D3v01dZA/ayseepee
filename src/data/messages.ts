import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import type { MessageRow, MessageEventRow, PermissionRequestRow } from "../types.js";

export function getMessage(id: string): MessageRow | undefined {
  return getDb().prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
}

export function listMessages(sessionId: string): MessageRow[] {
  return getDb()
    .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
    .all(sessionId) as MessageRow[];
}

export function createMessage(sessionId: string, prompt: string): MessageRow {
  const db = getDb();
  const id = randomUUID();
  db.prepare("INSERT INTO messages (id, session_id, prompt) VALUES (?, ?, ?)").run(id, sessionId, prompt);
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow;
}

export function getMessageEvents(messageId: string, afterId = 0): MessageEventRow[] {
  return getDb()
    .prepare("SELECT id, event_type, data, created_at FROM message_events WHERE message_id = ? AND id > ? ORDER BY id")
    .all(messageId, afterId) as MessageEventRow[];
}

export function getAllMessageEvents(messageId: string): MessageEventRow[] {
  return getDb()
    .prepare("SELECT * FROM message_events WHERE message_id = ? ORDER BY id")
    .all(messageId) as MessageEventRow[];
}

export function interruptMessage(messageId: string): void {
  const db = getDb();
  const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRow;
  db.prepare(
    "UPDATE messages SET status = 'error', error = 'interrupted', completed_at = datetime('now') WHERE id = ?"
  ).run(messageId);
  db.prepare(
    "UPDATE sessions SET status = 'idle', last_active_at = datetime('now') WHERE id = ?"
  ).run(message.session_id);
}

// --- Permissions ---

export function getPermission(id: string): PermissionRequestRow | undefined {
  return getDb().prepare("SELECT * FROM permission_requests WHERE id = ?").get(id) as PermissionRequestRow | undefined;
}

export function getPermissionStatus(id: string): string | undefined {
  const row = getDb().prepare("SELECT status FROM permission_requests WHERE id = ?").get(id) as
    Pick<PermissionRequestRow, "status"> | undefined;
  return row?.status;
}

export function resolvePermission(id: string, allow: boolean, message?: string): PermissionRequestRow {
  const db = getDb();
  db.prepare(
    "UPDATE permission_requests SET status = ?, response = ?, resolved_at = datetime('now') WHERE id = ?"
  ).run(allow ? "allowed" : "denied", message ?? null, id);
  return db.prepare("SELECT * FROM permission_requests WHERE id = ?").get(id) as PermissionRequestRow;
}
