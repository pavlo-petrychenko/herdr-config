// `herdr-prs refresh <terminal>`: find the PRs of the agent in a terminal and write
// <home>/data/prs/<terminal>.json. See FORMAT.md.
//
//   sessions    hook file + the live session + --session      (sessions.mjs)
//   evidence    PRs created, pushed branches, subagent worktrees, the terminal's worktree  (transcripts.mjs, git.mjs)
//   github      one graphql call per repo; search by head branch when discovering; native stack members (github.mjs)
//   rows        model.mjs: rows, parents, stacks, `by`, count, problems
// Nothing here fails the command: what went wrong goes into `errors`, and the last good PRs stay (stale).
import path from "node:path";
import { appHome, claudeHome, mapLimit, parsePrUrl, prKey, readJson, safeName, uniq, writeAtomic } from "./util.mjs";
import { Deadline, makeRunner } from "./run.mjs";
import { ScanCache, cacheDir } from "./cache.mjs";
import { findSessions } from "./sessions.mjs";
import { scanSession } from "./transcripts.mjs";
import { DEFAULT_BRANCHES, isPlaceholderBranch, makeGit } from "./git.mjs";
import { MAX_ALIASES, fetchPrs, fetchStackEntries, searchQueries } from "./github.mjs";
import { linkRows, mergeBy, reviveRow, summarize, toRow, withinCreation } from "./model.mjs";

const MAX_STACK_EXTRA = 40; // PRs added to complete stacks and base chains, per repo
const MAX_ERRORS = 30;
const NO_STACK_MS = 60 * 60 * 1000; // after a "no stack fields" answer, do not ask again for an hour
const MAX_REJECTED = 1000;
const FULL_CHECK_MS = 60 * 60 * 1000; // merged and closed PRs are asked for again this often

/** Whether `p` is `folder` or a folder below it. */
export function insideFolder(p, folder) {
  if (typeof p !== "string" || typeof folder !== "string" || !p || !folder) return false;
  const norm = (x) => x.replace(/\/+$/, "");
  const a = norm(p), b = norm(folder);
  return a === b || a.startsWith(`${b}/`);
}

export const dataFile = (home, terminal) => path.join(home, "data/prs", `${safeName(terminal)}.json`);
const discoverFile = (home, terminal) => path.join(cacheDir(home), "discover", `${safeName(terminal)}.json`);
/** Key of a transcript claim judged not real: the session that made it and the PR it named. */
const claimKey = (session, repo, number) => `${session}|${prKey(repo, number)}`;
const ghStateFile = (home) => path.join(cacheDir(home), "gh.json");

/**
 * Never throws for what the world does: a bug or a surprise in one part becomes an `internal` error and the
 * last good file is kept (stale), so the view has something to show and the exit code stays 0.
 */
export async function refresh(opts) {
  try {
    return await refreshNow(opts);
  } catch (e) {
    const env = opts.env ?? process.env;
    const now = opts.now ?? Date.now;
    const home = opts.home ?? appHome(env);
    const old = readJson(dataFile(home, opts.terminal), null);
    const keep = old?.version === 1 && Array.isArray(old.prs) ? old : null;
    const out = {
      version: 1, at: new Date(now()).toISOString(), terminal: opts.terminal, stale: true,
      worktree: keep?.worktree ?? null, sessions: keep?.sessions ?? [], repos: keep?.repos ?? [], prs: keep?.prs ?? [],
      count: keep?.count ?? 0, problems: keep?.problems ?? 0, branches: keep?.branches ?? [], discoveredAt: keep?.discoveredAt ?? null,
      errors: [{ kind: "internal", message: String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ").slice(0, 400) }],
    };
    writeAtomic(dataFile(home, opts.terminal), JSON.stringify(out));
    return out;
  }
}

async function refreshNow(opts) {
  const { terminal, discover = false, sessionArgs = [], cwdArg = null, env = process.env, now = Date.now } = opts;
  const home = opts.home ?? appHome(env);
  const claudeDir = opts.claudeDir ?? claudeHome(env);
  const deadline = new Deadline(opts.deadlineMs ?? 24000, now);
  const run = opts.run ?? makeRunner({ deadline, env });
  const outFile = dataFile(home, terminal);
  const errors = [];
  const t0 = now();
  const lap = (what) => { if (env.HERDR_PRS_DEBUG) process.stderr.write(`[prs] ${String(now() - t0).padStart(5)} ms  ${what}\n`); };
  const fail = (kind, message, extra = {}) => errors.push({ kind, message, ...extra });

  let prev = readJson(outFile, null);
  if (prev?.version !== 1 || !Array.isArray(prev.prs)) prev = null;
  const cache = new ScanCache(path.join(cacheDir(home), "scan.json"), now);
  const git = makeGit(run, cache, opts.exists);
  const disc = loadDiscover(home, terminal);

  // ---- sessions and worktree ---------------------------------------------------------------------------
  let found = { sessions: [], live: null, fgCwd: null, hookCwd: null, errors: [] };
  try { found = await findSessions({ terminal, home, claudeDir, run, args: sessionArgs }); } catch (e) { fail("session", `could not find sessions: ${e.message}`); }
  errors.push(...found.errors);

  lap(`sessions: ${found.sessions.length}`);
  const wtPath = cwdArg || found.fgCwd || found.live?.cwd || found.hookCwd || null;
  let worktree = null;
  let wtBranches = [];
  if (wtPath) {
    const [repo, b] = await Promise.all([git.repoOfPath(wtPath), git.branchOfPath(wtPath)]);
    worktree = { path: wtPath, branch: b.branch, repo };
    wtBranches = uniq([b.branch, b.upstream].filter(Boolean));
  }

  // ---- what the transcripts hold -------------------------------------------------------------------------
  const ev = { created: [], links: [], pushes: [], worktrees: [] };
  let bad = 0, badFiles = 0;
  const scans = await mapLimit(found.sessions, 2, async (s) => {
    try { return await scanSession(s.transcriptPath, cache, { now }); } catch (e) { fail("scan", `could not read ${s.transcriptPath}: ${e.message}`, { file: s.transcriptPath }); return null; }
  });
  scans.forEach((sc, i) => {
    if (!sc) return;
    const session = found.sessions[i].sessionId;
    ev.created.push(...sc.created.map((c) => ({ ...c, session }))); ev.links.push(...sc.links.map((l) => ({ ...l, session })));
    ev.pushes.push(...sc.pushes); ev.worktrees.push(...sc.worktrees);
    if (sc.bad) { bad += sc.bad; badFiles++; }
    for (const f of sc.formatErrors) fail("transcript-format", f.message, { file: f.file });
  });
  if (bad) fail("transcript-parse", `${bad} unparseable transcript line(s) skipped in ${badFiles} file(s)`);

  lap(`scanned: ${scans.filter(Boolean).reduce((n, x) => n + x.stats.scanned, 0)} file(s) read`);
  // PR numbers per repo, and who made each.
  const pathOfRepo = new Map(); // repo -> a folder of it that exists (for origin/HEAD)
  const repoOf = async (p) => { const repo = await git.repoOfPath(p); if (repo && !pathOfRepo.has(repo)) pathOfRepo.set(repo, p); return repo; };
  // What the transcripts claim about each PR: { kind: "created" | "link", by, ts (record times), session }.
  // A claim is only believed once GitHub has said when the PR was made (see "who made each").
  const claims = new Map(); // repo#n -> claim[]
  const known = new Map(); // repo -> Set(number)
  const know = (repo, n) => { if (!known.has(repo)) known.set(repo, new Set()); known.get(repo).add(n); };
  const claim = (repo, n, c) => {
    if (disc.rejected[claimKey(c.session, repo, n)]) return; // judged not real before: do not fetch it again
    const k = prKey(repo, n);
    if (!claims.has(k)) claims.set(k, []);
    claims.get(k).push(c);
    know(repo, n);
  };
  for (const c of ev.created) {
    const repo = parsePrUrl(c.url)?.repo ?? (await repoOf(c.cwd));
    if (repo) claim(repo, c.n, { kind: "created", by: c.by, cwd: c.cwd ?? null, ts: c.ts, session: c.session });
  }
  for (const l of ev.links) claim(l.repo, l.n, { kind: "link", by: { kind: "agent" }, ts: l.ts, session: l.session });

  // Branches: pushed by the agent, its subagents and workflows; their worktrees; the terminal's worktree.
  const branchBy = new Map(); // "repo|branch" -> by[]
  const addBranch = (repo, branch, by) => {
    if (!repo || !branch || DEFAULT_BRANCHES.has(branch) || isPlaceholderBranch(branch)) return;
    const k = `${repo}|${branch}`;
    branchBy.set(k, mergeBy(branchBy.get(k), [by]));
  };
  await mapLimit(ev.pushes, 8, async (p) => addBranch(await repoOf(p.cwd), p.branch, p.by));
  await mapLimit(ev.worktrees, 8, async (w) => {
    const [repo, b] = await Promise.all([repoOf(w.path), git.branchOfPath(w.path)]);
    addBranch(repo, b.upstream ?? b.branch, w.by);
  });
  if (worktree?.repo) addBranch(worktree.repo, wtBranches[wtBranches.length - 1], { kind: "worktree" });
  // Also drop the repo's own default branch (develop and trunk are skipped by name; others by origin/HEAD).
  if (worktree?.repo && wtPath && !pathOfRepo.has(worktree.repo)) pathOfRepo.set(worktree.repo, wtPath);
  for (const k of [...branchBy.keys()]) {
    const i = k.indexOf("|");
    const repo = k.slice(0, i);
    const def = await git.defaultBranchOf(repo, pathOfRepo.get(repo));
    if (def && def === k.slice(i + 1)) branchBy.delete(k);
  }
  const branches = [...branchBy.keys()].map((k) => { const i = k.indexOf("|"); return { repo: k.slice(0, i), name: k.slice(i + 1) }; })
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
  for (const b of branches) if (!known.has(b.repo)) known.set(b.repo, new Set());

  const unsearched = branches.filter((b) => !(disc.searched[b.repo] ?? []).includes(b.name));
  const doDiscover = discover || unsearched.length > 0;

  lap(`branches: ${branches.length}, discover: ${doDiscover}`);
  // ---- GitHub ---------------------------------------------------------------------------------------------
  const ghState = readJson(ghStateFile(home), {});
  const stackOk = !(ghState.noStack && now() - ghState.noStack < NO_STACK_MS);
  const repos = uniq([...known.keys(), ...Object.keys(disc.numbers)]).sort();
  let staleParts = false;
  let stackUnsupportedSeen = false;
  const rates = [];

  // Merged and closed PRs hardly ever change (and their check counts are the slow part of the query):
  // keep their rows from the last file, and ask for them again once an hour.
  const full = !prev || !disc.fullAt || now() - Date.parse(disc.fullAt) > FULL_CHECK_MS;
  const frozenRows = new Map(); // repo -> Map(number -> row)
  if (!full) {
    for (const r of prev.prs) {
      if (r.state !== "merged" && r.state !== "closed") continue;
      if (!frozenRows.has(r.repo)) frozenRows.set(r.repo, new Map());
      frozenRows.get(r.repo).set(r.number, r);
    }
  }
  const results = await mapLimit(repos, 3, async (repo) => {
    const rb = branches.filter((b) => b.repo === repo).map((b) => b.name);
    try {
      return await fetchRepo({ run, repo, known: known.get(repo) ?? new Set(), disc, rb, doDiscover, stackOk, defaults: cache.defaults, frozen: frozenRows.get(repo) ?? new Map() });
    } catch (e) {
      return { repo, nodes: new Map(), frozen: [], errors: [`internal: ${e.message}`], failure: null, failed: new Set(known.get(repo) ?? []), stackUnsupported: false };
    }
  });
  const rows = [];
  const have = new Set();
  for (const r of results) {
    for (const [n, node] of r.nodes) { rows.push(toRow(node, r.repo)); have.add(prKey(r.repo, n)); }
    if (r.failure) { fail("gh", r.failure); staleParts = true; }
    for (const m of r.errors) fail("github", `${r.repo}: ${m}`);
    for (const old of r.frozen) { if (!have.has(prKey(r.repo, old.number))) { rows.push(reviveRow(old)); have.add(prKey(r.repo, old.number)); } }
    // Nothing came back for this repo: keep all its rows from the last file. Else only the ones that failed.
    const lost = r.failure && !r.nodes.size ? (prev?.prs ?? []).filter((p) => p.repo === r.repo).map((p) => p.number) : [...r.failed];
    for (const n of lost) {
      const old = prev?.prs.find((p) => p.repo === r.repo && p.number === n);
      if (old && !have.has(prKey(r.repo, n))) { rows.push(reviveRow(old)); have.add(prKey(r.repo, n)); staleParts = true; }
    }
    if (r.stackUnsupported) stackUnsupportedSeen = true;
    if (r.rate) rates.push(r.rate);
  }
  const lowest = rates.reduce((m, r) => (m == null || r.remaining < m.remaining ? r : m), null);
  if (lowest && lowest.remaining < 200) fail("github", `GitHub rate limit is low: ${lowest.remaining} calls left until ${lowest.resetAt}`);
  if (stackUnsupportedSeen && stackOk) { try { writeAtomic(ghStateFile(home), JSON.stringify({ noStack: now() })); } catch { /* cache only */ } }
  lap("github done");

  // ---- who made each ------------------------------------------------------------------------------------------
  // A "created" record or a pr-link counts only when it was written about when GitHub made the PR. Claude Code
  // writes them as well when a tool result merely prints an old `gh pr create` or PR URL (a subagent that reads
  // other transcripts), which would give this agent PRs it never made. A branch it pushed counts as before.
  const rejectedNow = new Set();
  for (const row of rows) {
    const key = prKey(row.repo, row.number);
    const all = claims.get(key) ?? [];
    const real = all.filter((c) => withinCreation(row.createdAt, c.ts));
    const realSessions = new Set(real.map((c) => c.session));
    for (const c of all) if (!realSessions.has(c.session)) rejectedNow.add(claimKey(c.session, row.repo, row.number));
    const created = real.filter((c) => c.kind === "created").map((c) => c.by);
    let by = created;
    if (!by.length) by = real.length ? [{ kind: "agent" }] : branchBy.get(`${row.repo}|${row.head}`) ?? [];
    if (worktree?.repo === row.repo && wtBranches.includes(row.head) && !DEFAULT_BRANCHES.has(row.head)) by = mergeBy(by, [{ kind: "worktree" }]);
    // The main agent made it while it worked in this worktree's folder: a coordinator opens no PR from its own
    // branch, but the PRs it made from here belong to the worktree too. Subagents and workflows work elsewhere.
    if (worktree?.path && real.some((c) => c.kind === "created" && c.by?.kind === "agent" && insideFolder(c.cwd, worktree.path))) by = mergeBy(by, [{ kind: "worktree" }]);
    row.by = mergeBy(by);
  }
  const linkedRows = linkRows(rows);
  // A PR nobody made is in the file only as a neighbour: in the stack or base chain of one that someone did.
  const keptStacks = new Set(linkedRows.filter((r) => r.by.length && r.stack).map((r) => r.stack.id));
  const dropped = new Set(); // repo#n
  const droppedStacks = new Set();
  const finalRows = [];
  for (const r of linkedRows) {
    if (r.by.length) finalRows.push(r);
    else if (r.stack && keptStacks.has(r.stack.id)) { r.by = [{ kind: "other" }]; finalRows.push(r); }
    else { dropped.add(prKey(r.repo, r.number)); if (r.stack) droppedStacks.add(r.stack.id); }
  }
  const { count, problems } = summarize(finalRows);
  lap(`rows: ${finalRows.length}, dropped: ${dropped.size}, claims rejected: ${rejectedNow.size}`);

  // ---- save the lookups, write the file ----------------------------------------------------------------------
  if (full && !errors.some((e) => e.kind === "gh")) disc.fullAt = new Date(now()).toISOString();
  if (doDiscover && !errors.some((e) => e.kind === "gh")) {
    for (const b of branches) {
      const list = disc.searched[b.repo] ?? (disc.searched[b.repo] = []);
      if (!list.includes(b.name)) list.push(b.name);
    }
    disc.at = new Date(now()).toISOString();
  }
  for (const r of results) {
    if (r.discoveredNumbers?.length) disc.numbers[r.repo] = uniq([...(disc.numbers[r.repo] ?? []), ...r.discoveredNumbers]).sort((a, b) => a - b);
    for (const [id, s] of Object.entries(r.stacks ?? {})) disc.stacks[id] = s;
  }
  // What was dropped is not looked up again: not its number, not its stack, not the claim that named it.
  for (const repo of Object.keys(disc.numbers)) disc.numbers[repo] = disc.numbers[repo].filter((n) => !dropped.has(prKey(repo, n)));
  for (const id of droppedStacks) delete disc.stacks[id];
  for (const [id, st] of Object.entries(disc.stacks)) {
    const repo = id.slice(0, id.lastIndexOf("#"));
    if ((st.members ?? []).length && st.members.every((n) => dropped.has(prKey(repo, n)))) delete disc.stacks[id];
  }
  for (const k of rejectedNow) disc.rejected[k] = new Date(now()).toISOString();
  const keepRejected = Object.entries(disc.rejected).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, MAX_REJECTED);
  disc.rejected = Object.fromEntries(keepRejected);
  try { writeAtomic(discoverFile(home, terminal), JSON.stringify(disc)); } catch (e) { fail("cache", `could not save the discovery cache: ${e.message}`); }
  cache.save();

  const out = {
    version: 1,
    at: new Date(now()).toISOString(),
    terminal,
    stale: staleParts,
    worktree,
    sessions: found.sessions.map(({ sessionId, transcriptPath, from }) => ({ sessionId, transcriptPath, from })),
    repos: uniq([...finalRows.map((r) => r.repo), ...(worktree?.repo ? [worktree.repo] : []), ...branches.map((b) => b.repo)]).sort(),
    prs: finalRows,
    count,
    problems,
    branches,
    discoveredAt: disc.at ?? null,
    errors: dedupeErrors(errors),
  };
  writeAtomic(outFile, JSON.stringify(out));
  lap("written");
  return out;
}

function dedupeErrors(errors) {
  const seen = new Set();
  const out = [];
  for (const e of errors) {
    const k = `${e.kind}|${e.message}|${e.file ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out.slice(0, MAX_ERRORS);
}

function loadDiscover(home, terminal) {
  const raw = readJson(discoverFile(home, terminal), null);
  const ok = raw && raw.version === 1;
  return { version: 1, at: ok ? raw.at ?? null : null, fullAt: ok ? raw.fullAt ?? null : null, searched: ok ? raw.searched ?? {} : {}, numbers: ok ? raw.numbers ?? {} : {}, stacks: ok ? raw.stacks ?? {} : {}, rejected: ok ? raw.rejected ?? {} : {} };
}

/**
 * All GitHub work for one repo.
 *   round 1  the known numbers + cached stack members (+ the head-branch searches when discovering)
 *   round 2  native stacks whose member list is unknown or changed: ask the members, fetch the missing PRs
 *   round 3  base chains of PRs that are in no native stack (only when discovering): search for the PR
 *            that holds the base branch and for PRs based on the head branch
 * Returns { repo, nodes, errors, failure, failed (numbers that could not be fetched), stackUnsupported,
 *           rate, discoveredNumbers, stacks, discovered }.
 */
export async function fetchRepo({ run, repo, known, disc, rb, doDiscover, stackOk, defaults = {}, frozen = new Map() }) {
  const res = { repo, nodes: new Map(), frozen: [], errors: [], failure: null, failed: new Set(), stackUnsupported: false, rate: null, discoveredNumbers: [], stacks: {}, discovered: false };
  const absorb = (r) => {
    for (const [n, node] of r.nodes) res.nodes.set(n, node);
    res.errors.push(...r.errors);
    if (r.failure) res.failure = r.failure;
    for (const n of r.failedNumbers ?? []) res.failed.add(n);
    if (r.stackUnsupported) res.stackUnsupported = true;
    if (r.rate) res.rate = r.rate;
  };

  // A cached stack stays cached while any of its PRs is here (all of them may be frozen and not asked for).
  const keepCachedStacks = () => {
    for (const [id, st] of Object.entries(disc.stacks)) {
      if (id.startsWith(`${repo}#`) && (st.members ?? []).some((n) => frozen.has(n) || res.nodes.has(n))) res.stacks[id] = st;
    }
  };

  // Round 1
  const want = new Set(known);
  for (const n of disc.numbers[repo] ?? []) want.add(n);
  for (const [id, s] of Object.entries(disc.stacks)) if (id.startsWith(`${repo}#`)) for (const n of s.members ?? []) want.add(n);
  // Rows kept from the last file are not asked for again.
  for (const n of [...want]) if (frozen.has(n)) { want.delete(n); res.frozen.push(frozen.get(n)); }
  const headSearches = doDiscover ? searchQueries(repo, "head", rb) : [];
  if (!want.size && !headSearches.length) { keepCachedStacks(); return res; }
  const r1 = await fetchPrs(run, repo, { numbers: [...want], searches: headSearches, stack: stackOk });
  absorb(r1);
  if (!r1.failure) {
    const hit = uniq(r1.hits.flat());
    if (hit.length) { res.discoveredNumbers.push(...hit); res.discovered = true; }
  }
  if (res.failure && !res.nodes.size) return res;
  keepCachedStacks();

  const budget = { left: MAX_STACK_EXTRA };
  /** Fetches PRs that searches or stacks named and that are not here yet. */
  const fetchMissing = async (numbers, limit) => {
    const todo = uniq(numbers).filter((n) => !res.nodes.has(n) && !res.failed.has(n));
    for (const n of [...todo]) if (frozen.has(n)) { todo.splice(todo.indexOf(n), 1); if (!res.frozen.some((r) => r.number === n)) res.frozen.push(frozen.get(n)); }
    const take = todo.slice(0, limit);
    if (take.length) absorb(await fetchPrs(run, repo, { numbers: take, stack: stackOk && !res.stackUnsupported }));
    return take;
  };

  // The PRs the head-branch searches found that were not asked for by number.
  await fetchMissing(r1.hits.flat(), MAX_ALIASES);

  // Round 2: complete native stacks
  const nativeOk = stackOk && !res.stackUnsupported;
  if (nativeOk) {
    const seen = new Map(); // stack number -> { total, rep }
    for (const [n, node] of res.nodes) {
      if (!node.stack?.number) continue;
      if (!seen.has(node.stack.number)) seen.set(node.stack.number, { total: node.stack.entries?.totalCount ?? null, rep: n });
    }
    const ask = [];
    for (const [sn, s] of seen) {
      const cached = disc.stacks[`${repo}#${sn}`];
      if (cached && cached.total === s.total) res.stacks[`${repo}#${sn}`] = cached;
      else ask.push({ stack: sn, number: s.rep });
    }
    if (ask.length) {
      const e = await fetchStackEntries(run, repo, ask);
      res.errors.push(...e.errors);
      if (e.failure) res.failure = res.failure ?? e.failure;
      for (const [sn, members] of e.members) {
        res.stacks[`${repo}#${sn}`] = { total: seen.get(sn)?.total ?? members.length, members: members.map((m) => m.number) };
      }
    }
    const members = Object.values(res.stacks).flatMap((s) => s.members);
    const took = await fetchMissing(members, budget.left);
    budget.left -= took.length;
  }

  // Round 3: base chains for PRs outside native stacks
  if (doDiscover) {
    for (let level = 0; level < 2 && budget.left > 0; level++) {
      const heads = new Set([...res.nodes.values()].map((n) => n.headRefName));
      const open = [...res.nodes.values()].filter((n) => n.state === "OPEN" && !n.stack?.number);
      const skip = new Set([...DEFAULT_BRANCHES, defaults[repo]].filter(Boolean));
      const upBases = uniq(open.map((n) => n.baseRefName)).filter((b) => b && !skip.has(b) && !heads.has(b));
      const downHeads = uniq(open.map((n) => n.headRefName)).filter((h) => h && !skip.has(h));
      const searches = [...searchQueries(repo, "head", upBases), ...searchQueries(repo, "base", downHeads)];
      if (!searches.length) break;
      const r = await fetchPrs(run, repo, { searches, stack: false });
      res.errors.push(...r.errors);
      if (r.failure) res.failure = res.failure ?? r.failure;
      if (r.rate) res.rate = r.rate;
      const took = await fetchMissing(r.hits.flat(), budget.left);
      budget.left -= took.length;
      res.discoveredNumbers.push(...took.filter((n) => res.nodes.has(n)));
      if (!took.length) break;
    }
  }
  return res;
}
