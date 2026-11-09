// Asking GitHub (read-only): one `gh api graphql` call per repo with an alias per PR, search by head
// branch, native stack members. The token never leaves `gh`.
import { chunk } from "./util.mjs";

export const MAX_ALIASES = 50;
export const SEARCH_MAX_LEN = 240; // GitHub's search query limit is 256 characters

const STACK_FIELDS = "stack{number baseRefName entries(first:1){totalCount}} stackEntry{position}";

/** The fields of one PR. Check COUNTS only: check nodes are what makes the query slow. */
export function fragment({ stack = true } = {}) {
  return `fragment F on PullRequest { number title url state isDraft baseRefName headRefName headRefOid updatedAt createdAt mergedAt closedAt author{login} reviewDecision mergeable mergeStateStatus additions deletions changedFiles autoMergeRequest{enabledAt} ${stack ? STACK_FIELDS : ""} commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:1){totalCount checkRunCountsByState{state count} statusContextCountsByState{state count}}}}}} }`;
}

const gql = (s) => JSON.stringify(String(s)); // a GraphQL string literal is a JSON string

/**
 * One request: `numbers` as pullRequest aliases (p<N>) with the full fields, `searches` as search aliases
 * (s<i>) that return numbers. The caller keeps the total at MAX_ALIASES or less.
 */
export function buildQuery({ repo, numbers = [], searches = [], stack = true }) {
  const [owner, name] = repo.split("/");
  const parts = [];
  if (numbers.length) {
    parts.push(`repository(owner:${gql(owner)},name:${gql(name)}){ ${numbers.map((n) => `p${n}: pullRequest(number:${n}){...F}`).join(" ")} }`);
  }
  // A search answers with numbers only: its hits are mostly PRs that are asked for by number anyway.
  searches.forEach((q, i) => parts.push(`s${i}: search(query:${gql(q)}, type:ISSUE, first:50){ nodes{ ... on PullRequest { number } } }`));
  parts.push("rateLimit{cost remaining resetAt}");
  // GraphQL rejects a fragment that nothing uses, so a request of searches only has none.
  return `query { ${parts.join(" ")} }${numbers.length ? `\n${fragment({ stack })}` : ""}`;
}

/**
 * Search strings `repo:<r> is:pr head:A head:B …` (or base:), each under SEARCH_MAX_LEN characters.
 * Several head: qualifiers are OR'd. State is not filtered: open, closed and merged all come back.
 */
export function searchQueries(repo, kind, branches, maxLen = SEARCH_MAX_LEN) {
  const prefix = `repo:${repo} is:pr`;
  const suffix = " sort:updated-desc";
  const out = [];
  let cur = [];
  const len = (list) => prefix.length + list.reduce((n, b) => n + 1 + kind.length + 1 + b.length, 0) + suffix.length;
  for (const b of [...new Set(branches)].filter((x) => x && !/\s/.test(x))) {
    if (len([b]) > maxLen) continue; // cannot be searched
    if (len([...cur, b]) > maxLen) { out.push(cur); cur = []; }
    cur.push(b);
  }
  if (cur.length) out.push(cur);
  return out.map((list) => `${prefix} ${list.map((b) => `${kind}:${b}`).join(" ")}${suffix}`);
}

/** The members of native stacks: one alias per stack, asked through any one PR of it. */
export function buildEntriesQuery({ repo, reps }) {
  const [owner, name] = repo.split("/");
  const body = reps.map(({ stack, number }) => `e${stack}: pullRequest(number:${number}){ stack{ number entries(first:100){ totalCount nodes{ position pullRequest{ number } } } } }`).join(" ");
  return `query { repository(owner:${gql(owner)},name:${gql(name)}){ ${body} } rateLimit{cost remaining resetAt} }`;
}

// ---- running gh -------------------------------------------------------------------------------------

/** What went wrong with a gh call, for people. */
export function ghFailure(r) {
  const err = `${r.error ?? ""} ${r.stderr ?? ""}`;
  if (/ENOENT/.test(err)) return "gh is not installed (not found on PATH)";
  if (/gh auth login|not logged in|authentication|HTTP 401|Bad credentials|GH_TOKEN/i.test(err)) return "gh is not signed in: run `gh auth login`";
  if (/timeout/i.test(err)) return `gh timed out (${(r.error ?? "").trim()})`;
  if (/error connecting|dial tcp|no such host|ETIMEDOUT|ENOTFOUND|connection refused|network is unreachable|i\/o timeout/i.test(err)) return "no network: gh cannot reach api.github.com";
  if (/rate limit/i.test(err)) return "GitHub rate limit reached";
  const line = (r.stderr ?? "").split("\n").find((l) => l.trim()) ?? r.error ?? "";
  return `gh failed${r.code != null ? ` (exit ${r.code})` : ""}: ${line.trim().slice(0, 300)}`;
}

/**
 * Runs one GraphQL document. gh exits non-zero when the answer holds `errors`, even with usable data,
 * so stdout is parsed first. Returns { json, failure } where failure is a message when nothing usable came back.
 */
export async function graphql(run, query, opts = {}) {
  const r = await run("gh", ["api", "graphql", "-f", `query=${query}`], { timeout: opts.timeout ?? 20000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  if (!json || (!json.data && !json.errors)) return { json: null, failure: ghFailure(r) };
  return { json, failure: null };
}

export const isStackSchemaError = (errors) =>
  (errors ?? []).some((e) => /Field '(stack|stackEntry|entries)' doesn't exist|PullRequestStack/i.test(e?.message ?? ""));

/** Errors worth showing. A PR that is not there (NOT_FOUND) is not one. */
function worth(errors) {
  return (errors ?? []).filter((e) => e && e.type !== "NOT_FOUND" && !/Could not resolve to a PullRequest/i.test(e.message ?? ""));
}

/**
 * Fetches PRs of one repo: `numbers` by alias, `searches` (search strings) by search. Splits into
 * requests of at most MAX_ALIASES aliases. If the stack fields are rejected, asks again without them.
 * Returns { nodes: Map(number -> node) (the numbers asked for), hits: number[][] (the PR numbers each search found),
 * errors, failure, failedNumbers, stackUnsupported, rate }.
 */
export async function fetchPrs(run, repo, { numbers = [], searches = [], stack = true } = {}) {
  const out = { nodes: new Map(), hits: searches.map(() => []), errors: [], failure: null, failedNumbers: [], stackUnsupported: !stack, rate: null };
  const jobs = [];
  const rest = [...new Set(numbers)];
  let si = 0;
  while (rest.length || si < searches.length) {
    const job = { numbers: [], searches: [] };
    while (si < searches.length && job.searches.length < MAX_ALIASES) job.searches.push(si++);
    job.numbers = rest.splice(0, MAX_ALIASES - job.searches.length);
    jobs.push(job);
  }
  for (const job of jobs) {
    const ask = (withStack) => graphql(run, buildQuery({ repo, numbers: job.numbers, searches: job.searches.map((i) => searches[i]), stack: withStack }));
    let res = await ask(!out.stackUnsupported);
    if (!out.stackUnsupported && res.json && isStackSchemaError(res.json.errors) && !res.json.data?.repository) {
      out.stackUnsupported = true;
      res = await ask(false);
    }
    if (res.failure) { out.failure = res.failure; out.failedNumbers.push(...job.numbers); continue; }
    const { data, errors } = res.json;
    for (const e of worth(errors)) out.errors.push(String(e.message ?? e.type ?? "GraphQL error").slice(0, 300));
    if (!data) { out.failure = out.errors.pop() ?? "GitHub returned no data"; out.failedNumbers.push(...job.numbers); continue; }
    if (data.rateLimit) out.rate = data.rateLimit;
    for (const n of job.numbers) {
      const node = data.repository?.[`p${n}`];
      if (node && node.number) out.nodes.set(node.number, node);
    }
    job.searches.forEach((i, k) => {
      for (const node of data[`s${k}`]?.nodes ?? []) if (node?.number) out.hits[i].push(node.number);
    });
  }
  return out;
}

/** Native stack members: { members: Map(stack number -> [{ position, number }]) }, for reps given as { stack, number }. */
export async function fetchStackEntries(run, repo, reps) {
  const out = { members: new Map(), errors: [], failure: null };
  for (const part of chunk(reps, MAX_ALIASES)) {
    const res = await graphql(run, buildEntriesQuery({ repo, reps: part }));
    if (res.failure) { out.failure = res.failure; continue; }
    for (const e of worth(res.json.errors)) out.errors.push(String(e.message ?? "GraphQL error").slice(0, 300));
    for (const { stack } of part) {
      const s = res.json.data?.repository?.[`e${stack}`]?.stack;
      if (!s) continue;
      out.members.set(stack, (s.entries?.nodes ?? []).filter((x) => x?.pullRequest?.number).map((x) => ({ position: x.position, number: x.pullRequest.number })));
    }
  }
  return out;
}
