// `herdr-prs detail <owner/repo> <number> <part>`: one part of the preview, as JSON on stdout.
//   body     { body, title, author, reviewers: [{login, state}], requested: [login|team] }
//   checks   { counts, checks: [{ name, workflow, result, url, runId, jobId, seconds }] }   latest run per check,
//            skipped dropped, fail then pending then pass
//   files    { files: [{ path, additions, deletions, status, previousPath? }], total, truncated }
//   diff     { diff, bytes, truncated }                                                      cut at 900 KB
//   threads  { total, truncated, threads: [{ resolved, outdated, path, line, author, body, url, createdAt, replies: [{ author, body, createdAt }] }] }
// Cached in <home>/data/prs/cache/detail/, keyed by repo, number, head commit and update time.
import fs from "node:fs";
import path from "node:path";
import { appHome, prKey, readJson, safeName, writeAtomic } from "./util.mjs";
import { checkList, countChecks } from "./model.mjs";
import { cacheDir } from "./cache.mjs";
import { ghFailure, graphql } from "./github.mjs";

export const PARTS = ["body", "checks", "files", "diff", "threads"];
export const DIFF_LIMIT = 900 * 1024;
const FILES_PAGE = 100;
const FILES_MAX_PAGES = 30; // GitHub lists at most 3000 files
const THREAD_REPLIES = 5;

/** The newest row for this PR in any terminal's data file, for the cache key without a network call. */
export function findRow(home, repo, number) {
  const dir = path.join(home, "data/prs");
  let best = null;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const d = readJson(path.join(dir, n), null);
    if (d?.version !== 1) continue;
    const row = (d.prs ?? []).find((r) => r.repo === repo && r.number === number);
    if (row && (!best || String(d.at) > String(best.at))) best = { at: d.at, row };
  }
  return best?.row ?? null;
}

const CACHE_VERSION = 1; // bump when the shape of an answer changes
const cacheKey = (row, part) => (row ? [CACHE_VERSION, row.headOid, row.updatedAt, part === "checks" ? `${row.checks?.state}:${row.checks?.pass}:${row.checks?.fail}:${row.checks?.pending}` : ""].join("|") : null);
const cacheFile = (home, repo, number, part) => path.join(cacheDir(home), "detail", `${safeName(repo)}__${number}__${part}.json`);

export async function detail({ repo, number, part, run, home = appHome(), fresh = false, now = Date.now }) {
  const row = findRow(home, repo, number);
  const key = cacheKey(row, part);
  const file = cacheFile(home, repo, number, part);
  if (!fresh && key) {
    const hit = readJson(file, null);
    // A pending check list changes without the PR changing: do not serve it for long.
    const age = now() - (hit?.at ?? 0);
    if (hit && hit.key === key && (part !== "checks" || row.checks?.state !== "pending" || age < 15000)) return { ...hit.data, cached: true };
  }
  const data = await load({ repo, number, part, run });
  if (key && !data.error) { try { writeAtomic(file, JSON.stringify({ key, at: now(), data })); } catch { /* a cache */ } }
  return data;
}

async function load({ repo, number, part, run }) {
  switch (part) {
    case "body": return body(run, repo, number);
    case "checks": return checks(run, repo, number);
    case "files": return files(run, repo, number);
    case "diff": return diff(run, repo, number);
    case "threads": return threads(run, repo, number);
    default: return { part, error: `unknown part: ${part}` };
  }
}

async function ghJson(run, args, timeout = 20000) {
  const r = await run("gh", args, { timeout });
  if (r.code !== 0) return { error: ghFailure(r) };
  try { return { json: JSON.parse(r.stdout) }; } catch { return { error: "gh returned something that is not JSON" }; }
}

async function body(run, repo, number) {
  const r = await ghJson(run, ["pr", "view", String(number), "-R", repo, "--json", "title,body,author,latestReviews,reviewRequests"]);
  if (r.error) return { part: "body", error: r.error };
  const j = r.json;
  return {
    part: "body",
    title: j.title ?? "",
    body: j.body ?? "",
    author: j.author?.login ?? null,
    reviewers: (j.latestReviews ?? []).map((x) => ({ login: x.author?.login ?? null, state: x.state })),
    requested: (j.reviewRequests ?? []).map((x) => x.login ?? x.name ?? x.slug).filter(Boolean),
  };
}

async function checks(run, repo, number) {
  const r = await ghJson(run, ["pr", "view", String(number), "-R", repo, "--json", "statusCheckRollup"]);
  if (r.error) return { part: "checks", error: r.error };
  const all = checkList(r.json.statusCheckRollup, { keepSkipped: true });
  return { part: "checks", counts: countChecks(all), checks: all.filter((c) => c.result !== "skip") };
}

async function files(run, repo, number) {
  const all = [];
  let truncated = false;
  for (let page = 1; page <= FILES_MAX_PAGES; page++) {
    const r = await ghJson(run, ["api", `repos/${repo}/pulls/${number}/files?per_page=${FILES_PAGE}&page=${page}`]);
    if (r.error) return { part: "files", error: r.error, files: all, total: all.length, truncated: true };
    for (const f of r.json) {
      all.push({ path: f.filename, additions: f.additions ?? 0, deletions: f.deletions ?? 0, status: f.status, ...(f.previous_filename ? { previousPath: f.previous_filename } : {}) });
    }
    if (r.json.length < FILES_PAGE) break;
    if (page === FILES_MAX_PAGES) truncated = true;
  }
  return { part: "files", files: all, total: all.length, truncated };
}

/** Cuts `text` to `limit` bytes at a line end; returns { text, truncated }. */
export function cutBytes(text, limit) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= limit) return { text, truncated: false };
  let end = buf.lastIndexOf(10, limit);
  if (end < limit / 2) end = limit;
  return { text: buf.subarray(0, end).toString("utf8").replace(/�$/, ""), truncated: true };
}

async function diff(run, repo, number) {
  const r = await run("gh", ["pr", "diff", String(number), "-R", repo], { timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
  if (r.code !== 0 && !r.stdout) {
    const big = /too_large|too large|406/i.test(r.stderr ?? "");
    return { part: "diff", error: big ? "The diff is too large for GitHub to show (over 20,000 lines or 1 MB). See the files list." : ghFailure(r) };
  }
  const cut = cutBytes(r.stdout, DIFF_LIMIT);
  return { part: "diff", diff: cut.text, bytes: Buffer.byteLength(r.stdout, "utf8"), truncated: cut.truncated };
}

async function threads(run, repo, number) {
  const [owner, name] = repo.split("/");
  const q = `query { repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){ pullRequest(number:${Number(number)}){ reviewThreads(first:100){ totalCount nodes{ isResolved isOutdated path line originalLine comments(first:${THREAD_REPLIES + 1}){ nodes{ author{login} body createdAt url } } } } } } }`;
  const r = await graphql(run, q);
  if (r.failure) return { part: "threads", error: r.failure };
  const t = r.json.data?.repository?.pullRequest?.reviewThreads;
  if (!t) return { part: "threads", error: (r.json.errors?.[0]?.message ?? "no review threads in the answer").slice(0, 300) };
  const out = (t.nodes ?? []).map((x) => {
    const [first, ...rest] = x.comments?.nodes ?? [];
    return {
      resolved: Boolean(x.isResolved),
      outdated: Boolean(x.isOutdated),
      path: x.path ?? null,
      line: x.line ?? x.originalLine ?? null,
      author: first?.author?.login ?? null,
      body: first?.body ?? "",
      url: first?.url ?? null,
      createdAt: first?.createdAt ?? null,
      replies: rest.slice(0, THREAD_REPLIES).map((c) => ({ author: c.author?.login ?? null, body: c.body ?? "", createdAt: c.createdAt ?? null })),
    };
  });
  return { part: "threads", total: t.totalCount ?? out.length, truncated: (t.totalCount ?? 0) > out.length, threads: out };
}
