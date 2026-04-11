import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "./router.js";
import { initDb } from "./db.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { interruptAllQueries } from "./agent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const DB_PATH = process.env.DB_PATH ?? "ayseepee.db";

initDb(DB_PATH);

const router = new Router();
router.setStaticDir(join(__dirname, "..", "public"));
registerWorkspaceRoutes(router);
registerSessionRoutes(router);

const server = createServer((req, res) => {
  router.handle(req, res);
});

server.listen(PORT, () => {
  console.log(`ayseepee listening on http://localhost:${PORT}`);
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
