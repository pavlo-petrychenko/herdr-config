// Reads Claude Code transcripts for what an agent made: PRs it created, branches it pushed, worktrees
// its subagents and workflows got. The format is internal to Claude Code, so everything is defensive.
//
// Records that matter (one JSON object per line):
//   {"toolUseResult":{"gitOperation":{"pr":{"number":1,"url":"…/pull/1","action":"created"},"push":{"branch":"b"}}},"cwd":"/x",…}
//   {"type":"pr-link","prNumber":1,"prUrl":"…","prRepository":"o/r"}                (main transcript only)
//   agent-*.meta.json: {"name"?,"description","agentType","worktreePath"?,"worktreeBranch"?}
//   workflows/wf_<id>.json: {"workflowName",…}
// A line is parsed only when a plain byte search finds one of the markers in it.
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { mapLimit, parsePrUrl } from "./util.mjs";

const CHUNK = 4 * 1024 * 1024;
const STATIC_NEEDLES = [Buffer.from('"gitOperation"'), Buffer.from('"pr-link"'), Buffer.from("gh pr create")];
const GH_CREATE = /(?:^|[\s;&|(`])gh\s+pr\s+create\b/;
const PULL_URLS = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/g;
const MAX_PENDING = 50;
const HEAD_BYTES = 256;
const REST_MS = 10 * 60 * 1000;

const emptyGh = () => ({ cmds: 0, ok: 0, err: 0, pending: [] });
const emptyEntry = () => ({ s: 0, m: 0, o: 0, h: "", prs: [], links: [], pushes: [], bad: 0, gh: emptyGh() });

function addUnique(list, item, keyOf) {
  const k = keyOf(item);
  if (!list.some((x) => keyOf(x) === k)) list.push(item);
}

const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("\n") : "");

/** Applies one parsed record to a file entry. */
export function applyRecord(d, e) {
  if (!d || typeof d !== "object") return;
  if (d.type === "pr-link" && Number.isInteger(d.prNumber)) {
    const parsed = parsePrUrl(d.prUrl);
    const repo = d.prRepository || parsed?.repo || null;
    if (repo) addUnique(e.links, { n: d.prNumber, repo, url: d.prUrl ?? null }, (x) => `${x.repo}#${x.n}`);
  }
  const tur = d.toolUseResult;
  const g = tur && typeof tur === "object" && !Array.isArray(tur) ? tur.gitOperation : null;
  if (g && typeof g === "object") {
    const pr = g.pr;
    if (pr && typeof pr === "object" && pr.action === "created" && Number.isInteger(pr.number)) {
      addUnique(e.prs, { n: pr.number, url: typeof pr.url === "string" ? pr.url : null, cwd: typeof d.cwd === "string" ? d.cwd : null }, (x) => `${x.url ?? x.cwd}#${x.n}`);
    }
    const push = g.push;
    if (push && typeof push === "object" && typeof push.branch === "string" && push.branch) {
      addUnique(e.pushes, { branch: push.branch, cwd: typeof d.cwd === "string" ? d.cwd : null }, (x) => `${x.branch}|${x.cwd}`);
    }
  }
  // `gh pr create` and its result. Workflow agents' results carry no toolUseResult at all, only the text
  // `gh` printed, so a successful create is also read from that text (the PR URL is its last line).
  const content = d.message?.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_use" && b.name === "Bash" && typeof b.input?.command === "string" && GH_CREATE.test(b.input.command) && typeof b.id === "string") {
        e.gh.cmds++;
        if (e.gh.pending.length < MAX_PENDING) e.gh.pending.push(b.id);
      } else if (b.type === "tool_result" && e.gh.pending.includes(b.tool_use_id)) {
        e.gh.pending = e.gh.pending.filter((id) => id !== b.tool_use_id);
        const urls = b.is_error ? [] : textOf(b.content).match(PULL_URLS) ?? [];
        const pr = parsePrUrl(urls[urls.length - 1]);
        if (!pr) { e.gh.err++; continue; }
        e.gh.ok++;
        addUnique(e.prs, { n: pr.number, url: urls[urls.length - 1], cwd: typeof d.cwd === "string" ? d.cwd : null }, (x) => `${x.url ?? x.cwd}#${x.n}`);
      }
    }
  }
}

/**
 * Scans a transcript, from `prev.o` when the file only grew. Returns { entry, changed, bytes } or null
 * when the file cannot be read. The entry is plain data, ready for the cache.
 */
export async function scanFile(file, prev = null) {
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  if (prev && prev.s === st.size && prev.m === st.mtimeMs) return { entry: prev, changed: false, bytes: 0 };
  let fh;
  try { fh = await fsp.open(file, "r"); } catch { return null; }
  try {
    const head = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
    if (head.length) await fh.read(head, 0, head.length, 0);
    const h = crypto.createHash("sha1").update(head).digest("hex");
    // Rewritten or shrunk: start again. Transcripts only grow.
    let e = prev && prev.s <= st.size && prev.o <= st.size && prev.h === h ? { ...emptyEntry(), ...structuredClone(prev) } : emptyEntry();
    e.gh = { ...emptyGh(), ...e.gh };
    const start = e.o;
    const size = st.size;
    let pos = start;
    let carry = Buffer.alloc(0);
    let consumed = start;
    const read = Buffer.alloc(Math.min(CHUNK, Math.max(1, size - start)));
    while (pos < size) {
      const want = Math.min(read.length, size - pos);
      const { bytesRead } = await fh.read(read, 0, want, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, read.subarray(0, bytesRead)]) : Buffer.from(read.subarray(0, bytesRead));
      const base = consumed; // file offset of data[0]
      const memo = STATIC_NEEDLES.map(() => -2);
      let ls = 0;
      for (;;) {
        const nl = data.indexOf(10, ls);
        if (nl === -1) break;
        if (nl > ls && lineHasNeedle(data, ls, nl, memo, e.gh.pending)) parseLine(data, ls, nl, e);
        ls = nl + 1;
      }
      carry = ls < data.length ? Buffer.from(data.subarray(ls)) : Buffer.alloc(0);
      consumed = base + ls;
    }
    // A last line without its newline: take it only when it is complete JSON, else wait for the rest.
    if (carry.length && carry[carry.length - 1] === 125) {
      let d = null;
      try { d = JSON.parse(carry.toString("utf8")); } catch { d = null; }
      if (d) { applyRecord(d, e); consumed += carry.length; }
    }
    e.s = st.size; e.m = st.mtimeMs; e.o = consumed; e.h = h;
    return { entry: compact(e), changed: true, bytes: size - start };
  } finally {
    await fh.close();
  }
}

/** The cache entry without the empty parts: most transcript files hold no PR at all. */
function compact(e) {
  const out = { s: e.s, m: e.m, o: e.o, h: e.h };
  if (e.prs.length) out.prs = e.prs;
  if (e.links.length) out.links = e.links;
  if (e.pushes.length) out.pushes = e.pushes;
  if (e.bad) out.bad = e.bad;
  if (e.gh.cmds) out.gh = e.gh;
  return out;
}

function lineHasNeedle(data, ls, le, memo, pending) {
  for (let k = 0; k < STATIC_NEEDLES.length; k++) {
    let i = memo[k];
    if (i !== -1 && i < ls) { i = data.indexOf(STATIC_NEEDLES[k], ls); memo[k] = i; }
    if (i !== -1 && i < le) return true;
  }
  if (pending.length) {
    const slice = data.subarray(ls, le);
    for (const id of pending) if (slice.includes(`"tool_use_id":"${id}"`)) return true;
  }
  return false;
}

function parseLine(data, ls, le, e) {
  let d;
  try { d = JSON.parse(data.toString("utf8", ls, le)); } catch { e.bad++; return; }
  applyRecord(d, e);
}

// ---- small files ---------------------------------------------------------------------------------------

async function readSmall(file, prev, pick, maxBytes = 8 * 1024 * 1024) {
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  if (prev && prev.s === st.size && prev.m === st.mtimeMs) return { entry: prev, changed: false };
  if (st.size > maxBytes) return { entry: { s: st.size, m: st.mtimeMs, v: {} }, changed: true };
  let v = {};
  try { v = pick(JSON.parse(await fsp.readFile(file, "utf8"))) ?? {}; } catch { v = {}; }
  return { entry: { s: st.size, m: st.mtimeMs, v }, changed: true };
}

const pickMeta = (j) => ({
  name: j?.name, description: j?.description, agentType: j?.agentType,
  worktreePath: j?.worktreePath, worktreeBranch: j?.worktreeBranch,
});
const pickWorkflow = (j) => ({ name: j?.workflowName });

// ---- one session ------------------------------------------------------------------------------------------

async function listDir(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

/** The files of a session: main transcript, subagents, workflow agents; and the workflow run files. */
export async function sessionFiles(transcriptPath) {
  const dir = transcriptPath.replace(/\.jsonl$/, "");
  const files = [{ path: transcriptPath, kind: "main" }];
  for (const d of await listDir(path.join(dir, "subagents"))) {
    if (d.isFile() && /^agent-.+\.jsonl$/.test(d.name)) {
      files.push({ path: path.join(dir, "subagents", d.name), kind: "sub", meta: path.join(dir, "subagents", d.name.replace(/\.jsonl$/, ".meta.json")) });
    }
  }
  const wfRoot = path.join(dir, "subagents", "workflows");
  for (const w of await listDir(wfRoot)) {
    if (!w.isDirectory() || !/^wf_/.test(w.name)) continue;
    for (const d of await listDir(path.join(wfRoot, w.name))) {
      if (d.isFile() && /^agent-.+\.jsonl$/.test(d.name)) {
        files.push({
          path: path.join(wfRoot, w.name, d.name), kind: "wf", wfId: w.name,
          meta: path.join(wfRoot, w.name, d.name.replace(/\.jsonl$/, ".meta.json")),
          run: path.join(dir, "workflows", `${w.name}.json`),
        });
      }
    }
  }
  return files;
}

/**
 * Scans all files of one session and returns what they hold, with who made each thing:
 *   created   [{ n, url, cwd, by }]       PRs made (gitOperation action "created")
 *   links     [{ n, repo, url }]          pr-link records (main transcript)
 *   pushes    [{ branch, cwd, by }]
 *   worktrees [{ path, by, branch0 }]     from agent meta files (branch0 = the branch it started on)
 *   bad       number of unparseable lines
 *   formatErrors  [{ file, message }]
 * A created PR comes from `gitOperation` (action "created"), or, for transcripts without toolUseResult
 * (workflow agents), from the PR URL a successful `gh pr create` printed.
 */
export async function scanSession(transcriptPath, cache, { concurrency = 8, now = Date.now } = {}) {
  const files = await sessionFiles(transcriptPath);
  const out = { created: [], links: [], pushes: [], worktrees: [], bad: 0, formatErrors: [], stats: { files: files.length, scanned: 0, bytes: 0 } };
  const wfNames = new Map();

  await mapLimit(files, concurrency, async (f) => {
    const r = await scanFile(f.path, cache.get(f.path));
    if (!r) return;
    if (r.changed) { cache.set(f.path, r.entry); out.stats.scanned++; out.stats.bytes += r.bytes; } else cache.touch(f.path);
    f.entry = r.entry;
    if (f.meta) {
      const m = await readSmall(f.meta, cache.get(f.meta), pickMeta);
      if (m) { if (m.changed) cache.set(f.meta, m.entry); else cache.touch(f.meta); f.metaV = m.entry.v; }
    }
    if (f.kind === "wf" && !wfNames.has(f.wfId)) {
      wfNames.set(f.wfId, null);
      const w = await readSmall(f.run, cache.get(f.run), pickWorkflow);
      if (w) { if (w.changed) cache.set(f.run, w.entry); else cache.touch(f.run); wfNames.set(f.wfId, w.entry.v.name ?? null); }
    }
  });

  for (const f of files) {
    if (!f.entry) continue;
    const e = { ...emptyEntry(), ...f.entry };
    e.gh = { ...emptyGh(), ...e.gh };
    out.bad += e.bad ?? 0;
    const by = byOf(f, wfNames.get(f.wfId));
    for (const p of e.prs) out.created.push({ n: p.n, url: p.url, cwd: p.cwd, by });
    for (const p of e.pushes) out.pushes.push({ branch: p.branch, cwd: p.cwd, by });
    if (f.kind === "main") for (const l of e.links) out.links.push(l);
    if (f.metaV?.worktreePath) out.worktrees.push({ path: f.metaV.worktreePath, by, branch0: f.metaV.worktreeBranch ?? null });
    // `gh pr create` ran, yet no result could be matched to it and no PR was found. A file that is still
    // being written may simply not have the result yet, so only a file at rest counts.
    if (e.gh.cmds > 0 && e.gh.ok === 0 && e.gh.err === 0 && e.prs.length === 0 && e.links.length === 0 && now() - (e.m ?? 0) > REST_MS) {
      out.formatErrors.push({
        file: f.path,
        message: `${e.gh.cmds} \`gh pr create\` call(s) but no result and no PR record could be read: Claude Code's transcript format may have changed`,
      });
    }
  }
  return out;
}

/** Who a file belongs to: the agent (main), a subagent (by name), or a workflow (by name). */
export function byOf(f, workflowName) {
  if (f.kind === "sub") {
    const v = f.metaV ?? {};
    return { kind: "subagent", name: v.name || v.description || v.agentType || "subagent" };
  }
  if (f.kind === "wf") return { kind: "workflow", name: workflowName || f.wfId };
  return { kind: "agent" };
}
