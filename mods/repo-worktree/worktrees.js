// A repo's checkouts, for the list. Pure: the git output comes in as text, so plain node tests it.

const base = (path) => path.replace(/\/+$/, "").split("/").pop();

/**
 * `git worktree list --porcelain` + `git for-each-ref --format=%(refname:short)%09%(committerdate:unix) refs/heads`
 * → [{ path, name, branch, main, at }]: the main checkout first, then the most recently committed.
 * Bare and prunable (folder gone) entries are left out, and so are checkouts inside the main
 * one: tools keep theirs there (Claude Code's agents use <main>/.claude/worktrees/).
 */
export function parseWorktrees(porcelain, refs) {
  const when = new Map(String(refs ?? "").split("\n").filter(Boolean).map((l) => l.split("\t")).map(([b, at]) => [b, Number(at) || 0]));
  const out = [];
  for (const block of String(porcelain ?? "").split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path) continue;
    const main = out.length === 0 && !lines.includes("bare");
    if (lines.includes("bare") || lines.some((l) => l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path, name: base(path), branch, main, at: branch ? (when.get(branch) ?? 0) : 0 });
  }
  const main = out.find((c) => c.main)?.path;
  return out.filter((c) => !main || c.main || !c.path.startsWith(`${main}/`)).sort((a, b) => b.main - a.main || b.at - a.at || a.name.localeCompare(b.name));
}

/** The checkouts whose folder or branch holds every word of the filter. */
export function filterWorktrees(list, text) {
  const words = String(text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((c) => words.every((w) => `${c.name} ${c.branch ?? ""}`.toLowerCase().includes(w)));
}

/** The checkout a typed name already means: same branch, or same folder. */
export function exactMatch(list, text, folder) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  return list.find((c) => c.branch === t || c.name === t || (folder && c.name === folder)) ?? null;
}

/**
 * The space showing a checkout: one whose folder (its first terminal's) is inside it, and not
 * inside a deeper checkout. `places`: [{ id, folder }].
 */
export function spaceFor(path, list, places) {
  const inside = (p, dir) => p === dir || p.startsWith(`${dir}/`);
  return places.find(({ folder }) => folder && inside(folder, path) && !list.some((c) => c.path !== path && c.path.length > path.length && inside(folder, c.path))) ?? null;
}

/** "5m", "3h", "2d", "4mo" since a unix time. */
export function ago(at, now = Date.now() / 1000) {
  if (!at) return "";
  const d = now - at;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
}

/**
 * Everything the popup reads from git, in one process: `sh -c SNAPSHOT sh <folder>`.
 * One call instead of four: each call waits its turn in Herdr's shared mod runtime.
 */
export const SNAPSHOT = [
  'cd "$1" || exit 1',
  "git rev-parse --show-toplevel --path-format=absolute --git-common-dir || exit 1",
  "printf '\\036'",
  "git worktree list --porcelain",
  "printf '\\036'",
  "git for-each-ref --format='%(refname:short)%09%(committerdate:unix)' refs/heads",
].join("\n");

/** SNAPSHOT's output → { repo: { top, main, name, parent }, list } or null (not a git folder). */
export function parseSnapshot(stdout) {
  const [head, porcelain, refs] = String(stdout ?? "").split("\x1e");
  const [top, common] = (head ?? "").trim().split("\n");
  if (!top || !common) return null;
  const main = common.endsWith("/.git") ? common.slice(0, -5) : common;
  const parts = main.split("/");
  return { repo: { top, main, name: parts.at(-1), parent: parts.slice(0, -1).join("/") || "/" }, list: parseWorktrees(porcelain, refs) };
}

// Where a list must scroll so that row `at` shows, or null when it shows already.
// `first` is the first row in view; `visible` is how many rows fit.
export function scrollTarget(at, first, visible) {
  if (at < first) return at;
  if (at >= first + visible) return at - visible + 1;
  return null;
}
