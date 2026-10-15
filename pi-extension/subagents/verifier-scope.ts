import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const BASE = "/home/kris/.pi/agent/var/verifier-scope";
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
export const VERIFIER_TOOLS = "read,grep,find,ls,verify_run,caller_ping,subagent_done";
export const VERIFIER_EXCLUSIONS = "mcp__*,bash,write,edit,codemode,tool_search,mcp,lazy_load_tools,ctx_*,jev_*,agent_message,subagent,subagent_resume,subagent_interrupt,subagents_list";
export interface VerifierScopeBinding { auth_id: string; error?: string }
export interface VerifierScopeMetadata { verifierScope?: VerifierScopeBinding }
type Authorization = { schema: 1; auth_id: string; candidate: { repo_realpath: string; commit_sha: string }; entries: unknown[] };
function demand(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]): void { demand(Object.keys(value).every(k => allowed.includes(k)), "Unknown authorization field"); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 128 && value.every(v => typeof v === "string" && !v.includes("\0")); }
// Structural schema only: the existing runner owns filesystem/jail validation.
function validate(value: unknown): asserts value is Authorization {
  demand(object(value), "Invalid authorization"); keys(value, ["schema", "auth_id", "candidate", "entries"]);
  demand(value.schema === 1 && typeof value.auth_id === "string" && ID.test(value.auth_id), "Invalid authorization identity");
  demand(object(value.candidate), "Invalid candidate"); keys(value.candidate, ["repo_realpath", "commit_sha"]);
  demand(typeof value.candidate.repo_realpath === "string" && typeof value.candidate.commit_sha === "string" && /^[a-f0-9]{40,64}$/.test(value.candidate.commit_sha), "Invalid candidate");
  demand(Array.isArray(value.entries) && value.entries.length <= 64, "Invalid entries");
  const ids = new Set<string>();
  for (const e of value.entries) {
    demand(object(e), "Invalid entry");
    keys(e, ["id", "cwd_realpath", "argv", "selector", "inputs", "runtime_roots", "read_roots", "write_roots", "env", "timeout_s", "max_output_bytes", "max_attempts", "retry_on_failure", "network", "runner_self_test"]);
    demand(typeof e.id === "string" && ID.test(e.id) && !ids.has(e.id), "Invalid/duplicate entry id"); ids.add(e.id);
    demand(typeof e.cwd_realpath === "string" && strings(e.argv) && e.argv.length > 0 && e.argv[0].startsWith("/"), "Invalid command");
    demand(typeof e.selector === "string" && strings(e.inputs) && strings(e.read_roots) && strings(e.write_roots) && (e.runtime_roots === undefined || strings(e.runtime_roots)), "Invalid roots or selector");
    demand(e.max_attempts === 1 && e.retry_on_failure === false && e.network === false, "Only once, no-retry, offline entries are supported");
    demand(Number.isInteger(e.timeout_s) && Number(e.timeout_s) >= 1 && Number(e.timeout_s) <= 60, "Invalid timeout (1..60 seconds)");
    demand(e.max_output_bytes === undefined || (Number.isInteger(e.max_output_bytes) && Number(e.max_output_bytes) >= 1 && Number(e.max_output_bytes) <= 1048576), "Invalid output cap");
    demand(object(e.env) && Object.entries(e.env).every(([k, v]) => /^[A-Z_][A-Z0-9_]*$/.test(k) && typeof v === "string" && !v.includes("\0")), "Invalid environment");
    demand(!Object.keys(e.env).some(k => /TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|SSH|DBUS|DISPLAY|WAYLAND/.test(k) || ["HOME", "TMPDIR", "TMP", "TEMP", "XDG_RUNTIME_DIR"].includes(k)), "Credential/session environment is not permitted");
    demand(e.runner_self_test === undefined || (object(e.runner_self_test) && Object.values(e.runner_self_test).every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))), "Invalid self-test pins");
  }
}
function publish(auth: Authorization): void {
  const root = join(BASE, auth.auth_id);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  demand(realpathSync(root) === root && lstatSync(root).isDirectory(), "Noncanonical authorization directory");
  const file = join(root, "authorization.json");
  const text = JSON.stringify(auth);
  let fd: number;
  try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      demand(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o444 && readFileSync(fd, "utf8") === text, "Authorization id already bound to a different or mutable record");
    } finally { closeSync(fd); }
    return;
  }
  try { writeFileSync(fd, text); fchmodSync(fd, 0o444); } finally { closeSync(fd); }
}
/** No fence is a strict no-op. Malformed scopes still launch, with zero entries. */
export function bindVerifierScope(task: string, sessionFile: string): VerifierScopeBinding | undefined {
  if (!/^\s*```verifier-scope\b/m.test(task)) return undefined;
  const fallbackId = `invalid-${createHash("sha256").update(sessionFile).digest("hex").slice(0, 48)}`;
  let error: string;
  try {
    const fences = [...task.matchAll(/^\s*```verifier-scope[^\S\r\n]*\r?\n([\s\S]*?)^\s*```[^\S\r\n]*$/gm)];
    demand(fences.length === 1 && [...task.matchAll(/^\s*```verifier-scope\b/gm)].length === 1, "Expected one complete verifier-scope JSON fence");
    const auth: unknown = JSON.parse(fences[0][1]); validate(auth); publish(auth);
    return { auth_id: auth.auth_id };
  } catch (cause) { error = cause instanceof Error ? cause.message : "Invalid verifier scope"; }
  try { publish({ schema: 1, auth_id: fallbackId, candidate: { repo_realpath: "/home/kris/.pi", commit_sha: "0".repeat(40) }, entries: [] }); }
  catch (cause) {
    error += `; empty authorization unavailable: ${cause instanceof Error ? cause.message : String(cause)}`;
    // An invalid marker is deliberately non-runnable in the existing runner;
    // never bind a malformed request to a conflicting record's entries.
    return { auth_id: `unavailable!${fallbackId}`, error };
  }
  return { auth_id: fallbackId, error };
}
/** Resume reuses only the original binding, never a follow-up's scope fence. */
export function resumeVerifierScope(metadata: VerifierScopeMetadata & { task?: string } | null, sessionFile: string): VerifierScopeBinding | undefined {
  if (metadata?.verifierScope) {
    const scope = metadata.verifierScope;
    if (typeof scope.auth_id === "string" && (ID.test(scope.auth_id) || /^unavailable!invalid-[a-f0-9]{48}$/.test(scope.auth_id))) return scope;
    return bindVerifierScope("```verifier-scope\ninvalid\n```", sessionFile);
  }
  return metadata?.task ? bindVerifierScope(metadata.task, sessionFile) : undefined;
}
