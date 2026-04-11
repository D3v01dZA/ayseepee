import { readdir, stat, realpath } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { Router, type RouteContext } from "../router.js";

export function registerFileRoutes(router: Router): void {
  router.post("/api/v1/files/list", listFiles);
}

interface FileEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number | null;
}

async function listFiles(ctx: RouteContext) {
  const body = ctx.body as {
    root?: string;
    open?: string[];
    showHidden?: boolean;
  };

  if (!body?.root) {
    return { status: 400, body: { error: "root is required" } };
  }

  let root: string;
  try {
    root = await realpath(resolve(body.root));
  } catch {
    return { status: 400, body: { error: `Directory not found: ${body.root}` } };
  }

  const showHidden = body.showHidden ?? false;
  const dirs = [".", ...(body.open ?? [])];
  const result: Record<string, FileEntry[]> = {};

  for (const dir of dirs) {
    const abs = resolve(root, dir);

    // Prevent traversal outside root
    const rel = relative(root, abs);
    if (rel.startsWith("..") || resolve(root, rel) !== abs) {
      continue;
    }

    try {
      let entries = await readdir(abs, { withFileTypes: true });
      if (!showHidden) {
        entries = entries.filter((e) => !e.name.startsWith("."));
      }

      const fileEntries: FileEntry[] = await Promise.all(
        entries.map(async (e): Promise<FileEntry> => {
          let size: number | null = null;
          let type: FileEntry["type"] = "other";

          try {
            // stat follows symlinks, so this resolves the target type
            const s = await stat(join(abs, e.name));
            if (s.isDirectory()) {
              type = "directory";
            } else if (s.isFile()) {
              type = "file";
              size = s.size;
            }
          } catch {
            // broken symlink, permission denied, etc
          }

          return { name: e.name, type, size };
        })
      );

      result[dir === "." ? "/" : "/" + rel] = fileEntries.sort((a, b) => {
        // directories first, then alphabetical
        if (a.type === "directory" && b.type !== "directory") return -1;
        if (a.type !== "directory" && b.type === "directory") return 1;
        return a.name.localeCompare(b.name);
      });
    } catch {
      // directory doesn't exist or can't be read — skip it
    }
  }

  return { status: 200, body: { root, entries: result } };
}
