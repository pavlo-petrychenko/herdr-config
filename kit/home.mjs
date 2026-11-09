// Step 1 and 2 of the wizard: find Herdr and its home, and check the programs the pieces need.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expand, run, which } from "./util.mjs";

export function resolveHome(flag, env) {
  return path.resolve(expand(flag ?? (env.HERDR_APP_HOME?.trim() || path.join(os.homedir(), ".config", "herdr-app"))));
}

export function resolveStateDir(flag, env) {
  return path.resolve(expand(flag ?? path.join(os.homedir(), ".local", "share", "herdr-kit")));
}

/** Where the tool links go: --bin-dir, else ~/.local/bin. */
export function resolveBinDir(flag) {
  return path.resolve(expand(flag ?? path.join(os.homedir(), ".local", "bin")));
}

/** Claude Code's folder: --claude-dir, else $CLAUDE_CONFIG_DIR, else ~/.claude. */
export function resolveClaudeDir(flag, env) {
  return path.resolve(expand(flag ?? (env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude"))));
}

/** Runs herdr-app for this home. */
export function herdrApp(ctx, args) {
  return run("herdr-app", args, { env: { ...ctx.env, HERDR_APP_HOME: ctx.home } });
}

/** What the window for this home shows ({ layout, ... }), or null when no window is open. */
export function windowStatus(ctx) {
  const r = herdrApp(ctx, ["status"]);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.out); } catch { return null; }
}

/**
 * Step 1. { stop: "why" } when the kit must not go on; else { version, window: status|null }.
 */
export function findHerdr(ctx) {
  if (fs.existsSync(path.join(ctx.home, ".git"))) {
    return { stop: `${ctx.home} is a git checkout (the herdr-config repo itself). Use its install.sh there, not herdr-kit.` };
  }
  if (!fs.existsSync(ctx.home) || !fs.existsSync(path.join(ctx.home, "installed.json"))) {
    return { stop: `No Herdr home at ${ctx.home}. Start Herdr once, so it makes its home, then run this again.` };
  }
  const v = herdrApp(ctx, ["--version"]);
  if (v.code !== 0) return { stop: "herdr-app was not found on PATH. Install Herdr (herdr.dev) and open it once." };
  const version = v.out.trim().replace(/^herdr-app\s+/, "");
  return { version, window: windowStatus(ctx) };
}

/**
 * Step 2. { <need>: { ok, why } } for every need a piece can name (pieces.mjs).
 * `why` is the one line shown when the need is missing.
 */
export function checkPrograms(ctx, found) {
  const env = ctx.env;
  const has = (name) => which(name, env) !== null;
  const major = Number(process.versions.node.split(".")[0]);
  const checks = {
    window: { ok: Boolean(found?.window), why: "no Herdr window is open for this home (building the flat sidebar needs one)" },
    node20: { ok: major >= 20, why: `Node ${process.versions.node} is older than 20` },
    git: { ok: has("git"), why: "git was not found" },
    python3: { ok: has("python3") && run("python3", ["--version"], { env }).code === 0, why: "Python 3 was not found" },
    gh: { ok: false, why: "the GitHub CLI (gh) was not found" },
    claude: { ok: has("claude"), why: "Claude Code (claude) was not found" },
    jq: { ok: has("jq"), why: "jq was not found" },
    "agent-plan-review": { ok: has("agent-plan-review"), why: "agent-plan-review was not found" },
  };
  if (has("gh")) {
    const login = run("gh", ["auth", "status"], { env, timeout: 30000 });
    checks.gh = login.code === 0 ? { ok: true } : { ok: false, why: "gh is not logged in (run: gh auth login)" };
  }
  return checks;
}
