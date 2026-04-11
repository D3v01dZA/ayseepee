import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { Router, type RouteContext } from "../router.js";
import { getDb } from "../db.js";

export function registerWorkspaceRoutes(router: Router): void {
  router.post("/api/v1/workspaces", createWorkspace);
  router.get("/api/v1/workspaces", listWorkspaces);
  router.get("/api/v1/workspaces/:id", getWorkspace);
  router.patch("/api/v1/workspaces/:id", updateWorkspace);
  router.delete("/api/v1/workspaces/:id", deleteWorkspace);
}

function createWorkspace(ctx: RouteContext) {
  const body = ctx.body as {
    name?: string;
    cwd?: string;
    allowedTools?: string[];
    systemPrompt?: string;
    permissionMode?: string;
  };

  if (!body?.name || !body?.cwd) {
    return { status: 400, body: { error: "name and cwd are required" } };
  }

  let cwd: string;
  try {
    cwd = realpathSync(body.cwd);
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

  return { status: 201, body: rowToWorkspace(db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id)) };
}

function listWorkspaces() {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM workspaces ORDER BY created_at DESC").all();
  return { status: 200, body: rows.map(rowToWorkspace) };
}

function getWorkspace(ctx: RouteContext) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(ctx.params.id);
  if (!row) return { status: 404, body: { error: "Workspace not found" } };
  return { status: 200, body: rowToWorkspace(row) };
}

function updateWorkspace(ctx: RouteContext) {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(ctx.params.id);
  if (!existing) return { status: 404, body: { error: "Workspace not found" } };

  const body = ctx.body as Record<string, unknown> | undefined;
  if (!body) return { status: 400, body: { error: "Request body required" } };

  const fields: string[] = [];
  const values: unknown[] = [];

  if ("name" in body) {
    fields.push("name = ?");
    values.push(body.name);
  }
  if ("cwd" in body) {
    try {
      const resolved = realpathSync(body.cwd as string);
      fields.push("cwd = ?");
      values.push(resolved);
    } catch {
      return { status: 400, body: { error: `Directory not found: ${body.cwd}` } };
    }
  }
  if ("allowedTools" in body) {
    fields.push("allowed_tools = ?");
    values.push(body.allowedTools ? JSON.stringify(body.allowedTools) : null);
  }
  if ("systemPrompt" in body) {
    fields.push("system_prompt = ?");
    values.push(body.systemPrompt);
  }
  if ("permissionMode" in body) {
    fields.push("permission_mode = ?");
    values.push(body.permissionMode || "default");
  }

  if (fields.length === 0) {
    return { status: 400, body: { error: "No fields to update" } };
  }

  values.push(ctx.params.id);
  db.prepare(`UPDATE workspaces SET ${fields.join(", ")} WHERE id = ?`).run(...values);

  const updated = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(ctx.params.id);
  return { status: 200, body: rowToWorkspace(updated) };
}

function deleteWorkspace(ctx: RouteContext) {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(ctx.params.id);
  if (!existing) return { status: 404, body: { error: "Workspace not found" } };

  const activeSessions = db
    .prepare("SELECT COUNT(*) as count FROM sessions WHERE workspace_id = ? AND status = 'active'")
    .get(ctx.params.id) as { count: number };

  if (activeSessions.count > 0) {
    return { status: 409, body: { error: "Workspace has active sessions" } };
  }

  db.prepare("DELETE FROM sessions WHERE workspace_id = ?").run(ctx.params.id);
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(ctx.params.id);
  return { status: 204 };
}

function rowToWorkspace(row: unknown): Record<string, unknown> {
  const r = row as Record<string, unknown>;
  return {
    id: r.id,
    name: r.name,
    cwd: r.cwd,
    allowedTools: r.allowed_tools ? JSON.parse(r.allowed_tools as string) : null,
    systemPrompt: r.system_prompt,
    permissionMode: r.permission_mode,
    createdAt: r.created_at,
  };
}
