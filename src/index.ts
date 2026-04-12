import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "./router.js";
import { initDb } from "./db.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerViewRoutes } from "./routes/views.js";
import { interruptAllQueries } from "./agent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOSTNAME = process.env.HOSTNAME ?? "127.0.0.1";
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const DB_PATH = process.env.DB_PATH ?? "ayseepee.db";
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error("API_KEY environment variable is required");
  process.exit(1);
}

initDb(DB_PATH);

const router = new Router();
router.setApiKey(API_KEY);
router.setStaticDir(join(__dirname, "..", "public"));
registerWorkspaceRoutes(router);
registerSessionRoutes(router);
registerFileRoutes(router);
registerSettingsRoutes(router);
registerViewRoutes(router);

const server = createServer((req, res) => {
  router.handle(req, res);
});

server.listen(PORT, HOSTNAME, () => {
  console.log(`ayseepee listening on http://${HOSTNAME}:${PORT}`);
});

function shutdown() {
  console.log("\nShutting down...");
  interruptAllQueries();
  server.close(() => {
    process.exit(0);
  });
  // Force exit after 5s if graceful shutdown hangs
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
