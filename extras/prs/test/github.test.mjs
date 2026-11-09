import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ALIASES, SEARCH_MAX_LEN, buildEntriesQuery, buildQuery, fetchPrs, fetchStackEntries, fragment, ghFailure, isStackSchemaError, searchQueries } from "../lib/github.mjs";
import { toRow } from "../lib/model.mjs";
import fs from "node:fs";
import { fakeRun, fixture, queryOf, readFixture } from "./helpers.mjs";

const REPO = "acme/shop";

test("buildQuery: one alias per PR number, searches as s<i>, one shared fragment", () => {
  const q = buildQuery({ repo: REPO, numbers: [5, 9], searches: ["repo:acme/shop is:pr head:a"] });
  assert.match(q, /repository\(owner:"acme",name:"shop"\)/);
  assert.match(q, /p5: pullRequest\(number:5\)\{\.\.\.F\} p9: pullRequest\(number:9\)\{\.\.\.F\}/);
  assert.match(q, /s0: search\(query:"repo:acme\/shop is:pr head:a", type:ISSUE, first:50\)\{ nodes\{ \.\.\. on PullRequest \{ number \} \} \}/, "a search answers with numbers only");
  assert.match(q, /rateLimit\{cost remaining resetAt\}/);
  assert.equal(q.match(/fragment F on PullRequest/g).length, 1);
  for (const f of ["headRefOid", "createdAt", "author{login}", "autoMergeRequest{enabledAt}", "stack{number", "stackEntry{position}", "checkRunCountsByState", "statusContextCountsByState", "mergeStateStatus"]) {
    assert.ok(q.includes(f), `fragment has ${f}`);
  }
  assert.ok(!q.includes("contexts(first:100)"), "check counts only, no check nodes");
});

test("buildQuery: GraphQL rejects an unused fragment, so searches alone carry none", () => {
  const q = buildQuery({ repo: REPO, searches: ["repo:o/r is:pr head:a"] });
  assert.ok(!q.includes("fragment"));
  assert.ok(!q.includes("...F"));
  const used = buildQuery({ repo: REPO, numbers: [1] });
  assert.equal(used.match(/fragment F/g).length, 1);
  assert.ok(used.includes("...F"));
});

test("buildQuery makes the document GitHub accepted when the fixtures were recorded", () => {
  const q = buildQuery({
    repo: REPO,
    numbers: [57736, 57737, 57738, 57739, 57740, 57741, 57742, 57743, 57744, 57685, 57686, 57761, 57557],
    searches: ["repo:acme/shop is:pr head:feature-18 head:feature-22 sort:updated-desc"],
  });
  assert.equal(q, fs.readFileSync(fixture("real-query.graphql"), "utf8"));
});

test("buildQuery without stack fields", () => {
  const q = buildQuery({ repo: REPO, numbers: [1], stack: false });
  assert.ok(!/stack/.test(q));
  assert.ok(fragment({ stack: true }).includes("stackEntry"));
});

test("buildQuery escapes the search string", () => {
  const q = buildQuery({ repo: REPO, searches: ['repo:x/y is:pr head:a"b'] });
  assert.ok(q.includes(String.raw`head:a\"b`));
});

test("searchQueries: chunks stay under the length limit, every branch is in exactly one chunk", () => {
  const branches = Array.from({ length: 40 }, (_, i) => `PF-${19000 + i}_Some-long-branch-name-for-testing-chunks-${i}`);
  const qs = searchQueries(REPO, "head", branches);
  assert.ok(qs.length > 1);
  for (const q of qs) {
    assert.ok(q.length <= SEARCH_MAX_LEN, `${q.length} <= ${SEARCH_MAX_LEN}`);
    assert.ok(q.startsWith(`repo:${REPO} is:pr head:`));
    assert.ok(q.endsWith(" sort:updated-desc"));
  }
  const used = qs.flatMap((q) => [...q.matchAll(/head:(\S+)/g)].map((m) => m[1]));
  assert.deepEqual(used.sort(), [...branches].sort());
});

test("searchQueries: base: kind, duplicates and unsearchable names are dropped", () => {
  const long = "x".repeat(300);
  const qs = searchQueries(REPO, "base", ["a", "a", "b/c", "has space", long, ""]);
  assert.deepEqual(qs, [`repo:${REPO} is:pr base:a base:b/c sort:updated-desc`]);
  assert.deepEqual(searchQueries(REPO, "head", []), []);
});

test("buildEntriesQuery: one alias per stack", () => {
  const q = buildEntriesQuery({ repo: REPO, reps: [{ stack: 57745, number: 57736 }, { stack: 57687, number: 57685 }] });
  assert.match(q, /e57745: pullRequest\(number:57736\)/);
  assert.match(q, /e57687: pullRequest\(number:57685\)/);
});

test("response -> rows: the research fixture (no author, no headRefOid in it)", () => {
  const data = readFixture("medium.json").data.repository;
  const row = toRow(data.p57737, REPO);
  assert.equal(row.number, 57737);
  assert.equal(row.state, "open");
  assert.equal(row.review, "required");
  assert.equal(row.conflicts, true);
  assert.equal(row.mergeState, "DIRTY");
  assert.equal(row.author, null);
  assert.equal(row.headOid, "46c5d1ad0e7d547fa05229824201f6de9b2779f4", "falls back to the last commit's oid");
  assert.equal(row.head, "feature-5");
  assert.equal(row.base, "feature-4");
  assert.equal(row.checks.state, "fail");
  assert.deepEqual({ ...row.checks }, { state: "fail", pass: 17, fail: 45, pending: 0, skip: 83 }, "ACTION_REQUIRED 1 + CANCELLED 43 + FAILURE 1 = fail");
  assert.equal(row.autoMerge, false);
  assert.equal(row._native.number, 57745);
  assert.equal(row._native.position, 2);
});

test("response -> rows: the real answer to the query in use", () => {
  const res = readFixture("real-response.json");
  const repo = res.data.repository;
  const r1 = toRow(repo.p57736, REPO);
  assert.equal(r1.author, "dev-1");
  assert.equal(r1.headOid, repo.p57736.headRefOid);
  assert.equal(r1.createdAt, "2026-11-07T13:25:49Z");
  assert.equal(r1.review, "approved");
  assert.equal(r1.checks.state, "pass");
  assert.equal(r1._native.total, 9, "stack.entries.totalCount");
  const merged = toRow(repo.p57557, REPO);
  assert.equal(merged.state, "merged");
  assert.ok(merged.mergedAt);
  assert.ok(res.data.s0.nodes.length >= 1);
  assert.equal(typeof res.data.s0.nodes[0].number, "number");
  // every row is JSON-clean: no hidden fields in the file
  assert.ok(!("_native" in JSON.parse(JSON.stringify(r1))));
  assert.deepEqual(Object.keys(r1), ["repo", "number", "title", "url", "author", "state", "head", "base", "headOid", "createdAt", "updatedAt", "mergedAt", "closedAt", "additions", "deletions", "changedFiles", "review", "mergeState", "conflicts", "autoMerge", "checks", "parent", "stack", "by"]);
});

test("conflicts only count on open and draft PRs", () => {
  assert.equal(toRow({ number: 1, state: "OPEN", mergeable: "CONFLICTING" }, REPO).conflicts, true);
  assert.equal(toRow({ number: 1, state: "OPEN", isDraft: true, mergeable: "CONFLICTING" }, REPO).conflicts, true);
  assert.equal(toRow({ number: 1, state: "MERGED", mergeable: "CONFLICTING" }, REPO).conflicts, false);
  assert.equal(toRow({ number: 1, state: "CLOSED", mergeable: "CONFLICTING" }, REPO).conflicts, false);
});

test("a draft PR is draft, a closed one is closed", () => {
  assert.equal(toRow({ number: 1, state: "OPEN", isDraft: true }, REPO).state, "draft");
  assert.equal(toRow({ number: 1, state: "CLOSED", isDraft: true }, REPO).state, "closed");
  const r = toRow({ number: 1, state: "OPEN", commits: { nodes: [{ commit: { oid: "a", statusCheckRollup: null } }] } }, REPO);
  assert.deepEqual({ ...r.checks }, { state: "none", pass: 0, fail: 0, pending: 0, skip: 0 });
  assert.equal(r.review, "none");
});

test("fetchPrs splits into requests of at most 50 aliases", async () => {
  const sizes = [];
  const run = fakeRun([[(c, a) => c === "gh" && a[0] === "api", (c, a) => {
    const q = queryOf(a);
    const n = (q.match(/\bp\d+: pullRequest/g) ?? []).length + (q.match(/\bs\d+: search/g) ?? []).length;
    sizes.push(n);
    const repo = {};
    for (const m of q.matchAll(/p(\d+): pullRequest/g)) repo[`p${m[1]}`] = { number: Number(m[1]), state: "OPEN" };
    return { stdout: JSON.stringify({ data: { repository: repo, rateLimit: { cost: 1, remaining: 4000, resetAt: "x" } } }) };
  }]]);
  const numbers = Array.from({ length: 120 }, (_, i) => i + 1);
  const r = await fetchPrs(run, REPO, { numbers });
  assert.deepEqual(sizes, [50, 50, 20]);
  assert.equal(r.nodes.size, 120);
  assert.equal(r.failure, null);
});

test("fetchPrs: searches fill the first request, then numbers", async () => {
  const seen = [];
  const run = fakeRun([[(c) => c === "gh", (c, a) => {
    const q = queryOf(a);
    seen.push({ s: (q.match(/\bs\d+: search/g) ?? []).length, p: (q.match(/\bp\d+: pullRequest/g) ?? []).length });
    return { stdout: JSON.stringify({ data: { repository: {}, s0: { nodes: [{ number: 9, state: "OPEN" }] }, s1: { nodes: [] } } }) };
  }]]);
  const r = await fetchPrs(run, REPO, { numbers: [1, 2], searches: ["a", "b"] });
  assert.deepEqual(seen, [{ s: 2, p: 2 }]);
  assert.deepEqual(r.hits, [[9], []]);
  assert.deepEqual([...r.nodes.keys()], [], "search hits are numbers; the rows come from asking for them");
});

test("the no-stack retry: a GitHub without stacked PRs rejects the fields; the query is asked again without them", async () => {
  const queries = [];
  const run = fakeRun([[(c) => c === "gh", (c, a) => {
    const q = queryOf(a);
    queries.push(q);
    if (/stack/.test(q)) {
      return { code: 1, stdout: JSON.stringify({ errors: [{ message: "Field 'stack' doesn't exist on type 'PullRequest'", locations: [] }] }), stderr: "gh: Field 'stack' doesn't exist on type 'PullRequest'" };
    }
    return { stdout: JSON.stringify({ data: { repository: { p5: { number: 5, state: "OPEN", title: "t" } } } }) };
  }]]);
  const r = await fetchPrs(run, REPO, { numbers: [5] });
  assert.equal(queries.length, 2);
  assert.ok(/stack/.test(queries[0]) && !/stack/.test(queries[1]));
  assert.equal(r.stackUnsupported, true);
  assert.equal(r.failure, null);
  assert.ok(r.nodes.has(5));
  assert.equal(isStackSchemaError([{ message: "Field 'stackEntry' doesn't exist on type 'PullRequest'" }]), true);
  assert.equal(isStackSchemaError([{ message: "Something else" }]), false);
});

test("partial answers: NOT_FOUND is quiet, other errors are kept, data is used", async () => {
  const run = fakeRun([[(c) => c === "gh", {
    code: 1,
    stdout: JSON.stringify({
      data: { repository: { p1: { number: 1, state: "OPEN" }, p2: null } },
      errors: [{ type: "NOT_FOUND", path: ["repository", "p2"], message: "Could not resolve to a PullRequest with the number of 2." }, { type: "FORBIDDEN", message: "Resource protected by SAML" }],
    }),
  }]]);
  const r = await fetchPrs(run, REPO, { numbers: [1, 2] });
  assert.deepEqual([...r.nodes.keys()], [1]);
  assert.deepEqual(r.errors, ["Resource protected by SAML"]);
  assert.equal(r.failure, null);
});

test("gh failures read well: missing, signed out, offline", async () => {
  assert.match(ghFailure({ code: null, stdout: "", stderr: "", error: "ENOENT: gh not found" }), /not installed/);
  assert.match(ghFailure({ code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" }), /not signed in/);
  assert.match(ghFailure({ code: 1, stdout: "", stderr: "error connecting to api.github.com" }), /no network/);
  assert.match(ghFailure({ code: null, stdout: "", stderr: "", error: "timeout after 20s" }), /timed out/);
  const run = fakeRun([[(c) => c === "gh", { code: 4, stderr: "gh auth login" }]]);
  const r = await fetchPrs(run, REPO, { numbers: [1, 2] });
  assert.match(r.failure, /not signed in/);
  assert.deepEqual(r.failedNumbers, [1, 2]);
  assert.equal(r.nodes.size, 0);
});

test("fetchStackEntries reads the members from the real answer", async () => {
  const real = readFixture("real-entries.json");
  const run = fakeRun([[(c) => c === "gh", { stdout: JSON.stringify(real) }]]);
  const r = await fetchStackEntries(run, REPO, [{ stack: 57745, number: 57736 }, { stack: 57687, number: 57685 }]);
  assert.deepEqual(r.members.get(57745).map((m) => m.number), [57736, 57737, 57738, 57739, 57740, 57741, 57742, 57743, 57744]);
  assert.deepEqual(r.members.get(57745).map((m) => m.position), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(r.members.get(57687).map((m) => m.number), [57685, 57686]);
  assert.equal(MAX_ALIASES, 50);
});
