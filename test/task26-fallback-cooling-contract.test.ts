import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FALLBACK_COOLING_TERMINAL_RE } from "../pi-extension/subagents/subagent-done.ts";

// TASK-26 — a cross-repository wording contract, guarded by a test.
//
// PRODUCER (a DIFFERENT repository, the live stack): the
// agent-fallback-chain extension at
// /home/kris/.pi/agent/extensions/agent-fallback-chain.ts writes the phrase
// "every chain model is cooling down" into the `agent-fallback-terminal`
// entry's `data.reason` when the whole provider chain is cooling and an
// in-process auto-resume is armed.
//
// CONSUMER (this fork): pi-extension/subagents/subagent-done.ts matches that
// reason with FALLBACK_COOLING_TERMINAL_RE to select the TASK-23 cooling-wait
// decision. If either side is ever reworded, the lane silently reverts to
// exiting at once and no other test notices. This fixture is the alarm.
const CANONICAL_COOLING_PHRASE = "every chain model is cooling down";
/** The producer's canonical install path on this machine; used for messages and
 * as the last-resort lookup when neither env override nor PI_CODING_AGENT_DIR resolves. */
const PRODUCER_FILE = "/home/kris/.pi/agent/extensions/agent-fallback-chain.ts";

/** Where the producer source may live, in priority order; the env override
 * lets the red-proof point the guard at a deliberately reworded scratch copy. */
function producerCandidates(): string[] {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return [
    process.env.PI_FALLBACK_CHAIN_SOURCE,
    join(agentDir, "extensions", "agent-fallback-chain.ts"),
    PRODUCER_FILE,
  ].filter((path): path is string => typeof path === "string" && path.length > 0);
}

/** Quoted / template string literals in TS source; enough for a substring contract. */
function stringLiterals(source: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < source.length; i++) {
    const quote = source[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && source[j] === "\\"; j--) backslashes++;
    if (backslashes % 2 === 1) continue;
    let value = "";
    let j = i + 1;
    for (; j < source.length; j++) {
      const char = source[j];
      if (char === "\\") {
        value += source[j + 1] ?? "";
        j++;
        continue;
      }
      if (char === quote) break;
      value += char;
    }
    out.push(value);
    i = j;
  }
  return out;
}

/** The reason strings passed as the first literal to each `terminal(...)` call;
 * this is the only path into the `agent-fallback-terminal` entry the consumer reads. */
function terminalReasons(source: string): string[] {
  const out: string[] = [];
  const marker = "terminal(";
  for (let idx = source.indexOf(marker); idx !== -1; idx = source.indexOf(marker, idx + marker.length)) {
    const literals = stringLiterals(source.slice(idx + marker.length));
    if (literals.length > 0) out.push(literals[0]);
  }
  return out;
}

describe("TASK-26 cooling-phrase cross-repo contract", () => {
  it("consumer matcher still accepts the canonical cooling phrase", () => {
    assert.ok(
      FALLBACK_COOLING_TERMINAL_RE.test(CANONICAL_COOLING_PHRASE),
      `cross-repo drift: consumer pi-extension/subagents/subagent-done.ts ` +
        `FALLBACK_COOLING_TERMINAL_RE (${FALLBACK_COOLING_TERMINAL_RE}) no longer matches the ` +
        `producer's canonical cooling phrase "${CANONICAL_COOLING_PHRASE}" from ${PRODUCER_FILE} (TASK-26)`,
    );
  });

  it("live-stack producer still emits a phrase the consumer matcher accepts", (t) => {
    const candidates = producerCandidates();
    const producer = candidates.find((path) => existsSync(path));
    if (!producer) {
      t.skip(`live-stack producer not present; looked for ${candidates.join(", ")}`);
      return;
    }
    const source = readFileSync(producer, "utf8");
    const matches = terminalReasons(source).filter((reason) => FALLBACK_COOLING_TERMINAL_RE.test(reason));
    assert.ok(
      matches.length > 0,
      `cross-repo drift: ${producer} no longer passes a terminal() reason matching ` +
        `pi-extension/subagents/subagent-done.ts FALLBACK_COOLING_TERMINAL_RE ` +
        `(${FALLBACK_COOLING_TERMINAL_RE}); expected the cooling terminal reason ` +
        `"${CANONICAL_COOLING_PHRASE}" (TASK-26)`,
    );
  });
});
