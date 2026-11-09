// The PRs view's decisions, pure (no Herdr imports): node tests load it (`node --test mods/prs/test/`).
//   rows      a PR from the data file (extras/prs/FORMAT.md): state, checks, review, merge, who made it
//   scopes    Worktree (the PRs of this worktree's branch) and Agent (everything the agent's work made)
//   groups    stacks (rows chained by `parent`) and single PRs; merged PRs stay in their stack, dimmed;
//             closed PRs and finished work hide behind the "done" toggle
//   items     the list the view draws: section titles, stack heads, base rows, PR rows, "n more" rows
//   timing    when the view asks `herdr-prs` for fresh data

export const SCOPES = [
  { key: "worktree", label: "Worktree", icon: "folder-git", tip: "PRs from this worktree's branch" },
  { key: "agent", label: "Agent", icon: "bot", tip: "PRs this agent, its subagents or its workflows made" },
];
const BASES = new Set(["main", "master", "develop", "trunk"]);
const LIVE = new Set(["open", "draft"]);

// ---- one PR ----------------------------------------------------------------------------------

export const idOf = (pr) => `${pr.repo}#${pr.number}`;
export const isLive = (pr) => LIVE.has(pr?.state);

/** open | draft | merged | closed */
export const stateOf = (pr) => (["open", "draft", "merged", "closed"].includes(pr?.state) ? pr.state : "open");

/** pass | fail | pending | none: GitHub's own word for the head commit (the counts include superseded runs). */
export const checksOf = (pr) => (["pass", "fail", "pending"].includes(pr?.checks?.state) ? pr.checks.state : "none");

/** approved | changes | required | none */
export const reviewOf = (pr) => (["approved", "changes", "required"].includes(pr?.review) ? pr.review : "none");

/** What stands between the PR and a merge, for people: { key, label, short }. */
export function mergeOf(pr) {
  const st = stateOf(pr);
  if (st === "merged") return { key: "merged", label: "Merged", short: "Merged" };
  if (st === "closed") return { key: "closed", label: "Closed without merge", short: "Closed" };
  const m = pr.mergeState;
  if (pr.conflicts || m === "DIRTY") return { key: "conflicts", label: "Conflicts with the base", short: "Conflicts" };
  if (m === "BEHIND") return { key: "behind", label: "Behind the base", short: "Behind" };
  if (m === "BLOCKED") return { key: "blocked", label: "Blocked by branch rules (a required check or review)", short: "Blocked" };
  if (m === "UNSTABLE") return { key: "unstable", label: "Mergeable, but checks are not green", short: "Unstable" };
  if (m === "DRAFT" || st === "draft") return { key: "draft", label: "A draft: not ready to merge", short: "Draft" };
  if (m === "CLEAN" || m === "HAS_HOOKS") return { key: "clean", label: "Ready to merge", short: "Ready" };
  return { key: "unknown", label: "Merge state unknown", short: "Unknown" };
}

const AREA = /^\s*\[([^\]]+)\]\s*:?\s*/;
const TICKET = /\s*\(([A-Z]+-\d+)\)\s*$/;

/** "[Area H | Topic 5]: Run the chain (T-6)" -> { area, text, ticket }. */
export function splitTitle(title) {
  let text = String(title ?? "");
  let area = "", ticket = "";
  const a = AREA.exec(text);
  if (a) { area = a[1].trim(); text = text.slice(a[0].length); }
  const t = TICKET.exec(text);
  if (t) { ticket = t[1]; text = text.slice(0, t.index); }
  return { area, text: text.trim() || String(title ?? ""), ticket };
}

/** "3m", "5h", "2d", "3w", "4mo" since iso, at `now` (ms). */
export function age(iso, now = Date.now()) {
  const ms = now - Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return "";
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d`;
  if (d < 60) return `${Math.round(d / 7)}w`;
  return `${Math.round(d / 30)}mo`;
}

/** The footer's "Updated 20 s ago". Steps of 10 s, so the text changes rarely. */
export function updatedLabel(iso, now = Date.now()) {
  const ms = now - Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 10) return "Updated just now";
  if (s < 60) return `Updated ${Math.floor(s / 10) * 10} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `Updated ${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `Updated ${h} h ago` : `Updated ${Math.floor(h / 24)} d ago`;
}

/** A PR body for the markdown view: no HTML comments, <details> opened up. */
export function cleanBody(s) {
  return String(s ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<summary>([\s\S]*?)<\/summary>/g, "**$1**\n")
    .replace(/<\/?details>/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

// ---- the data file -------------------------------------------------------------------------------

/** The file's text -> { data } or { error }. A file with another version is ignored. */
export function parseData(raw) {
  let d;
  try { d = JSON.parse(raw); } catch { return { error: "The data file is not valid JSON." }; }
  if (d?.version !== 1) return { error: "The data file has a version this view does not know." };
  if (!Array.isArray(d.prs)) return { error: "The data file has no PR list." };
  return { data: { ...d, errors: Array.isArray(d.errors) ? d.errors : [], stale: Boolean(d.stale) } };
}

/** The first error of the file, with how many more there are: { text, more } or null. */
export function errorLine(errors) {
  if (!errors?.length) return null;
  return { text: String(errors[0].message ?? errors[0].kind ?? "Something went wrong"), kind: errors[0].kind ?? "", more: errors.length - 1 };
}

// ---- who made it -----------------------------------------------------------------------------------

/** The creators a filter chip can name: agent, each subagent, each workflow: [{ key, kind, label, tip }]. */
export function makersOf(pr) {
  const out = [];
  for (const b of pr.by ?? []) {
    if (b.kind === "agent") out.push({ key: "agent", kind: "agent", label: "agent", tip: "The agent itself" });
    else if (b.kind === "subagent") out.push({ key: `subagent:${b.name ?? ""}`, kind: "subagent", label: b.name || "subagent", tip: `Subagent ${b.name ?? ""}`.trim() });
    else if (b.kind === "workflow") out.push({ key: `workflow:${b.name ?? ""}`, kind: "workflow", label: b.name || "workflow", tip: `Workflow ${b.name ?? ""}`.trim() });
  }
  return out;
}

/** The one creator a row shows: { kind, label, tip }. A subagent or workflow beats the agent beats the worktree. */
export function creatorOf(pr) {
  const makers = makersOf(pr);
  const best = makers.find((m) => m.kind === "subagent") ?? makers.find((m) => m.kind === "workflow") ?? makers[0];
  if (best) return best;
  if ((pr.by ?? []).some((b) => b.kind === "worktree")) return { key: "worktree", kind: "worktree", label: "this worktree", tip: "The branch of this worktree" };
  return { key: `person:${pr.author ?? ""}`, kind: "person", label: pr.author ?? "", tip: pr.author ? `By ${pr.author}` : "" };
}

const hasKind = (pr, kind) => (pr.by ?? []).some((b) => b.kind === kind);

/** Whether a PR is in the scope. Worktree: its branch is this worktree's. Agent: any maker but "other". */
export function inScope(pr, scope) {
  if (scope === "worktree") return hasKind(pr, "worktree");
  return (pr.by ?? []).some((b) => b.kind !== "other");
}

// ---- stacks ----------------------------------------------------------------------------------------

/**
 * One group's PRs -> the rows in order from the bottom up: [{ p, pos, depth }].
 * A PR sits on its `parent`; a parent that is not shown is skipped (the next one up the chain is used).
 * `pos`: GitHub's position in a native stack, else the place along the path (1 = the bottom).
 */
export function chainOf(shown, all) {
  const byNum = new Map(all.map((p) => [p.number, p]));
  const vis = new Set(shown.map((p) => p.number));
  const up = (p) => {
    let n = p.parent;
    const seen = new Set();
    while (n != null && !vis.has(n) && !seen.has(n)) { seen.add(n); n = byNum.get(n)?.parent ?? null; }
    return n != null && vis.has(n) && n !== p.number ? n : null;
  };
  const kids = new Map();
  const roots = [];
  for (const p of shown) {
    const u = up(p);
    if (u == null) roots.push(p); else { if (!kids.has(u)) kids.set(u, []); kids.get(u).push(p); }
  }
  const order = (a, b) => (a.stack?.position ?? 1e9) - (b.stack?.position ?? 1e9) || a.number - b.number;
  roots.sort(order);
  const out = [];
  const seen = new Set();
  const walk = (p, pos, depth) => {
    if (seen.has(p.number)) return; // a loop in the data
    seen.add(p.number);
    out.push({ p, pos: p.stack?.position ?? pos, depth });
    (kids.get(p.number) ?? []).sort(order).forEach((c, i) => walk(c, pos + 1, depth + (i > 0 ? 1 : 0)));
  };
  roots.forEach((r) => walk(r, 1, 0));
  for (const p of shown) if (!seen.has(p.number)) walk(p, 1, 0); // a loop with no root
  return out;
}

/** The stack's name: the most common area after its "|" ("Topic 1"), else the bottom's title. */
export function stackName(prs) {
  const count = new Map();
  for (const p of prs) {
    const key = (splitTitle(p.title).area.split("|").pop() ?? "").trim();
    if (key) count.set(key, (count.get(key) ?? 0) + 1);
  }
  let best = "", n = 0;
  for (const [k, v] of count) if (v > n) { best = k; n = v; }
  return best || splitTitle(prs[0]?.title).text;
}

const newest = (prs) => prs.reduce((m, p) => { const t = String((p.state === "merged" ? p.mergedAt : null) ?? p.updatedAt ?? ""); return t > m ? t : m; }, "");

/** The PRs of one stack (same `stack.id`), bottom-up: [{ p, pos, depth }]. A PR in no stack: []. */
export function stackOf(prs, pr) {
  if (!pr.stack) return [];
  const members = prs.filter((x) => x.stack?.id === pr.stack.id && x.repo === pr.repo);
  return members.length > 1 ? chainOf(members, members) : [];
}

/**
 * What the list shows. Returns { live: groups, done: groups, doneCount }; a group is
 *   { kind: "stack", id, name, base, foreignBase, chain: [{p, pos, depth, inScope}], hidden, size, all, newest }
 *   { kind: "single", id, chain: [{p, pos: 1, depth: 0, inScope: true}], base, foreignBase, newest }
 * - A group shows when one of its shown PRs is in the scope (and passes `filter`, a maker key).
 * - A group with an open or draft PR is "live": it shows all its PRs but the closed ones, merged ones too (the view dims them).
 *   Any other group (finished work, a lone merged or closed PR) is "done". Hidden unless `showDone`; then
 *   the closed PRs of live stacks show too, and done groups come last.
 * - Worktree scope: PRs of a stack that are not in the scope fold into `hidden` (unless the stack id is in `expanded`).
 * - `doneCount`: the PRs of this scope and filter the toggle would show.
 * Order: the group with the newest change first.
 */
export function groups(prs, { scope = "agent", filter = null, showDone = false, expanded = new Set() } = {}) {
  const keep = (p) => inScope(p, scope) && (!filter || makersOf(p).some((m) => m.key === filter));
  const byId = new Map();
  for (const p of prs) {
    const id = p.stack ? `stack:${p.stack.id}` : `pr:${idOf(p)}`;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(p);
  }
  const live = [], done = [];
  let doneCount = 0;
  for (const [gid, members] of byId) {
    const isStack = members.length > 1;
    const alive = members.some(isLive);
    const hiddenByRule = (p) => !alive || p.state === "closed";
    doneCount += members.filter((p) => keep(p) && hiddenByRule(p)).length;
    const shown = members.filter((p) => showDone || !hiddenByRule(p));
    if (!shown.some(keep)) continue;
    const chain = chainOf(shown, members).map((x) => ({ ...x, inScope: keep(x.p) }));
    const bottom = chain[0].p;
    const base = { base: bottom.base, foreignBase: !BASES.has(bottom.base), newest: newest(members) };
    if (!isStack) {
      (alive ? live : done).push({ kind: "single", id: gid, ...base, chain: [{ ...chain[0], pos: 1, inScope: true }] });
      continue;
    }
    const id = gid;
    const fold = scope === "worktree" && !expanded.has(id);
    const rows = fold ? chain.filter((x) => x.inScope) : chain;
    (alive ? live : done).push({ kind: "stack", id, name: stackName(members), ...base, chain: rows, all: chain, hidden: chain.length - rows.length, size: chain.length });
  }
  const sort = (a, b) => b.newest.localeCompare(a.newest);
  return { live: live.sort(sort), done: done.sort(sort), doneCount };
}

/** Counts per scope: { worktree, agent } (open + draft PRs). */
export function scopeCounts(prs) {
  const open = prs.filter(isLive);
  return { worktree: open.filter((p) => inScope(p, "worktree")).length, agent: open.filter((p) => inScope(p, "agent")).length };
}

/** The filter chips of what the list shows (before the filter): [{ key, kind, label, tip, n }], agent first, then by count. */
export function creators(prs, scope, opts = {}) {
  const g = groups(prs, { ...opts, scope, filter: null });
  const m = new Map();
  for (const grp of [...g.live, ...g.done]) {
    for (const x of grp.chain) {
      if (!x.inScope) continue;
      for (const c of makersOf(x.p)) {
        const cur = m.get(c.key) ?? { ...c, n: 0 };
        cur.n++;
        m.set(c.key, cur);
      }
    }
  }
  const first = { agent: 0 };
  return [...m.values()].sort((a, b) => (first[a.kind] ?? 1) - (first[b.kind] ?? 1) || b.n - a.n || a.label.localeCompare(b.label));
}

// ---- the list ------------------------------------------------------------------------------------------

export const H = { section: 30, head: 34, base: 24, row: 48, more: 28 };

/**
 * Groups -> the list's items, each { key, kind, h, ... }: section, stack head, base, rows bottom-first, more.
 * `collapsed`: stack ids drawn as their head only.
 */
export function listItems({ live, done }, { collapsed = new Set() } = {}) {
  const items = [];
  const put = (stacks, singles, prefix) => {
    if (stacks.length) items.push({ key: `sec-${prefix}stacks`, kind: "section", h: H.section, label: prefix ? "Done: stacks" : "Stacks", n: stacks.length });
    for (const g of stacks) {
      const shut = collapsed.has(g.id);
      items.push({ key: `head|${g.id}`, kind: "head", h: H.head, group: g, shut });
      if (shut) continue;
      items.push({ key: `base|${g.id}`, kind: "base", h: H.base, group: g });
      g.chain.forEach((x, i) => items.push({ key: `row|${idOf(x.p)}`, kind: "row", h: H.row, id: idOf(x.p), p: x.p, pos: x.pos, depth: x.depth, inScope: x.inScope, group: g,
        first: i === 0, last: i === g.chain.length - 1 && !g.hidden }));
      if (g.hidden) items.push({ key: `more|${g.id}`, kind: "more", h: H.more, group: g, n: g.hidden });
    }
    if (singles.length) {
      items.push({ key: `sec-${prefix}singles`, kind: "section", h: H.section, label: prefix ? "Done: single PRs" : "Single PRs", n: singles.length });
      for (const g of singles) {
        const x = g.chain[0];
        items.push({ key: `row|${idOf(x.p)}`, kind: "row", h: H.row, id: idOf(x.p), p: x.p, pos: 1, depth: 0, inScope: true, group: g, single: true, first: true, last: true });
      }
    }
  };
  put(live.filter((g) => g.kind === "stack"), live.filter((g) => g.kind === "single"), "");
  put(done.filter((g) => g.kind === "stack"), done.filter((g) => g.kind === "single"), "done-");
  return items;
}

/** The PR ids the keyboard moves through, in list order. */
export const rowOrder = (items) => items.filter((i) => i.kind === "row").map((i) => i.id);

/** Moves the selection by `d` rows; stays inside the list. */
export function step(order, sel, d) {
  if (!order.length) return null;
  const i = order.indexOf(sel);
  if (i < 0) return order[d > 0 ? 0 : order.length - 1];
  return order[Math.max(0, Math.min(order.length - 1, i + d))];
}

/** A stack's totals for its head. Merged PRs are counted apart: their old checks mean nothing. */
export function stackStats(group) {
  const ps = group.all.map((x) => x.p);
  const live = ps.filter(isLive);
  return {
    fail: live.filter((p) => checksOf(p) === "fail").length,
    pending: live.filter((p) => checksOf(p) === "pending").length,
    conflicts: live.filter((p) => mergeOf(p).key === "conflicts").length,
    pass: live.filter((p) => checksOf(p) === "pass").length,
    merged: ps.filter((p) => p.state === "merged").length,
    live: live.length,
  };
}

/** Path -> { dir, name }. */
export function splitPath(path) {
  const i = String(path).lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

// ---- the terminal ---------------------------------------------------------------------------------------

/**
 * The agent whose PRs to show: the focused terminal when it is an agent of the focused tab, else the one
 * last focused in that tab (`last`: tab -> terminal), else the tab's first agent. `agents` in Herdr's order.
 */
export function pickAgent(agents, focused, last = {}) {
  if (!focused?.tab) return null;
  const mine = (agents ?? []).filter((a) => a.tab === focused.tab);
  return mine.find((a) => a.address === focused.terminal) ?? mine.find((a) => a.address === last[focused.tab]) ?? mine[0] ?? null;
}

// ---- when to ask for fresh data ---------------------------------------------------------------------------

export const SHOWN_MS = 45000;
export const PENDING_MS = 15000;
export const DISCOVER_MS = 5 * 60000;
export const REOPEN_DISCOVER_MS = 60000;

/** Whether a check is still running on one of these PRs (the shown ones). */
export const anyPending = (prs) => prs.some((p) => isLive(p) && checksOf(p) === "pending");

/**
 * What the refresh loop does now. State: now (ms), shown, lastEnd (when the last run ended; null = never for
 * this terminal), lastDiscover (when the last discover run ended, or null), pending (a shown PR has running
 * checks), force (the user asked, or the view just got a terminal), opened (the view just showed).
 * Returns { run, discover, wait }: `wait` is ms until the next run is due (when run is false and shown).
 * Not shown: never run. One run at a time is the loop's job; it calls this between runs.
 */
export function refreshPlan({ now, shown, lastEnd = null, lastDiscover = null, pending = false, force = false, opened = false }) {
  if (!shown) return { run: false, discover: false, wait: null };
  const since = lastDiscover == null ? Infinity : now - lastDiscover;
  const discover = force || since >= DISCOVER_MS || (opened && since >= REOPEN_DISCOVER_MS) || lastDiscover == null;
  if (force || lastEnd == null) return { run: true, discover, wait: 0 };
  const due = lastEnd + (pending ? PENDING_MS : SHOWN_MS);
  if (now >= due) return { run: true, discover, wait: 0 };
  return { run: false, discover: false, wait: due - now };
}
