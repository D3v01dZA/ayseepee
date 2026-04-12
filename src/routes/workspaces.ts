import { realpath } from "node:fs/promises";
import { Router, type RouteContext } from "../router.js";
import * as Workspaces from "../data/workspaces.js";
import type { CreateWorkspaceBody, UpdateWorkspaceBody, WorkspaceRow, WorkspaceResponse } from "../types.js";

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

  const row = Workspaces.createWorkspace({
    name: body.name,
    cwd,
    allowedTools: body.allowedTools,
    systemPrompt: body.systemPrompt,
    permissionMode: body.permissionMode,
  });

  return { status: 201, body: rowToWorkspace(row) };
}

function listWorkspaces() {
  return { status: 200, body: Workspaces.listWorkspaces().map(rowToWorkspace) };
}

function getWorkspace(ctx: RouteContext) {
  const row = Workspaces.getWorkspace(ctx.params.id);
  if (!row) return { status: 404, body: { error: "Workspace not found" } };
  return { status: 200, body: rowToWorkspace(row) };
}

async function updateWorkspace(ctx: RouteContext) {
  const existing = Workspaces.getWorkspace(ctx.params.id);
  if (!existing) return { status: 404, body: { error: "Workspace not found" } };

  const body = ctx.body as UpdateWorkspaceBody | undefined;
  if (!body) return { status: 400, body: { error: "Request body required" } };

  const fields: Parameters<typeof Workspaces.updateWorkspace>[1] = {};
  let hasFields = false;

  if (body.name !== undefined) { fields.name = body.name; hasFields = true; }
  if (body.cwd !== undefined) {
    try {
      fields.cwd = await realpath(body.cwd);
      hasFields = true;
    } catch {
      return { status: 400, body: { error: `Directory not found: ${body.cwd}` } };
    }
  }
  if (body.allowedTools !== undefined) { fields.allowedTools = body.allowedTools; hasFields = true; }
  if (body.systemPrompt !== undefined) { fields.systemPrompt = body.systemPrompt; hasFields = true; }
  if (body.permissionMode !== undefined) { fields.permissionMode = body.permissionMode; hasFields = true; }

  if (!hasFields) return { status: 400, body: { error: "No fields to update" } };

  const updated = Workspaces.updateWorkspace(ctx.params.id, fields);
  return { status: 200, body: rowToWorkspace(updated) };
}

function deleteWorkspace(ctx: RouteContext) {
  const existing = Workspaces.getWorkspace(ctx.params.id);
  if (!existing) return { status: 404, body: { error: "Workspace not found" } };

  if (Workspaces.getActiveSessionCount(ctx.params.id) > 0) {
    return { status: 409, body: { error: "Workspace has active sessions" } };
  }

  Workspaces.deleteWorkspace(ctx.params.id);
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
