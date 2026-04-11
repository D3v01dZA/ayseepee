import { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

export type RouteParams = Record<string, string>;
export type QueryParams = Record<string, string>;

export interface RouteContext {
  params: RouteParams;
  query: QueryParams;
  body: unknown;
}

type Handler = (ctx: RouteContext) => Promise<RouteResponse> | RouteResponse;

export interface RouteResponse {
  status: number;
  body?: unknown;
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export class Router {
  private routes: Route[] = [];
  private staticDir: string | null = null;
  private apiKey: string = "";

  setStaticDir(dir: string) {
    this.staticDir = dir;
  }

  setApiKey(key: string) {
    this.apiKey = key;
  }

  get(path: string, handler: Handler) {
    this.add("GET", path, handler);
  }
  post(path: string, handler: Handler) {
    this.add("POST", path, handler);
  }
  patch(path: string, handler: Handler) {
    this.add("PATCH", path, handler);
  }
  delete(path: string, handler: Handler) {
    this.add("DELETE", path, handler);
  }

  private checkAuth(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      return auth.slice(7) === this.apiKey;
    }
    // Also accept ?api_key= query param (for browser convenience)
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    return url.searchParams.get("api_key") === this.apiKey;
  }

  private add(method: string, path: string, handler: Handler) {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" +
        path.replace(/:([a-zA-Z0-9_]+)/g, (_, key) => {
          keys.push(key);
          return "([^/]+)";
        }) +
        "$"
    );
    this.routes.push({ method, pattern, keys, handler });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const start = Date.now();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    if (pathname.startsWith("/api/") && !this.checkAuth(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      log(method, pathname, 401, start);
      return;
    }

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = pathname.match(route.pattern);
      if (!match) continue;

      const params: RouteParams = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1]);
      });

      const query: QueryParams = {};
      url.searchParams.forEach((value, key) => {
        query[key] = value;
      });

      let body: unknown = undefined;
      if (method === "POST" || method === "PATCH" || method === "PUT") {
        body = await parseJsonBody(req);
      }

      try {
        const result = await route.handler({ params, query, body });
        sendJson(res, result.status, result.body);
        log(method, pathname, result.status, start);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Internal server error";
        sendJson(res, 500, { error: message });
        log(method, pathname, 500, start);
      }
      return;
    }

    if (method === "GET" && this.staticDir) {
      const filePath = pathname === "/" ? "/index.html" : pathname;
      const fullPath = join(this.staticDir, filePath);
      if (!fullPath.startsWith(this.staticDir)) {
        sendJson(res, 403, { error: "Forbidden" });
        log(method, pathname, 403, start);
        return;
      }
      if (existsSync(fullPath)) {
        const ext = extname(fullPath);
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
        const content = readFileSync(fullPath);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content);
        log(method, pathname, 200, start);
        return;
      }
    }

    sendJson(res, 404, { error: "Not found" });
    log(method, pathname, 404, start);
  }
}

function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body !== undefined ? JSON.stringify(body) : undefined);
}

function log(method: string, path: string, status: number, start: number): void {
  const ms = Date.now() - start;
  const color = status < 300 ? "\x1b[32m" : status < 400 ? "\x1b[33m" : "\x1b[31m";
  const reset = "\x1b[0m";
  const time = new Date().toISOString().slice(11, 23);
  console.log(`${time} ${method.padEnd(6)} ${color}${status}${reset} ${path} ${ms}ms`);
}
