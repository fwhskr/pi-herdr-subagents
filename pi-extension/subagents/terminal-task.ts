import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TASK-458: a lane whose Backlog task is already terminal must not be resumed
 * into re-running its gate. The lane's task identity is the `Task name: TASK-N`
 * header of its spawn brief (the delegation convention); its state is the
 * `status:` of that task's Backlog file in the lane's project (or the resuming
 * session's). Anything unreadable or unnamed is treated as open, so a lane is
 * refused only on positive evidence of a terminal task.
 * ponytail: "Done" or a file under backlog/completed is terminal; widen the set
 * if a board configures another final status.
 */
export interface TerminalTask {
  taskId: string;
  status: string;
}

const TASK_NAME = /^Task name:\s*(TASK-\d+(?:\.\d+)*)/im;

function readJson(path: string): Record<string, any> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Brief and cwd of a lane session: spawn sidecar task, else its first user message; header cwd. */
function sessionBrief(sessionFile: string): { brief?: string; cwd?: string } {
  const spawnTask = readJson(`${sessionFile}.spawn.json`)?.task;
  let cwd: string | undefined;
  let firstUser: string | undefined;
  try {
    for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type === "session" && typeof entry.cwd === "string") cwd ??= entry.cwd;
      if (typeof spawnTask !== "string" && entry?.type === "message" && entry.message?.role === "user") {
        const content = entry.message.content;
        firstUser = typeof content === "string"
          ? content
          : Array.isArray(content) ? content.map((part: any) => part?.text ?? "").join("\n") : undefined;
      }
      if (cwd && (typeof spawnTask === "string" || firstUser)) break;
    }
  } catch {
    // An unreadable session names no task.
  }
  return { brief: typeof spawnTask === "string" ? spawnTask : firstUser, cwd };
}

function backlogStatus(root: string, taskId: string): TerminalTask["status"] | undefined {
  const prefix = taskId.toLowerCase();
  for (const dir of ["tasks", "completed"]) {
    const path = join(root, "backlog", dir);
    if (!existsSync(path)) continue;
    let names: string[];
    try { names = readdirSync(path); } catch { continue; }
    const name = names.find((n) => n.toLowerCase().startsWith(`${prefix} `) || n.toLowerCase() === `${prefix}.md`);
    if (!name) continue;
    let status: string | undefined;
    try {
      status = /^status:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(readFileSync(join(path, name), "utf8"))?.[1];
    } catch {
      continue;
    }
    const trimmed = status?.trim();
    if (dir === "completed") return trimmed || "Done"; // completed/ is terminal by location
    return trimmed?.toLowerCase() === "done" ? trimmed : undefined;
  }
  return undefined;
}

/** The terminal Backlog task a lane session belongs to, or undefined when open/unknown. */
export function terminalTaskOfSession(sessionFile: string, extraRoots: readonly string[] = []): TerminalTask | undefined {
  const { brief, cwd } = sessionBrief(sessionFile);
  const taskId = brief ? TASK_NAME.exec(brief)?.[1]?.toUpperCase() : undefined;
  if (!taskId) return undefined;
  for (const root of new Set([cwd, ...extraRoots].filter((r): r is string => Boolean(r)))) {
    const status = backlogStatus(root, taskId);
    if (status) return { taskId, status };
  }
  return undefined;
}

export function formatTerminalTask(task: TerminalTask): string {
  return `Its Backlog task ${task.taskId} is already terminal (status: ${task.status})`;
}
