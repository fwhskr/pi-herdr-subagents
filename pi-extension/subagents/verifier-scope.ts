import { accessSync, constants, closeSync, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join, normalize } from "node:path";

const BASE = "/home/kris/.pi/agent/var/verifier-scope";
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
export const VERIFIER_TOOLS = "read,grep,find,ls,verify_run,caller_ping,subagent_done";
export const VERIFIER_EXCLUSIONS = "mcp__*,bash,write,edit,codemode,tool_search,mcp,lazy_load_tools,ctx_*,jev_*,agent_message,subagent,subagent_resume,subagent_interrupt,subagents_list";
export interface VerifierScopeBinding { auth_id: string; error?: string }
export interface VerifierScopeMetadata { verifierScope?: VerifierScopeBinding }
type Authorization = { schema: 1; auth_id: string; candidate: { repo_realpath: string; commit_sha: string }; entries: unknown[] };
type EngineRequest = { engine_pins: Record<string, string>; input_pins: Record<string, string> };
type RealEngine = EngineRequest & { storage_root: string; binding: string };
// Launcher-authored detached bounded attempt (TASK-267): finite kernel ceilings the runtime must PROVE on the
// owned service cgroup before dispatch; timeout_s then becomes the whole-attempt deadline (10..900s).
type Detached = { memory_max_bytes: number; pids_max: number };
const DETACHED_MEMORY_MIN = 16 * 1024 * 1024, DETACHED_MEMORY_MAX = 64 * 1024 * 1024 * 1024, DETACHED_PIDS_MAX = 4096;
const DETACHED_MIN_S = 10, DETACHED_MAX_S = 900;
// Validated entry shape (validate() checks every field); other fields are carried through verbatim.
type Entry = {
  id: string; cwd_realpath: string; argv: string[]; selector: string; inputs: string[]; runtime_roots?: string[];
  read_roots: string[]; write_roots: string[]; env: Record<string, string>; timeout_s: number; max_output_bytes?: number;
  real_engine?: EngineRequest | RealEngine; detached?: Detached; tmp_root?: string;
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
    keys(e, ["id", "cwd_realpath", "argv", "selector", "inputs", "runtime_roots", "read_roots", "write_roots", "env", "timeout_s", "max_output_bytes", "max_attempts", "retry_on_failure", "network", "runner_self_test", "real_engine", "detached", "tmp_root"]);
    demand(typeof e.id === "string" && ID.test(e.id) && !ids.has(e.id), "Invalid/duplicate entry id"); ids.add(e.id);
    demand(typeof e.cwd_realpath === "string" && strings(e.argv) && e.argv.length > 0 && e.argv[0].startsWith("/"), "Invalid command");
    demand(typeof e.selector === "string" && strings(e.inputs) && strings(e.read_roots) && strings(e.write_roots) && (e.runtime_roots === undefined || strings(e.runtime_roots)), "Invalid roots or selector");
    // Optional caller-owned temporary/home root: must be exactly one declared write root and is never a real-engine entry
    // (its /tmp is the engine's private store). Canonical containment in cwd is the runtime's check, before reservation.
    demand(e.tmp_root === undefined || (typeof e.tmp_root === "string" && e.write_roots.includes(e.tmp_root) && e.real_engine === undefined), "Invalid tmp_root: it must be one of the entry's write_roots and is not available to real-engine entries");
    demand(e.max_attempts === 1 && e.retry_on_failure === false && e.network === false, "Only once, no-retry, offline entries are supported");
    if (e.detached !== undefined) {
      const d = e.detached;
      demand(object(d) && e.runner_self_test === undefined, "Invalid detached authorization");
      keys(d, ["memory_max_bytes", "pids_max"]);
      // Both finite kernel ceilings are mandatory; no "max"/unlimited, fractional, string or non-finite value is accepted.
      demand(Number.isSafeInteger(d.memory_max_bytes) && Number(d.memory_max_bytes) >= DETACHED_MEMORY_MIN && Number(d.memory_max_bytes) <= DETACHED_MEMORY_MAX
        && Number.isSafeInteger(d.pids_max) && Number(d.pids_max) >= 1 && Number(d.pids_max) <= DETACHED_PIDS_MAX, "Invalid detached kernel ceilings");
      // Only a detached entry may exceed the synchronous 60-second bound.
      demand(Number.isInteger(e.timeout_s) && Number(e.timeout_s) >= DETACHED_MIN_S && Number(e.timeout_s) <= DETACHED_MAX_S, `Invalid detached overall deadline (${DETACHED_MIN_S}..${DETACHED_MAX_S} seconds)`);
    } else demand(Number.isInteger(e.timeout_s) && Number(e.timeout_s) >= 1 && Number(e.timeout_s) <= 60, "Invalid timeout (1..60 seconds)");
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
// /usr/share drop-ins documented in containers.conf(5) apply. Runtime/conmon path overrides are
// refused; a selected OCI runtime must be one of the discovered trusted roles below.
const SHARE = "/usr/share/containers";
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
// Same contract as the runtime's realEngineRoles() (verifier-scoped-runner.ts): Podman itself and
// every OCI runtime, conmon and helper Podman may exec, in Podman's default search directories.
const ENGINE_ROLES: Record<string, string[]> = {
  engine: ["podman"], conmon: ["conmon"],
  "oci-runtime": ["crun", "runc", "krun", "youki", "runsc", "kata-runtime", "ocijail", "runj", "crun-vm", "crun-wasm"],
  helper: ["catatonit", "netavark", "aardvark-dns", "pasta", "slirp4netns", "rootlessport", "fuse-overlayfs"],
};
const ENGINE_ROLE_DIRS = ["/usr/local/libexec/podman", "/usr/local/lib/podman", "/usr/libexec/podman", "/usr/lib/podman",
  "/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin", "/bin", "/sbin", "/usr/lib/cri-o-runc/sbin"];
const forbiddenComponent = /^(?:\.ssh|\.gnupg|\.netrc|\.git-credentials|\.aws|\.kube|keyrings|Trash|auth\.json|mcp-auth\.json|provider-credentials(?:\.json)?|credentials\.json|\.credentials|\.env)$/i;
function forbidden(p: string): boolean {
  return p.split("/").some(x => forbiddenComponent.test(x)) || /\/\.docker(?:\/config\.json)?(?:\/|$)/.test(p) || ["/run", "/proc", "/dev", "/etc"].some(r => inside(p, r));
}
// Root-owned along the whole canonical path and not group/other writable (the overflow uid stands
// for unmapped root inside a user namespace, never the caller's own uid): a renamed or copied user
// binary, a symlink or a file below a user-writable directory is never an engine role.
function trustedExecutable(p: string): boolean {
  if (!isAbsolute(p) || normalize(p) !== p || p === "/" || forbidden(p)) return false;
  let overflow = 65534;
  try { overflow = Number(readFileSync("/proc/sys/kernel/overflowuid", "utf8").trim()); } catch { /* kernel default */ }
  const self = process.getuid!();
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const trusted = (uid: number, mode: number): boolean => uid !== self && (uid === 0 || uid === overflow) && (mode & 0o022) === 0;
    const readOnly = (): boolean => { try { accessSync("/", constants.W_OK); return false; } catch { return true; } };
    const top = fstatSync(fd);
    if (!trusted(top.uid, top.mode) && !(top.uid === self && readOnly())) return false;
    for (const part of p.split("/").filter(Boolean)) {
      const next = openSync(`/proc/self/fd/${fd}/${part}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      closeSync(fd); fd = next;
      const st = fstatSync(fd);
      if (!trusted(st.uid, st.mode)) return false;
    }
    const st = fstatSync(fd);
    return st.isFile() && (st.mode & 0o111) !== 0 && realpathSync(`/proc/self/fd/${fd}`) === p;
  } catch { return false; } finally { closeSync(fd); }
}
function discoverEngineRoles(dirs: string[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (const dir of dirs) {
    for (const [role, names] of Object.entries(ENGINE_ROLES)) {
      for (const name of names) {
        const candidate = join(dir, name);
        let real: string;
        try { lstatSync(candidate); real = realpathSync(candidate); } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e;
        }
        demand(trustedExecutable(real), `Engine role executable is not a trusted system executable: ${candidate}`);
        demand(found[real] === undefined || found[real] === role, `Ambiguous engine role executable: ${real}`);
        found[real] = role;
      }
    }
  }
  for (const role of ["engine", "conmon", "oci-runtime"]) demand(Object.values(found).includes(role), `Real-engine role unavailable on this host: ${role}`);
  return found;
}
/** Canonical path -> role for every trusted engine role executable present; engine entries pin exactly this set. */
export function realEngineRoles(): Record<string, string> { return discoverEngineRoles(ENGINE_ROLE_DIRS); }
export const __engineTest__ = { discoverEngineRoles };
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
    sortedList(entry.runtime_roots ?? []), sortedList(entry.read_roots), sortedList(entry.write_roots), pairs(entry.env), entry.timeout_s, entry.max_output_bytes ?? null,
    // Appended only for detached entries (exactly the runtime's order), so every non-detached binding is unchanged.
    ...(entry.detached ? [["detached", entry.detached.memory_max_bytes, entry.detached.pids_max]] : [])]));
}
// Seal requested engine entries before publication: argv[0] is genuine Podman, engine_pins equal
// exactly the discovered trusted roles with verified digests, then choose the private store and bind.
function seal(auth: Authorization): Authorization {
  // SAFETY: validate() has checked every entry's shape.
  if (!(auth.entries as Entry[]).some(e => e.real_engine !== undefined)) return auth;
  const roles = realEngineRoles();
  const selected = engineRuntime();
  demand(selected === undefined || Object.entries(roles).some(([p, role]) => role === "oci-runtime" && basename(p) === selected),
    `Configured OCI runtime ${selected} is not a trusted discovered engine role`);
  const entries = (auth.entries as Entry[]).map(e => {
    if (e.real_engine === undefined) return e;
    const { engine_pins, input_pins } = e.real_engine;
    demand(e.inputs.length > 0 && JSON.stringify(sortedList(e.inputs)) === JSON.stringify(sortedList(Object.keys(input_pins))), "Real-engine input pins must cover exactly the inputs");
    demand(roles[e.argv[0]] === "engine", "Real-engine argv[0] must be the trusted engine executable itself, not a wrapper, interpreter or renamed binary");
    const missing = Object.keys(roles).filter(p => !Object.hasOwn(engine_pins, p)).sort();
    const extra = Object.keys(engine_pins).filter(p => !Object.hasOwn(roles, p)).sort();
    demand(missing.length === 0 && extra.length === 0, `Real-engine pins must cover exactly the trusted engine role executables (missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`);
    // Engine roles come only from trusted discovery; a caller runtime root never hosts or shadows one.
    for (const root of e.runtime_roots ?? []) demand(!Object.keys(roles).some(p => inside(p, root) || inside(root, p)), `Runtime root ${root} may not host an engine role executable`);
    demand(!Object.keys(e.env).some(k => ENGINE_ENV.test(k)), "Engine configuration environment is not permitted");
    for (const [p, digest] of pairs(engine_pins)) demand(digestFile(p) === digest, `Real-engine executable pin mismatch for ${p}`);
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
