import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { Router, type RouteContext } from "../router.js";
import { getDb } from "../db.js";
import type { WorkspaceRow, CreateWorkspaceBody, UpdateWorkspaceBody, WorkspaceResponse } from "../types.js";

export function registerWorkspaceRoutes(router: Router): void {
  router.post("/api/v1/workspaces", createWorkspace);
  router.get("/api/v1/workspaces", listWorkspaces);
  router.get("/api/v1/workspaces/:id", getWorkspace);
  router.patch("/api/v1/workspaces/:id", updateWorkspace);
  router.delete("/api/v1/workspaces/:id", deleteWorkspace);
}

async function createWorkspace(ctx: RouteContext) {
  const body = ctx.body as Partial<CreateWorkspaceBody> | undefined;

  if (!body?.name || !body?.cwd) {
    return { status: 400, body: { error: "name and cwd are required" } };
  }

  let cwd: string;
  try {
    cwd = await realpath(body.cwd);
  } catch {
    return { status: 400, body: { error: `Directory not found: ${body.cwd}` } };
  }

  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO workspaces (id, name, cwd, allowed_tools, system_prompt, permission_mode)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    body.name,
    cwd,
    body.allowedTools ? JSON.stringify(body.allowedTools) : null,
    body.systemPrompt ?? null,
    body.permissionMode ?? "default"
  );

  return { status: 201, body: rowToWorkspace(db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow) };
}

function listWorkspaces() {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM workspaces ORDER BY created_at DESC").all() as WorkspaceRow[];
  return { status: 200, body: rows.map(rowToWorkspace) };
}

function getWorkspace(ctx: RouteContext) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(ctx.params.id) as WorkspaceRow | undefined;
  if (!row) return { status: 404, body: { error: "Workspace not found" } };
  return { status: 200, body: rowToWorkspace(row) };
}

async function updateWorkspace(ctx: RouteContext) {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(ctx.params.id) as WorkspaceRow | undefined;
  if (!existing) return { status: 404, body: { error: "Workspace not found" } };

  const body = ctx.body as UpdateWorkspaceBody | undefined;
  if (!body) return { status: 400, body: { error: "Request body required" } };

  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) {
    fields.push("name = ?");
    values.push(body.name);
  }
  if (body.cwd !== undefined) {
    try {
      const resolved = await realpath(body.cwd);
      fields.push("cwd = ?");
      values.push(resolved);
    } catch {
      return { status: 400, body: { error: `Directory not found: ${body.cwd}` } };
    }
  }
  if (body.allowedTools !== undefined) {
    fields.push("allowed_tools = ?");
    values.push(body.allowedTools ? JSON.stringify(body.allowedTools) : null);
  }
  if (body.systemPrompt !== undefined) {
    fields.push("system_prompt = ?");
    values.push(body.systemPrompt ?? null);
  }
  if (body.permissionMode !== undefined) {
    fields.push("permission_mode = ?");
    values.push(body.permissionMode || "default");
  }

  if (fields.length === 0) {
    return { status: 400, body: { error: "No fields to update" } };
  }

  values.push(ctx.params.id);
  db.prepare(`UPDATE workspaces SET ${fields.join(", ")} WHERE id = ?`).run(...values);

  const updated = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(ctx.params.id) as WorkspaceRow;
  return { status: 200, body: rowToWorkspace(updated) };
}

function deleteWorkspace(ctx: RouteContext) {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(ctx.params.id) as WorkspaceRow | undefined;
  if (!existing) return { status: 404, body: { error: "Workspace not found" } };

  const { count: activeCount } = db
    .prepare("SELECT COUNT(*) as count FROM sessions WHERE workspace_id = ? AND status = 'active'")
    .get(ctx.params.id) as { count: number };

  if (activeCount > 0) {
    return { status: 409, body: { error: "Workspace has active sessions" } };
  }

  db.prepare("DELETE FROM sessions WHERE workspace_id = ?").run(ctx.params.id);
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(ctx.params.id);
  return { status: 204 };
}

function rowToWorkspace(row: WorkspaceRow): WorkspaceResponse {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    allowedTools: row.allowed_tools ? JSON.parse(row.allowed_tools) : null,
    systemPrompt: row.system_prompt,
    permissionMode: row.permission_mode,
    createdAt: row.created_at,
  };
}
