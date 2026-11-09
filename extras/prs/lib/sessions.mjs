// Terminal -> Claude Code sessions. Three sources, in this order:
//   hook  <home>/data/agent-sessions/<terminal>.jsonl, one line per SessionStart: {sessionId, transcriptPath, cwd, source, at}
//   live  `hc get <terminal>` -> the claude process below it -> ~/.claude/sessions/<pid>.json -> sessionId
//   arg   --session <id>
// Older sessions are not guessed: a wrong guess would show another agent's PRs.
import fs from "node:fs";
import path from "node:path";
import { safeName } from "./util.mjs";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,100}$/;

/** ~/.claude/projects/<any slug>/<sessionId>.jsonl, found by looking, not by guessing the slug rule. */
export function findTranscript(claudeDir, sessionId) {
  if (!SESSION_ID.test(sessionId)) return null;
  const projects = path.join(claudeDir, "projects");
  let slugs = [];
  try { slugs = fs.readdirSync(projects); } catch { return null; }
  for (const slug of slugs) {
    const p = path.join(projects, slug, `${sessionId}.jsonl`);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

/** The hook's lines, de-duplicated by sessionId (the last line of an id wins). */
export function readHookSessions(home, terminal) {
  const file = path.join(home, "data/agent-sessions", `${safeName(terminal)}.jsonl`);
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const byId = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d || typeof d.sessionId !== "string") continue;
    byId.delete(d.sessionId);
    byId.set(d.sessionId, d);
  }
  return [...byId.values()];
}

/** pid -> children, from one `ps` call. */
export function parsePs(text) {
  const kids = new Map();
  for (const line of String(text).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const ppid = Number(m[2]);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(Number(m[1]));
  }
  return kids;
}

/** The pids at or below `roots`, shallowest first: [{ pid, depth }]. */
export function descendants(kids, roots) {
  const seen = new Map();
  let level = roots.filter((p) => Number.isInteger(p));
  for (let depth = 0; level.length && depth < 12; depth++) {
    const next = [];
    for (const pid of level) {
      if (seen.has(pid)) continue;
      seen.set(pid, depth);
      next.push(...(kids.get(pid) ?? []));
    }
    level = next;
  }
  return [...seen].map(([pid, depth]) => ({ pid, depth }));
}

/**
 * The session running in the terminal now. Returns { live, fgCwd, errors }:
 *   live   { pid, sessionId, cwd } | null
 *   fgCwd  the terminal's live folder (hc's foreground.cwd) | null
 */
export async function findLive({ terminal, claudeDir, run }) {
  const errors = [];
  const none = { live: null, fgCwd: null, errors };
  const r = await run("hc", ["get", terminal, "--json"], { timeout: 5000 });
  if (r.error) { errors.push({ kind: "hc", message: `hc failed: ${r.error}` }); return none; }
  let t = null;
  try { t = JSON.parse(r.stdout); } catch { /* below */ }
  if (!t || t.error) {
    errors.push({ kind: "hc", message: `hc get ${terminal}: ${t?.error?.message ?? (r.stderr.trim() || "no answer")}` });
    return none;
  }
  const fgCwd = t.foreground?.cwd || t.cwd || null;
  const ps = await run("ps", ["-axo", "pid=,ppid="], { timeout: 5000 });
  const kids = ps.code === 0 ? parsePs(ps.stdout) : new Map();
  const cands = descendants(kids, [t.foreground?.pid, t.pid]);
  if (!cands.length) for (const p of [t.foreground?.pid, t.pid]) if (Number.isInteger(p)) cands.push({ pid: p, depth: 0 });
  const found = [];
  for (const { pid, depth } of cands) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(claudeDir, "sessions", `${pid}.json`), "utf8")); } catch { continue; }
    if (j && typeof j.sessionId === "string") found.push({ pid, depth, sessionId: j.sessionId, cwd: j.cwd ?? null, interactive: j.kind === "interactive" ? 0 : 1, updatedAt: j.updatedAt ?? 0 });
  }
  found.sort((a, b) => a.depth - b.depth || a.interactive - b.interactive || b.updatedAt - a.updatedAt);
  const best = found[0];
  return { live: best ? { pid: best.pid, sessionId: best.sessionId, cwd: best.cwd } : null, fgCwd, errors };
}

/**
 * All sessions of a terminal: [{ sessionId, transcriptPath, from }]. `from` is "live" when the session
 * runs now, else "arg" when it was passed with --session, else "hook".
 * Also returns `live`, `fgCwd`, and `hookCwd` (the folder of the newest hook line), for the worktree.
 */
export async function findSessions({ terminal, home, claudeDir, run, args = [] }) {
  const errors = [];
  const by = new Map(); // sessionId -> { sessionId, transcriptPath, from }
  const add = (sessionId, transcriptPath, from) => {
    const cur = by.get(sessionId);
    const rank = { hook: 0, arg: 1, live: 2 };
    const tp = transcriptPath && fs.existsSync(transcriptPath) ? transcriptPath : findTranscript(claudeDir, sessionId);
    if (!tp) { if (!cur) errors.push({ kind: "session", message: `no transcript found for session ${sessionId} (${from})` }); return; }
    if (!cur || rank[from] > rank[cur.from]) by.set(sessionId, { sessionId, transcriptPath: tp, from });
  };

  const hook = readHookSessions(home, terminal);
  for (const h of hook) add(h.sessionId, h.transcriptPath, "hook");
  const hookCwd = hook.length ? hook[hook.length - 1].cwd ?? null : null;

  const { live, fgCwd, errors: liveErrors } = await findLive({ terminal, claudeDir, run });
  errors.push(...liveErrors);
  if (live) add(live.sessionId, null, "live");

  for (const id of args) {
    if (!SESSION_ID.test(id)) { errors.push({ kind: "session", message: `bad session id: ${id}` }); continue; }
    add(id, null, "arg");
  }
  return { sessions: [...by.values()], live, fgCwd, hookCwd, errors };
}
