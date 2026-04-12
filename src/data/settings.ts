import { getDb } from "../db.js";
import type { SettingsRow, WorkspaceRow, SessionRow } from "../types.js";

export function getSettings(): SettingsRow {
  return getDb().prepare("SELECT * FROM settings WHERE id = 1").get() as SettingsRow;
}

export function updateSettings(fields: {
  model?: string;
  permissionMode?: string;
  allowedTools?: string[] | null;
}): SettingsRow {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (fields.model !== undefined) { sets.push("model = ?"); values.push(fields.model); }
  if (fields.permissionMode !== undefined) { sets.push("permission_mode = ?"); values.push(fields.permissionMode); }
  if (fields.allowedTools !== undefined) {
    sets.push("allowed_tools = ?");
    values.push(fields.allowedTools ? JSON.stringify(fields.allowedTools) : null);
  }

  if (sets.length > 0) {
    db.prepare(`UPDATE settings SET ${sets.join(", ")} WHERE id = 1`).run(...values);
  }

  return getSettings();
}

// Resolve effective settings by cascading: session -> workspace -> global
export function resolveSettings(
  settings: SettingsRow,
  workspace: WorkspaceRow,
  session: SessionRow,
): { model: string; permissionMode: string; allowedTools: string[] | null } {
  const model = session.model || workspace.model || settings.model;
  const permissionMode = session.permission_mode || workspace.permission_mode || settings.permission_mode;

  const allowedToolsRaw = session.allowed_tools ?? workspace.allowed_tools ?? settings.allowed_tools;
  const allowedTools = allowedToolsRaw ? JSON.parse(allowedToolsRaw) : null;

  return { model, permissionMode, allowedTools };
}
