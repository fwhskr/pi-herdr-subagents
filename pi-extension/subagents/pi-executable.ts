import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pi's agent config dir: PI_CODING_AGENT_DIR, else ~/.pi/agent (the SDK's own
 * resolution, mirrored here because this module must stay SDK-free).
 */
function installedAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? homedir();
  const configured = env.PI_CODING_AGENT_DIR;
  // Match SDK getAgentDir()/normalizePath(): raw whitespace is meaningful,
  // leading ~ expands against the home directory, and file URLs are paths.
  if (!configured) return join(home, ".pi", "agent");
  if (configured === "~") return home;
  if (configured.startsWith("~/")) return join(home, configured.slice(2));
  if (configured.startsWith("file://")) return fileURLToPath(configured);
  return configured;
}

/**
 * Absolute path of the installed `pi` wrapper (`<agent dir>/bin/pi`) when one
 * exists and is executable, else `undefined` (an ordinary installation).
 * A pane's PATH normally lacks `<agent dir>/bin`, so a bare `pi` word there
 * would run the stock install and bypass the wrapper's routing.
 */
function installedPiWrapper(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidate = join(installedAgentDir(env), "bin", "pi");
  try {
    if (!statSync(candidate).isFile()) return undefined;
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * The command word a worker launch script uses for pi: the installed wrapper's
 * absolute path when present, otherwise the bare `pi` word (stock behavior).
 */
export function piLaunchWord(
  shellQuote: (value: string) => string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const wrapper = installedPiWrapper(env);
  if (!wrapper) return "pi";
  return /^[A-Za-z0-9_/.@%+=:,-]+$/.test(wrapper) ? wrapper : shellQuote(wrapper);
}
