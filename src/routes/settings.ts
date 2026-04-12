import { Router, type RouteContext } from "../router.js";
import * as Settings from "../data/settings.js";
import type { UpdateSettingsBody, SettingsResponse } from "../types.js";

export function registerSettingsRoutes(router: Router): void {
  router.get("/api/v1/settings", getSettings);
  router.patch("/api/v1/settings", updateSettings);
}

function getSettings() {
  return { status: 200, body: rowToResponse(Settings.getSettings()) };
}

function updateSettings(ctx: RouteContext) {
  const body = ctx.body as UpdateSettingsBody | undefined;
  if (!body) return { status: 400, body: { error: "Request body required" } };

  const updated = Settings.updateSettings({
    model: body.model,
    permissionMode: body.permissionMode,
    allowedTools: body.allowedTools,
  });

  return { status: 200, body: rowToResponse(updated) };
}

function rowToResponse(row: import("../types.js").SettingsRow): SettingsResponse {
  return {
    model: row.model,
    permissionMode: row.permission_mode,
    allowedTools: row.allowed_tools ? JSON.parse(row.allowed_tools) : null,
  };
}
