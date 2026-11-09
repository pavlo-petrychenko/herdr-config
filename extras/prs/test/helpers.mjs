// Shared by the tests: fixture trees in temp folders and a fake `run` for hc, ps, git and gh.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const fixture = (...p) => path.join(here, "fixtures", ...p);
export const readFixture = (name) => JSON.parse(fs.readFileSync(fixture(name), "utf8"));

export const SESSION = "11111111-aaaa-4bbb-8ccc-000000000001";

export function tmp(prefix = "prs-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A copy of fixtures/claude in a temp folder: { dir (the claude dir), transcript, sessionDir }. */
export function claudeCopy() {
  const dir = tmp("prs-claude-");
  fs.cpSync(fixture("claude"), dir, { recursive: true });
  const transcript = path.join(dir, "projects/-work-app", `${SESSION}.jsonl`);
  return { dir, transcript, sessionDir: transcript.replace(/\.jsonl$/, "") };
}

/**
 * A fake run(cmd, args, opts). `rules` is a list of [match, answer]: match is a function (cmd, args) -> bool
 * (or a string that must equal `cmd args.join(" ")`'s start); answer is { code, stdout, stderr } or a function
 * (cmd, args, opts) -> answer. No rule: exit 127. Every call is recorded in run.calls.
 */
export function fakeRun(rules = []) {
  const calls = [];
  const run = async (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    const line = `${cmd} ${args.join(" ")}`;
    for (const [match, answer] of rules) {
      const ok = typeof match === "function" ? match(cmd, args, opts) : line.startsWith(match);
      if (!ok) continue;
      const r = typeof answer === "function" ? await answer(cmd, args, opts) : answer;
      return { code: 0, stdout: "", stderr: "", ...r };
    }
    return { code: 127, stdout: "", stderr: `no rule for: ${line}`, error: null };
  };
  run.calls = calls;
  return run;
}

/** The graphql query a gh call carries. */
export const queryOf = (args) => (args[0] === "api" && args[1] === "graphql" ? args[args.indexOf("-f") + 1].replace(/^query=/, "") : null);
