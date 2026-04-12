// --- Database row types (snake_case, matching SQL schema) ---

export interface SettingsRow {
  id: number;
  model: string;
  permission_mode: string;
  allowed_tools: string | null;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  cwd: string;
  allowed_tools: string | null;
  allowed_tools_mode: "override" | "inherit";
  system_prompt: string | null;
  permission_mode: string;
  model: string | null;
  created_at: string;
}

export interface SessionRow {
  id: string;
  workspace_id: string;
  name: string | null;
  agent_session_id: string | null;
  model: string | null;
  permission_mode: string | null;
  allowed_tools: string | null;
  allowed_tools_mode: "override" | "inherit";
  status: "idle" | "active" | "error";
  created_at: string;
  last_active_at: string;
}

export interface MessageRow {
  id: string;
  session_id: string;
  prompt: string;
  status: "pending" | "streaming" | "complete" | "error";
  result: string | null;
  error: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  created_at: string;
  completed_at: string | null;
}

export interface MessageEventRow {
  id: number;
  message_id: string;
  event_type: string;
  data: string;
  created_at: string;
}

export interface PermissionRequestRow {
  id: string;
  message_id: string;
  tool_name: string;
  tool_input: string;
  title: string | null;
  description: string | null;
  status: "pending" | "allowed" | "denied";
  response: string | null;
  rule_pattern: string | null;
  rule_scope: string | null;
  created_at: string;
  resolved_at: string | null;
}

// --- API request body types ---

export interface UpdateSettingsBody {
  model?: string;
  permissionMode?: string;
  allowedTools?: string[] | null;
}

export interface CreateWorkspaceBody {
  name: string;
  cwd: string;
  allowedTools?: string[];
  allowedToolsMode?: "override" | "inherit";
  systemPrompt?: string;
  permissionMode?: string;
  model?: string;
}

export interface UpdateWorkspaceBody {
  name?: string;
  cwd?: string;
  allowedTools?: string[] | null;
  allowedToolsMode?: "override" | "inherit";
  systemPrompt?: string | null;
  permissionMode?: string;
  model?: string | null;
}

export interface CreateSessionBody {
  name?: string;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  allowedToolsMode?: "override" | "inherit";
}

export interface UpdateSessionBody {
  name?: string;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[] | null;
  allowedToolsMode?: "override" | "inherit";
}

export interface SendMessageBody {
  prompt: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

export interface ResolvePermissionBody {
  allow: boolean;
  message?: string;
  rulePattern?: string;
  addToSession?: boolean;
  addToWorkspace?: boolean;
  addToGlobal?: boolean;
}

export interface ListFilesBody {
  root: string;
  open?: string[];
  showHidden?: boolean;
}

// --- API response types ---

export interface SettingsResponse {
  model: string;
  permissionMode: string;
  allowedTools: string[] | null;
}

export interface WorkspaceResponse {
  id: string;
  name: string;
  cwd: string;
  allowedTools: string[] | null;
  allowedToolsMode: "override" | "inherit";
  systemPrompt: string | null;
  permissionMode: string;
  model: string | null;
  createdAt: string;
}

export interface SessionResponse {
  id: string;
  workspaceId: string;
  name: string | null;
  agentSessionId: string | null;
  model: string | null;
  permissionMode: string | null;
  allowedTools: string[] | null;
  allowedToolsMode: "override" | "inherit";
  status: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface MessageEventResponse {
  id: number;
  type: string;
  data: unknown;
  createdAt: string;
}

export interface MessageResponse {
  id: string;
  sessionId: string;
  prompt: string;
  status: string;
  result: string | null;
  error: string | null;
  costUsd: number | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
  events: MessageEventResponse[];
}
