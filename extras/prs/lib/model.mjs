// The PR model, pure (no I/O): GitHub's answer -> one row; rows -> stacks, parents, count, problems.
// stateOf / checkResult / latestRuns / checkList come from the prototype's model.js.

const openish = (s) => s === "open" || s === "draft";

/** open | draft | merged | closed */
export function stateOf(pr) {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  return pr.isDraft ? "draft" : "open";
}

/** One check (CheckRun or StatusContext, as `statusCheckRollup` lists it) -> pass | fail | pending | skip. */
export function checkResult(c) {
  if (c.__typename === "StatusContext") {
    const s = c.state;
    return s === "SUCCESS" ? "pass" : s === "FAILURE" || s === "ERROR" ? "fail" : "pending";
  }
  if (c.status && c.status !== "COMPLETED") return "pending";
  const k = c.conclusion;
  if (k === "SUCCESS") return "pass";
  if (k === "SKIPPED" || k === "NEUTRAL" || k === "STALE") return "skip";
  if (k === "FAILURE" || k === "TIMED_OUT" || k === "CANCELLED" || k === "ACTION_REQUIRED" || k === "STARTUP_FAILURE") return "fail";
  return "pending";
}

/** The latest run of each check: a re-run leaves the superseded run in the rollup. */
export function latestRuns(rollup) {
  const by = new Map();
  for (const c of rollup ?? []) {
    const key = `${c.workflowName ?? ""}|${c.name ?? c.context ?? ""}`;
    const at = String(c.startedAt ?? c.createdAt ?? "");
    const cur = by.get(key);
    if (!cur || at > cur.at) by.set(key, { at, c });
  }
  return [...by.values()].map((x) => x.c);
}

const CHECK_ORDER = { fail: 0, pending: 1, pass: 2, skip: 3 };

/** `gh pr view --json statusCheckRollup` -> the checks list: latest runs, sorted fail, pending, pass (then skipped, when kept). */
export function checkList(rollup, { keepSkipped = false } = {}) {
  return latestRuns(rollup).map((c) => {
    const url = c.detailsUrl ?? c.targetUrl ?? null;
    const ids = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(url ?? "");
    return {
      name: c.name ?? c.context ?? "check",
      workflow: c.workflowName ?? "",
      result: checkResult(c),
      url,
      runId: ids ? ids[1] : null,
      jobId: ids?.[2] ?? null,
      seconds: c.startedAt && c.completedAt ? Math.max(0, Math.round((Date.parse(c.completedAt) - Date.parse(c.startedAt)) / 1000)) : null,
    };
  }).filter((c) => keepSkipped || c.result !== "skip")
    .sort((a, b) => CHECK_ORDER[a.result] - CHECK_ORDER[b.result] || a.name.localeCompare(b.name));
}

export function countChecks(list) {
  const n = { pass: 0, fail: 0, pending: 0, skip: 0 };
  for (const c of list) n[c.result]++;
  return n;
}

// CheckRunState / StatusState (GraphQL) -> bucket. Same mapping as checkResult.
const RUN_BUCKET = {
  SUCCESS: "pass", SKIPPED: "skip", NEUTRAL: "skip", STALE: "skip",
  FAILURE: "fail", TIMED_OUT: "fail", CANCELLED: "fail", ACTION_REQUIRED: "fail", STARTUP_FAILURE: "fail",
  IN_PROGRESS: "pending", PENDING: "pending", QUEUED: "pending", WAITING: "pending", COMPLETED: "skip",
};
const STATUS_BUCKET = { SUCCESS: "pass", FAILURE: "fail", ERROR: "fail", PENDING: "pending", EXPECTED: "pending" };

/**
 * The commit's check rollup (GraphQL, counts only) -> { state, pass, fail, pending, skip }.
 * `state` is GitHub's own word for the whole rollup (it knows which checks are required):
 * SUCCESS -> pass, FAILURE/ERROR -> fail, PENDING/EXPECTED -> pending; no rollup -> none.
 */
export function checksOf(rollup) {
  const out = { state: "none", pass: 0, fail: 0, pending: 0, skip: 0 };
  if (!rollup) return out;
  for (const x of rollup.contexts?.checkRunCountsByState ?? []) out[RUN_BUCKET[x.state] ?? "pending"] += x.count ?? 0;
  for (const x of rollup.contexts?.statusContextCountsByState ?? []) out[STATUS_BUCKET[x.state] ?? "pending"] += x.count ?? 0;
  const s = rollup.state;
  out.state = s === "SUCCESS" ? "pass" : s === "FAILURE" || s === "ERROR" ? "fail" : s === "PENDING" || s === "EXPECTED" ? "pending" : "none";
  return out;
}

/** approved | changes | required | none */
export function reviewOf(pr) {
  return { APPROVED: "approved", CHANGES_REQUESTED: "changes", REVIEW_REQUIRED: "required" }[pr.reviewDecision] ?? "none";
}

/** One GraphQL PullRequest node -> a row of the data file (without parent, stack and by). */
export function toRow(node, repo) {
  const commit = node.commits?.nodes?.[0]?.commit;
  const state = stateOf(node);
  const row = {
    repo,
    number: node.number,
    title: node.title ?? "",
    url: node.url ?? `https://github.com/${repo}/pull/${node.number}`,
    author: node.author?.login ?? null,
    state,
    head: node.headRefName ?? null,
    base: node.baseRefName ?? null,
    headOid: node.headRefOid ?? commit?.oid ?? null,
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? null,
    mergedAt: node.mergedAt ?? null,
    closedAt: node.closedAt ?? null,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    changedFiles: node.changedFiles ?? 0,
    review: reviewOf(node),
    mergeState: node.mergeStateStatus ?? null,
    // GitHub leaves "CONFLICTING" on merged PRs whose base moved on: a conflict only counts while the PR is open.
    conflicts: openish(state) && node.mergeable === "CONFLICTING",
    autoMerge: Boolean(node.autoMergeRequest),
    checks: checksOf(commit?.statusCheckRollup),
    parent: null,
    stack: null,
    by: [],
  };
  // Not written to the file: the stack the PR is a native member of.
  Object.defineProperty(row, "_native", {
    enumerable: false, writable: true, configurable: true,
    value: node.stack?.number != null ? { number: node.stack.number, position: node.stackEntry?.position ?? null, total: node.stack.entries?.totalCount ?? null } : null,
  });
  return row;
}

/** A row from the previous data file, ready to be linked again (its native stack is kept in `stack`). */
export function reviveRow(old) {
  const row = { ...old, parent: null, stack: null, by: [] };
  Object.defineProperty(row, "_native", {
    enumerable: false, writable: true, configurable: true,
    value: old.stack?.native ? { number: Number(String(old.stack.id).split("#").pop()), position: old.stack.position ?? null, total: null } : null,
  });
  return row;
}

// ---- stacks ----------------------------------------------------------------------------------

/**
 * Sets `parent` and `stack` on the rows (same repo only).
 *  - A native stack member sits on the member one position lower.
 *  - Any other PR sits on the PR whose head is its base (an open one before a merged or closed
 *    one with the same head; the newest among equals). A loop is cut at its smallest number.
 *  - Stack id: "<repo>#<native stack number>" (native), or "<repo>~<root pr number>" for a chain
 *    of 2 or more (position = 1 at the root, counted along the path).
 * Returns the rows, sorted: stacks first (newest change first, bottom up), then single PRs (newest first).
 */
export function linkRows(rows) {
  const repos = [...new Set(rows.map((r) => r.repo))];
  for (const repo of repos) linkRepo(rows.filter((r) => r.repo === repo));
  return sortRows(rows);
}

function linkRepo(rows) {
  const byNumber = new Map(rows.map((r) => [r.number, r]));
  const rank = (r) => (openish(r.state) ? 0 : 1);
  const byHead = new Map();
  for (const r of rows) {
    if (!r.head) continue;
    const cur = byHead.get(r.head);
    if (!cur || rank(r) < rank(cur) || (rank(r) === rank(cur) && String(r.updatedAt) > String(cur.updatedAt))) byHead.set(r.head, r);
  }
  const natives = new Map(); // stack number -> members sorted by position
  for (const r of rows) {
    if (!r._native || r._native.position == null) continue;
    if (!natives.has(r._native.number)) natives.set(r._native.number, []);
    natives.get(r._native.number).push(r);
  }
  for (const list of natives.values()) list.sort((a, b) => a._native.position - b._native.position);

  const parentOf = new Map();
  for (const r of rows) {
    let up = null;
    if (r._native?.position != null) {
      const lower = natives.get(r._native.number).filter((m) => m._native.position < r._native.position);
      up = lower[lower.length - 1] ?? null;
    }
    if (!up && r.base) { const c = byHead.get(r.base); if (c && c !== r) up = c; }
    if (up) parentOf.set(r.number, up.number);
  }
  cutLoops(rows, parentOf);

  const rootOf = (n) => { let cur = n, guard = 0; while (parentOf.has(cur) && guard++ < 1000) cur = parentOf.get(cur); return cur; };
  const depthOf = (n) => { let d = 1, cur = n, guard = 0; while (parentOf.has(cur) && guard++ < 1000) { cur = parentOf.get(cur); d++; } return d; };
  const size = new Map();
  for (const r of rows) size.set(rootOf(r.number), (size.get(rootOf(r.number)) ?? 0) + 1);

  for (const r of rows) {
    r.parent = parentOf.get(r.number) ?? null;
    r.stack = null;
    if (r._native) {
      r.stack = { id: `${r.repo}#${r._native.number}`, native: true, position: r._native.position };
      continue;
    }
    const root = byNumber.get(rootOf(r.number));
    if (root._native) { r.stack = { id: `${r.repo}#${root._native.number}`, native: false, position: null }; continue; }
    if (size.get(root.number) > 1) r.stack = { id: `${r.repo}~${root.number}`, native: false, position: depthOf(r.number) };
  }
}

function cutLoops(rows, parentOf) {
  const state = new Map(); // number -> 1 (on path) | 2 (done)
  for (const r of [...rows].sort((a, b) => a.number - b.number)) {
    const path = [];
    let cur = r.number;
    while (cur != null && !state.has(cur)) { state.set(cur, 1); path.push(cur); cur = parentOf.get(cur); }
    if (cur != null && state.get(cur) === 1) {
      const loop = path.slice(path.indexOf(cur));
      parentOf.delete(Math.min(...loop));
    }
    for (const n of path) state.set(n, 2);
  }
}

function sortRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.stack?.id ?? `single:${r.repo}#${r.number}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const newest = (g) => g.reduce((m, r) => (String(r.updatedAt) > m ? String(r.updatedAt) : m), "");
  const list = [...groups.entries()].map(([key, g]) => ({ key, g, stacked: g[0].stack != null, at: newest(g) }));
  list.sort((a, b) => Number(b.stacked) - Number(a.stacked) || b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
  const out = [];
  for (const { g } of list) {
    g.sort((a, b) => (a.stack?.position ?? Infinity) - (b.stack?.position ?? Infinity) || a.number - b.number);
    out.push(...g);
  }
  return out;
}

// ---- who made it ---------------------------------------------------------------------------------

const KIND_ORDER = { worktree: 0, agent: 1, subagent: 2, workflow: 3, other: 4 };

export function byKey(b) { return `${b.kind}:${b.name ?? ""}`; }

/** Merges `by` lists: de-duplicated, ordered worktree, agent, subagent, workflow, other. */
export function mergeBy(...lists) {
  const seen = new Map();
  for (const list of lists) for (const b of list ?? []) if (!seen.has(byKey(b))) seen.set(byKey(b), b);
  const out = [...seen.values()];
  if (out.length > 1) return out.filter((b) => b.kind !== "other").sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || String(a.name ?? "").localeCompare(String(b.name ?? "")));
  return out;
}

// ---- the badge --------------------------------------------------------------------------------------

/** { count, problems } over the open and draft PRs that someone of this agent made (not only "other"). */
export function summarize(rows) {
  const mine = rows.filter((r) => openish(r.state) && r.by.some((b) => b.kind !== "other"));
  return {
    count: mine.length,
    problems: mine.filter((r) => r.checks.state === "fail" || r.conflicts).length,
  };
}
