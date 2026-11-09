// herdr-prs: finds the pull requests of the agent in a Herdr terminal and writes one data file per terminal.
//
//   herdr-prs refresh <terminal> [--discover] [--session <id>]... [--cwd <path>] [--print]
//   herdr-prs detail <owner/repo> <number> <body|checks|files|diff|threads> [--fresh]
//
// refresh writes <herdr home>/data/prs/<terminal>.json (home = $HERDR_APP_HOME or ~/.config/herdr-app).
// It prints nothing on success (with --print: the JSON) and exits 0 even when parts failed: they are in
// `errors`. detail prints JSON. Exit 2 is a usage error. The format is in FORMAT.md.
import { PARTS, detail } from "./detail.mjs";
import { withLock, lockFile } from "./lock.mjs";
import { dataFile, refresh } from "./refresh.mjs";
import { appHome, readJson } from "./util.mjs";
import { Deadline, makeRunner } from "./run.mjs";

const USAGE = `usage:
  herdr-prs refresh <terminal> [--discover] [--session <id>]... [--cwd <path>] [--print]
  herdr-prs detail <owner/repo> <number> <${PARTS.join("|")}> [--fresh]`;

class UsageError extends Error {}

/** Splits argv into positionals and flags. Flags that take a value: --session, --cwd. */
export function parseArgs(argv, spec) {
  const pos = [];
  const flags = { session: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    if (!(k in spec)) throw new UsageError(`unknown option: --${k}`);
    if (spec[k] === "bool") { flags[k] = true; continue; }
    const v = inline ?? argv[++i];
    if (v == null || v.startsWith("--")) throw new UsageError(`--${k} needs a value`);
    if (spec[k] === "list") flags[k].push(v); else flags[k] = v;
  }
  return { pos, flags };
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  try {
    const [cmd, ...rest] = argv;
    if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") { (cmd ? stdout : stderr).write(`${USAGE}\n`); return cmd ? 0 : 2; }
    if (cmd === "refresh") {
      const { pos, flags } = parseArgs(rest, { discover: "bool", print: "bool", session: "list", cwd: "value" });
      if (pos.length !== 1) throw new UsageError("refresh needs one terminal id");
      if (!/^[\w.-]+$/.test(pos[0])) throw new UsageError(`bad terminal id: ${pos[0]}`);
      // One run per terminal at a time: a run that meets a live one waits for it and then leaves its file as is.
      const locked = await withLock(lockFile(dataFile(appHome(env), pos[0])), () => refresh({ terminal: pos[0], discover: Boolean(flags.discover), sessionArgs: flags.session, cwdArg: flags.cwd ?? null, env }));
      if (flags.print) {
        const out = locked.ran ? locked.value : readJson(dataFile(appHome(env), pos[0]), null);
        if (out) stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      }
      return 0;
    }
    if (cmd === "detail") {
      const { pos, flags } = parseArgs(rest, { fresh: "bool" });
      if (pos.length !== 3) throw new UsageError("detail needs <owner/repo> <number> <part>");
      const [repo, num, part] = pos;
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new UsageError(`bad repo: ${repo} (want owner/name)`);
      if (!/^\d+$/.test(num)) throw new UsageError(`bad PR number: ${num}`);
      if (!PARTS.includes(part)) throw new UsageError(`bad part: ${part} (one of ${PARTS.join(", ")})`);
      const run = makeRunner({ deadline: new Deadline(25000), env });
      const out = await detail({ repo, number: Number(num), part, run, fresh: Boolean(flags.fresh), ...(env.HERDR_APP_HOME ? { home: env.HERDR_APP_HOME } : {}) });
      stdout.write(`${JSON.stringify(out)}\n`);
      return 0;
    }
    throw new UsageError(`unknown command: ${cmd}`);
  } catch (e) {
    if (e instanceof UsageError) { stderr.write(`herdr-prs: ${e.message}\n${USAGE}\n`); return 2; }
    // Not a usage error: still no crash for the caller that reads the data file.
    stderr.write(`herdr-prs: ${e?.stack ?? e}\n`);
    return 1;
  }
}
