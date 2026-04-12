-- Add allowed_tools_mode to workspaces and sessions
-- Mode is 'override' (replace parent tools) or 'inherit' (merge with parent tools)
ALTER TABLE workspaces ADD COLUMN allowed_tools_mode TEXT NOT NULL DEFAULT 'inherit';
ALTER TABLE sessions ADD COLUMN allowed_tools_mode TEXT NOT NULL DEFAULT 'inherit';
