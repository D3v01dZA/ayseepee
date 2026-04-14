import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

export function initDb(dbPath: string = "ayseepee.db"): Database.Database {
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  cleanupStaleQueries(db);
  return db;
}

function cleanupStaleQueries(db: Database.Database): void {
  const stale = db.prepare(
    "UPDATE messages SET status = 'error', error = 'interrupted', completed_at = datetime('now') WHERE status IN ('pending', 'streaming')"
  ).run();
  db.prepare(
    "UPDATE sessions SET status = 'idle', last_active_at = datetime('now') WHERE status = 'active'"
  ).run();
  if (stale.changes > 0) {
    console.log(`Cleaned up ${stale.changes} stale message(s) from previous run`);
  }
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const current = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as
    | { v: number | null }
    | undefined;
  const currentVersion = current?.v ?? 0;

  const migrationsDir = join(__dirname, "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = parseInt(file.split("_")[0], 10);
    if (version <= currentVersion) continue;

    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    const needsFkOff = sql.includes("PRAGMA foreign_keys = OFF");
    if (needsFkOff) db.pragma("foreign_keys = OFF");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
    })();
    if (needsFkOff) db.pragma("foreign_keys = ON");

    console.log(`Applied migration ${file}`);
  }
}
