import { randomUUID } from "node:crypto";
import { query, type Options, type SDKMessage, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { getDb } from "./db.js";

const activeQueries = new Map<string, AbortController>();

export function isQueryActive(messageId: string): boolean {
  return activeQueries.has(messageId);
}

export function interruptQuery(messageId: string): boolean {
  const controller = activeQueries.get(messageId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function interruptAllQueries(): void {
  for (const controller of activeQueries.values()) {
    controller.abort();
  }
}

interface RunQueryParams {
  messageId: string;
  sessionId: string;
  prompt: string;
  cwd: string;
  agentSessionId: string | null;
  allowedTools: string[] | null;
  systemPrompt: string | null;
  permissionMode: string;
  model: string | null;
  maxTurns: number | null;
  maxBudgetUsd: number | null;
}

export function runQuery(params: RunQueryParams): void {
  const { messageId, sessionId } = params;
  const db = getDb();
  const abortController = new AbortController();
  activeQueries.set(messageId, abortController);

  db.prepare("UPDATE messages SET status = 'streaming' WHERE id = ?").run(messageId);
  db.prepare("UPDATE sessions SET status = 'active', last_active_at = datetime('now') WHERE id = ?").run(sessionId);

  const options: Options = {
    cwd: params.cwd,
    permissionMode: (params.permissionMode as Options["permissionMode"]) ?? "default",
    ...(params.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    abortController,
    persistSession: true,
  };

  if (params.allowedTools) {
    options.allowedTools = params.allowedTools;
  }
  if (params.systemPrompt) {
    options.systemPrompt = params.systemPrompt;
  }
  options.model = params.model || "sonnet";
  if (params.maxTurns) {
    options.maxTurns = params.maxTurns;
  }
  if (params.maxBudgetUsd) {
    options.maxBudgetUsd = params.maxBudgetUsd;
  }
  if (params.agentSessionId) {
    options.resume = params.agentSessionId;
  }

  const insertEvent = db.prepare(
    "INSERT INTO message_events (message_id, event_type, data) VALUES (?, ?, ?)"
  );

  // Permission handler — writes request to DB, polls until resolved by client
  if (params.permissionMode !== "bypassPermissions") {
    options.canUseTool = async (toolName, input, opts) => {
      const id = randomUUID();
      log("query:permission", messageId, { tool: toolName, title: opts.title });

      db.prepare(
        "INSERT INTO permission_requests (id, message_id, tool_name, tool_input, title, description) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(id, messageId, toolName, JSON.stringify(input), opts.title ?? null, opts.description ?? null);

      // Also store as an event so the frontend sees it
      insertEvent.run(messageId, "permission_request", JSON.stringify({
        type: "permission_request",
        id,
        tool_name: toolName,
        input,
        title: opts.title,
        description: opts.description,
        display_name: opts.displayName,
      }));

      // Poll DB until resolved or aborted
      return new Promise<PermissionResult>((resolve) => {
        const poll = setInterval(() => {
          if (opts.signal.aborted) {
            clearInterval(poll);
            resolve({ behavior: "deny", message: "Aborted" } as PermissionResult);
            return;
          }
          const row = db.prepare("SELECT status, response FROM permission_requests WHERE id = ?").get(id) as
            | { status: string; response: string | null }
            | undefined;
          if (row && row.status !== "pending") {
            clearInterval(poll);
            if (row.status === "allowed") {
              resolve({ behavior: "allow", updatedInput: input } as PermissionResult);
            } else {
              resolve({ behavior: "deny", message: row.response || "Denied by user" } as PermissionResult);
            }
          }
        }, 500);
      });
    };
  }

  const conversation = query({ prompt: params.prompt, options });

  log("query:start", messageId, { sessionId, cwd: params.cwd, resume: !!params.agentSessionId });

  (async () => {
    try {
      let eventCount = 0;
      for await (const message of conversation) {
        const eventType = getEventType(message);
        insertEvent.run(messageId, eventType, JSON.stringify(message));
        eventCount++;

        if (message.type === "system" && "subtype" in message && message.subtype === "init") {
          const initMsg = message as { session_id?: string; model?: string };
          log("query:init", messageId, { agentSessionId: initMsg.session_id, model: initMsg.model });
          if (initMsg.session_id) {
            db.prepare("UPDATE sessions SET agent_session_id = ? WHERE id = ?").run(
              initMsg.session_id,
              sessionId
            );
          }
        }

        if (message.type === "assistant") {
          const assistantMsg = message as { message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> } };
          const content = assistantMsg.message?.content ?? [];
          for (const block of content) {
            if (block.type === "text" && block.text) {
              log("query:text", messageId, { length: block.text.length, preview: block.text.slice(0, 120) });
            } else if (block.type === "tool_use") {
              log("query:tool_use", messageId, { tool: block.name, input: summarizeInput(block.input) });
            }
          }
        }

        if (message.type === "result") {
          const result = message as {
            result?: string;
            total_cost_usd?: number;
            duration_ms?: number;
            is_error?: boolean;
            subtype?: string;
            num_turns?: number;
          };
          log("query:result", messageId, {
            subtype: result.subtype,
            is_error: result.is_error,
            turns: result.num_turns,
            cost: result.total_cost_usd ? `$${result.total_cost_usd.toFixed(4)}` : undefined,
            duration: result.duration_ms ? `${(result.duration_ms / 1000).toFixed(1)}s` : undefined,
            events: eventCount,
          });
          db.prepare(
            `UPDATE messages SET
              status = 'complete',
              result = ?,
              cost_usd = ?,
              duration_ms = ?,
              completed_at = datetime('now')
            WHERE id = ?`
          ).run(
            result.result ?? null,
            result.total_cost_usd ?? null,
            result.duration_ms ?? null,
            messageId
          );
          db.prepare("UPDATE sessions SET status = 'idle', last_active_at = datetime('now') WHERE id = ?").run(
            sessionId
          );
        }
      }

      // If we finished without a result event, mark complete
      const msg = db.prepare("SELECT status FROM messages WHERE id = ?").get(messageId) as
        | { status: string }
        | undefined;
      if (msg && msg.status === "streaming") {
        log("query:done", messageId, { note: "finished without result event", events: eventCount });
        db.prepare("UPDATE messages SET status = 'complete', completed_at = datetime('now') WHERE id = ?").run(
          messageId
        );
        db.prepare("UPDATE sessions SET status = 'idle', last_active_at = datetime('now') WHERE id = ?").run(
          sessionId
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      log("query:error", messageId, { error: errorMessage });
      db.prepare("UPDATE messages SET status = 'error', error = ?, completed_at = datetime('now') WHERE id = ?").run(
        errorMessage,
        messageId
      );
      db.prepare("UPDATE sessions SET status = 'idle', last_active_at = datetime('now') WHERE id = ?").run(
        sessionId
      );
    } finally {
      activeQueries.delete(messageId);
    }
  })();
}

function getEventType(message: SDKMessage): string {
  if (message.type === "system" && "subtype" in message) {
    return `system.${(message as { subtype: string }).subtype}`;
  }
  if (message.type === "result") {
    return `result.${(message as { subtype?: string }).subtype ?? "unknown"}`;
  }
  return message.type;
}

function log(event: string, messageId: string, data: Record<string, unknown>): void {
  const time = new Date().toISOString().slice(11, 23);
  const id = messageId.slice(0, 8);
  const parts = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  console.log(`${time} \x1b[36m${event}\x1b[0m [${id}] ${parts.join(" ")}`);
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return String(input);
  const obj = input as Record<string, unknown>;
  // Show first key-value pair as a summary
  const entries = Object.entries(obj);
  if (entries.length === 0) return "{}";
  const [k, v] = entries[0];
  const val = typeof v === "string" ? (v.length > 80 ? v.slice(0, 80) + "..." : v) : JSON.stringify(v);
  return entries.length === 1 ? `${k}=${val}` : `${k}=${val} (+${entries.length - 1} more)`;
}
