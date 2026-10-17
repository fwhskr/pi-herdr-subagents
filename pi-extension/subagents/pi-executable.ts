import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Pi's agent config dir: PI_CODING_AGENT_DIR, else ~/.pi/agent (the SDK's own
 * resolution, mirrored here because this module must stay SDK-free).
 */
function installedAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  return configured ? configured : join(env.HOME?.trim() || homedir(), ".pi", "agent");
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
