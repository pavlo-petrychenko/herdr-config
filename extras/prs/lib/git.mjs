// Local git questions: which GitHub repo a folder belongs to, which branch it is on. All read-only.
import fs from "node:fs";
import { mainCheckoutOf, parseRemote } from "./util.mjs";

export const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

/** A placeholder branch Claude Code gives an agent's worktree before the agent picks a real one. */
export const isPlaceholderBranch = (b) => /^worktree-(agent-|wf_)/.test(b ?? "");

export function makeGit(run, cache, exists = fs.existsSync) {
  exists ??= fs.existsSync;
  const memo = new Map();
  const git = (cwd, args) => run("git", ["-C", cwd, ...args], { timeout: 5000 });

  /** "owner/name" of the folder's `origin`. A deleted agent worktree falls back to the repo it lived in. */
  async function repoOfPath(p) {
    if (!p) return null;
    if (cache.repos[p]) return cache.repos[p];
    if (memo.has(p)) return memo.get(p);
    const job = (async () => {
      for (const c of [p, mainCheckoutOf(p)]) {
        if (!c || !exists(c)) continue;
        const r = await git(c, ["remote", "get-url", "origin"]);
        const repo = r.code === 0 ? parseRemote(r.stdout) : null;
        if (repo) { cache.setRepo(p, repo); return repo; }
      }
      return null;
    })();
    memo.set(p, job);
    return job;
  }

  /** { branch, upstream }: the checked-out branch (null when detached or not a folder) and the remote branch it tracks. */
  async function branchOfPath(p) {
    if (!p || !exists(p)) return { branch: null, upstream: null };
    const r = await git(p, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = r.code === 0 && r.stdout.trim() && r.stdout.trim() !== "HEAD" ? r.stdout.trim() : null;
    if (!branch) return { branch: null, upstream: null };
    const u = await git(p, ["config", "--get", `branch.${branch}.merge`]);
    const upstream = u.code === 0 && u.stdout.trim() ? u.stdout.trim().replace(/^refs\/heads\//, "") : null;
    return { branch, upstream };
  }

  /** The repo's default branch, from the folder's origin/HEAD; main and master are skipped anyway. */
  async function defaultBranchOf(repo, p) {
    if (cache.defaults[repo]) return cache.defaults[repo];
    for (const c of [p, mainCheckoutOf(p)]) {
      if (!c || !exists(c)) continue;
      const r = await git(c, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      const b = r.code === 0 ? r.stdout.trim().replace(/^origin\//, "") : "";
      if (b) { cache.setDefault(repo, b); return b; }
    }
    return null;
  }

  return { repoOfPath, branchOfPath, defaultBranchOf };
}
