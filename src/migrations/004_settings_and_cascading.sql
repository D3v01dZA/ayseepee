-- Global settings (single row)
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  model TEXT NOT NULL DEFAULT 'sonnet',
  permission_mode TEXT NOT NULL DEFAULT 'default',
  allowed_tools TEXT
);
INSERT INTO settings (id) VALUES (1);

-- Workspaces can now override model
ALTER TABLE workspaces ADD COLUMN model TEXT;

-- Sessions can now override allowed_tools
ALTER TABLE sessions ADD COLUMN allowed_tools TEXT;
