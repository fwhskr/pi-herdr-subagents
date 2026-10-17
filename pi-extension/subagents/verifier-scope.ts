import { constants, closeSync, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";

const BASE = "/home/kris/.pi/agent/var/verifier-scope";
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
export const VERIFIER_TOOLS = "read,grep,find,ls,verify_run,caller_ping,subagent_done";
export const VERIFIER_EXCLUSIONS = "mcp__*,bash,write,edit,codemode,tool_search,mcp,lazy_load_tools,ctx_*,jev_*,agent_message,subagent,subagent_resume,subagent_interrupt,subagents_list";
export interface VerifierScopeBinding { auth_id: string; error?: string }
export interface VerifierScopeMetadata { verifierScope?: VerifierScopeBinding }
type Authorization = { schema: 1; auth_id: string; candidate: { repo_realpath: string; commit_sha: string }; entries: unknown[] };
type EngineRequest = { engine_pins: Record<string, string>; input_pins: Record<string, string> };
type RealEngine = EngineRequest & { storage_root: string; binding: string };
// Validated entry shape (validate() checks every field); other fields are carried through verbatim.
type Entry = {
  id: string; cwd_realpath: string; argv: string[]; selector: string; inputs: string[]; runtime_roots?: string[];
  read_roots: string[]; write_roots: string[]; env: Record<string, string>; timeout_s: number; max_output_bytes?: number;
  real_engine?: EngineRequest | RealEngine;
};
const sha = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const inside = (p: string, root: string): boolean => p === root || p.startsWith(root + "/");
function pins(value: unknown): value is Record<string, string> {
  return object(value) && Object.keys(value).length >= 1 && Object.keys(value).length <= 32
    && Object.entries(value).every(([k, v]) => isAbsolute(k) && normalize(k) === k && typeof v === "string" && /^[a-f0-9]{64}$/.test(v));
}
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
    keys(e, ["id", "cwd_realpath", "argv", "selector", "inputs", "runtime_roots", "read_roots", "write_roots", "env", "timeout_s", "max_output_bytes", "max_attempts", "retry_on_failure", "network", "runner_self_test", "real_engine"]);
    demand(typeof e.id === "string" && ID.test(e.id) && !ids.has(e.id), "Invalid/duplicate entry id"); ids.add(e.id);
    demand(typeof e.cwd_realpath === "string" && strings(e.argv) && e.argv.length > 0 && e.argv[0].startsWith("/"), "Invalid command");
    demand(typeof e.selector === "string" && strings(e.inputs) && strings(e.read_roots) && strings(e.write_roots) && (e.runtime_roots === undefined || strings(e.runtime_roots)), "Invalid roots or selector");
    demand(e.max_attempts === 1 && e.retry_on_failure === false && e.network === false, "Only once, no-retry, offline entries are supported");
    demand(Number.isInteger(e.timeout_s) && Number(e.timeout_s) >= 1 && Number(e.timeout_s) <= 60, "Invalid timeout (1..60 seconds)");
    demand(e.max_output_bytes === undefined || (Number.isInteger(e.max_output_bytes) && Number(e.max_output_bytes) >= 1 && Number(e.max_output_bytes) <= 1048576), "Invalid output cap");
    demand(object(e.env) && Object.entries(e.env).every(([k, v]) => /^[A-Z_][A-Z0-9_]*$/.test(k) && typeof v === "string" && !v.includes("\0")), "Invalid environment");
    demand(!Object.keys(e.env).some(k => /TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|SSH|DBUS|DISPLAY|WAYLAND/.test(k) || ["HOME", "TMPDIR", "TMP", "TEMP", "XDG_RUNTIME_DIR"].includes(k)), "Credential/session environment is not permitted");
    demand(e.runner_self_test === undefined || (object(e.runner_self_test) && Object.values(e.runner_self_test).every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))), "Invalid self-test pins");
    if (e.real_engine !== undefined) {
      const r = e.real_engine;
      demand(object(r) && e.runner_self_test === undefined, "Invalid real-engine request");
      // storage_root and binding are launcher-authored; a caller-supplied value is refused, never trusted.
      demand(!("storage_root" in r) && !("binding" in r), "Real-engine storage_root/binding are launcher-authored");
      keys(r, ["engine_pins", "input_pins"]);
      demand(pins(r.engine_pins) && pins(r.input_pins), "Invalid real-engine pins");
    }
  }
}
// Engine configuration seen inside the jail: /etc and HOME config are absent there, so only the
// /usr/share drop-ins documented in containers.conf(5) apply. Unresolvable overrides are refused.
const SHARE = "/usr/share/containers";
const CONMON = ["/usr/libexec/podman/conmon", "/usr/local/libexec/podman/conmon", "/usr/local/lib/podman/conmon", "/usr/bin/conmon", "/usr/sbin/conmon", "/usr/local/bin/conmon", "/usr/local/sbin/conmon", "/run/current-system/sw/bin/conmon"];
const RUNTIMES: Record<string, string[]> = {
  crun: ["/usr/bin/crun", "/usr/sbin/crun", "/usr/local/bin/crun", "/usr/local/sbin/crun", "/sbin/crun", "/bin/crun", "/run/current-system/sw/bin/crun"],
  runc: ["/usr/bin/runc", "/usr/sbin/runc", "/usr/local/bin/runc", "/usr/local/sbin/runc", "/sbin/runc", "/bin/runc", "/usr/lib/cri-o-runc/sbin/runc"],
};
function engineRuntime(): string | undefined {
  const dropins = new Map<string, string>();
  for (const dir of [`${SHARE}/containers.rootless.conf.d/${process.getuid!()}`, `${SHARE}/containers.rootless.conf.d`, `${SHARE}/containers.conf.d`]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) if (name.endsWith(".conf") && !dropins.has(name)) dropins.set(name, join(dir, name));
  }
  let runtime: string | undefined;
  for (const file of [`${SHARE}/containers.conf`, ...[...dropins.keys()].sort().map(n => dropins.get(n)!)]) {
    if (!existsSync(file)) continue;
    let table = "";
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.replace(/^\s+|\s+$/g, "");
      if (!line || line.startsWith("#")) continue;
      const header = /^\[([^\]]+)\]/.exec(line);
      if (header) { table = header[1].trim(); continue; }
      demand(table !== "engine.runtimes" && !(table === "engine" && /^conmon_path\s*=/.test(line)), `Unsupported engine runtime/conmon override in ${file}`);
      const value = table === "engine" ? /^runtime\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line) : null;
      if (value) runtime = value[1] || undefined;
      else demand(!(table === "engine" && /^runtime\s*=/.test(line)), `Unsupported engine runtime value in ${file}`);
    }
  }
  return runtime;
}
function firstReal(candidates: string[], what: string): string {
  const found = candidates.find(p => existsSync(p));
  demand(found, `No ${what} executable is installed`);
  const real = realpathSync(found);
  demand(inside(real, "/usr"), `The ${what} executable is outside /usr and unavailable in the jail`);
  return real;
}
/** The exact rootless engine executables Podman resolves inside the jail: podman, its OCI runtime and conmon. */
export function requiredEnginePins(): string[] {
  const name = engineRuntime();
  demand(name === undefined || name in RUNTIMES, `Unsupported OCI runtime ${name}; only crun or runc`);
  // containers.conf(5): default runtime priority is crun, then runc.
  const runtime = name ? firstReal(RUNTIMES[name], name) : firstReal([...RUNTIMES.crun, ...RUNTIMES.runc], "OCI runtime");
  return [firstReal(["/usr/bin/podman"], "podman"), runtime, firstReal(CONMON, "conmon")];
}
function digestFile(p: string): string {
  demand(realpathSync(p) === p, `Engine pin ${p} is not a canonical path`);
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    demand(stat.isFile() && (stat.mode & 0o111) !== 0 && stat.size <= 268435456, `Engine pin ${p} is not an executable file`);
    const digest = createHash("sha256"); const buffer = Buffer.alloc(1048576);
    for (let n: number; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0;) digest.update(buffer.subarray(0, n));
    return digest.digest("hex");
  } finally { closeSync(fd); }
}
// Engine configuration redirection would bypass the runtime/conmon pins; credentials stay refused generally.
const ENGINE_ENV = /^(?:CONTAINERS?_|PODMAN_|BUILDAH_|REGISTRIES_CONFIG_PATH$|STORAGE_|XDG_|DOCKER_|_CONTAINERS_)/;
const sortedList = (xs: string[]): string[] => [...xs].sort();
const pairs = (o: Record<string, string>): [string, string][] => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
/** Exactly the runtime's verifier-real-engine-v1 digest over the complete published entry. */
export function realEngineBinding(auth: { auth_id: string; candidate: { repo_realpath: string; commit_sha: string } }, entry: Entry & { real_engine: RealEngine }): string {
  const r = entry.real_engine;
  return sha(JSON.stringify(["verifier-real-engine-v1", auth.auth_id, auth.candidate.repo_realpath, auth.candidate.commit_sha, entry.id,
    entry.cwd_realpath, entry.argv, entry.selector, sortedList(entry.inputs), pairs(r.input_pins), pairs(r.engine_pins), r.storage_root,
    sortedList(entry.runtime_roots ?? []), sortedList(entry.read_roots), sortedList(entry.write_roots), pairs(entry.env), entry.timeout_s, entry.max_output_bytes ?? null]));
}
// Seal requested engine entries: verify the actual engine pins, choose the private store and bind.
function seal(auth: Authorization): Authorization {
  // SAFETY: validate() has checked every entry's shape.
  if (!(auth.entries as Entry[]).some(e => e.real_engine !== undefined)) return auth;
  const required = requiredEnginePins();
  const entries = (auth.entries as Entry[]).map(e => {
    if (e.real_engine === undefined) return e;
    const { engine_pins, input_pins } = e.real_engine;
    demand(e.inputs.length > 0 && JSON.stringify(sortedList(e.inputs)) === JSON.stringify(sortedList(Object.keys(input_pins))), "Real-engine input pins must cover exactly the inputs");
    for (const p of required) demand(Object.hasOwn(engine_pins, p), `Real-engine pins must include the actual engine executable ${p}`);
    demand(Object.hasOwn(engine_pins, e.argv[0]), "Real-engine argv[0] must be an exact pinned executable");
    for (const [p, digest] of Object.entries(engine_pins)) {
      demand(["/usr", ...(e.runtime_roots ?? [])].some((root: string) => inside(p, root)), `Engine pin ${p} is outside the runtime roots`);
      demand(digestFile(p) === digest, `Real-engine executable pin mismatch for ${p}`);
    }
    demand(!Object.keys(e.env).some(k => ENGINE_ENV.test(k)), "Engine configuration environment is not permitted");
    const sealed: Entry & { real_engine: RealEngine } = { ...e, real_engine: { storage_root: join(BASE, auth.auth_id, "engine-stores", e.id), engine_pins, input_pins, binding: "" } };
    sealed.real_engine.binding = realEngineBinding(auth, sealed);
    return sealed;
  });
  return { ...auth, entries };
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
    const auth: unknown = JSON.parse(fences[0][1]); validate(auth);
    const sealed = seal(auth); publish(sealed);
    return { auth_id: sealed.auth_id };
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
