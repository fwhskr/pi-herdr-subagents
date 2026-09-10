import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

export type LaunchIdentityError =
  | "UNAVAILABLE" | "UNREGISTERED" | "STALE_GENERATION" | "REVOKED"
  | "CONFLICT" | "UNSUPPORTED_VERSION" | "RESUME_REAUTH_REQUIRED" | "MALFORMED_REQUEST";

export interface LaunchIdentity {
  v: 1;
  requestId: string;
  authorityEpoch: string;
  launchGeneration: number;
  childSessionId: string;
  parentSessionId: string;
  persona: string;
  canonicalProject: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  lifecycle: "active";
}
export type LaunchIdentityResult =
  | { ok: true; identity: LaunchIdentity }
  | { ok: false; error: LaunchIdentityError };

const errors = new Set<LaunchIdentityError>([
  "UNAVAILABLE", "UNREGISTERED", "STALE_GENERATION", "REVOKED", "CONFLICT",
  "UNSUPPORTED_VERSION", "RESUME_REAUTH_REQUIRED", "MALFORMED_REQUEST",
]);
const strings = [
  "requestId", "authorityEpoch", "childSessionId", "parentSessionId", "persona",
  "canonicalProject", "workspaceId", "tabId", "paneId",
] as const;
const unavailable: LaunchIdentityResult = { ok: false, error: "UNAVAILABLE" };
let exchange: ((request: string) => Promise<string>) | undefined;
try {
  // Fixed module and FD: no worker-supplied endpoint, metadata or env selector.
  exchange = createRequire(import.meta.url)("./launch-identity-native.node").exchange;
} catch {
  // Unsupported platform / module not built: never fall back to recovery files.
}
let pending: Promise<unknown> = Promise.resolve();

/** Live evidence for this process only. Never accept this result from another process. */
export function resolveSelf(): Promise<LaunchIdentityResult> {
  const next = pending.then(async (): Promise<LaunchIdentityResult> => {
    if (!exchange) return unavailable;
    const requestId = randomUUID();
    try {
      const raw = await exchange(JSON.stringify({ v: 1, op: "resolveSelf", requestId }));
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value) || value.v !== 1) return unavailable;
      if (value.error) {
        if (Object.keys(value).length !== 3 || !errors.has(value.error)) return unavailable;
        // Credentials rejection happens before request parsing/correlation.
        if (value.requestId !== requestId && !(value.requestId === null && value.error === "UNREGISTERED")) return unavailable;
        return { ok: false, error: value.error };
      }
      if (value.requestId !== requestId || value.lifecycle !== "active"
          || Object.keys(value).length !== strings.length + 3
          || strings.some((key) => typeof value[key] !== "string" || !value[key].trim())
          || !Number.isSafeInteger(value.launchGeneration) || value.launchGeneration < 1
          || !/^[0-9a-f-]{36}$/.test(value.authorityEpoch)
          || !/^[a-z][a-z0-9-]*$/.test(value.persona)
          || ["nova", "halo", "echo"].includes(value.persona)
          || !value.canonicalProject.startsWith("/")
          || value.childSessionId === value.parentSessionId) return unavailable;
      return { ok: true, identity: value };
    } catch {
      return unavailable;
    }
  });
  pending = next;
  return next;
}
