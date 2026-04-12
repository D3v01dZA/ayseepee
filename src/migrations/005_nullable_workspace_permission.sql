-- Allow workspace permission_mode to be NULL (inherit from global)
-- PRAGMA foreign_keys = OFF (detected by migration runner, applied outside transaction)

CREATE TABLE workspaces_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  allowed_tools TEXT,
  system_prompt TEXT,
  permission_mode TEXT,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO workspaces_new SELECT id, name, cwd, allowed_tools, system_prompt, permission_mode, model, created_at FROM workspaces;

-- Set 'default' values to NULL so they inherit
UPDATE workspaces_new SET permission_mode = NULL WHERE permission_mode = 'default';

DROP TABLE workspaces;
ALTER TABLE workspaces_new RENAME TO workspaces;
