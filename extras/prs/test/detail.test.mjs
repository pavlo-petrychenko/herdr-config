import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DIFF_LIMIT, cutBytes, detail, findRow } from "../lib/detail.mjs";
import { fakeRun, queryOf, tmp } from "./helpers.mjs";

const REPO = "o/r";
const sh = (n) => (c, a) => c === "gh" && a[0] === "pr" && a[1] === n;

function homeWith(row) {
  const home = tmp();
  const f = path.join(home, "data/prs/t1.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ version: 1, at: "2026-11-09T10:00:00Z", prs: row ? [row] : [] }));
  return home;
}

test("body: description, author, reviewers", async () => {
  const run = fakeRun([[sh("view"), { stdout: JSON.stringify({ title: "T", body: "## Hi\ntext", author: { login: "me" }, latestReviews: [{ author: { login: "bob" }, state: "APPROVED" }], reviewRequests: [{ login: "amy" }, { name: "core-team" }] }) }]]);
  const d = await detail({ repo: REPO, number: 5, part: "body", run, home: tmp() });
  assert.deepEqual(d, { part: "body", title: "T", body: "## Hi\ntext", author: "me", reviewers: [{ login: "bob", state: "APPROVED" }], requested: ["amy", "core-team"] });
  assert.deepEqual(run.calls[0].args.slice(0, 5), ["pr", "view", "5", "-R", "o/r"]);
});

test("checks: latest run per check, skipped dropped, fail then pending then pass", async () => {
  const rollup = [
    { __typename: "CheckRun", name: "a", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-01T10:00:00Z", completedAt: "2026-11-01T10:00:30Z", detailsUrl: "https://github.com/o/r/actions/runs/9/job/8" },
    { __typename: "CheckRun", name: "b", workflowName: "CI", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-01T10:00:00Z", completedAt: "2026-11-01T10:00:30Z" },
    { __typename: "CheckRun", name: "b", workflowName: "CI", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-11-01T09:00:00Z", completedAt: "2026-11-01T09:00:30Z" },
    { __typename: "CheckRun", name: "c", workflowName: "CI", status: "COMPLETED", conclusion: "SKIPPED", startedAt: "2026-11-01T10:00:00Z" },
    { __typename: "CheckRun", name: "d", workflowName: "CI", status: "QUEUED", conclusion: null, startedAt: "2026-11-01T10:00:00Z" },
  ];
  const run = fakeRun([[sh("view"), { stdout: JSON.stringify({ statusCheckRollup: rollup }) }]]);
  const d = await detail({ repo: REPO, number: 5, part: "checks", run, home: tmp() });
  assert.deepEqual(d.checks.map((c) => `${c.result}:${c.name}`), ["fail:b", "pending:d", "pass:a"]);
  assert.deepEqual(d.counts, { pass: 1, fail: 1, pending: 1, skip: 1 }, "skipped ones are counted, not listed");
  assert.equal(d.checks[2].runId, "9");
});

test("files: REST paging beyond 100", async () => {
  const page = (n, count) => Array.from({ length: count }, (_, i) => ({ filename: `src/f${n}-${i}.ts`, additions: i, deletions: 1, status: "modified" }));
  const run = fakeRun([[(c, a) => c === "gh" && a[0] === "api", (c, a) => {
    const m = /&page=(\d+)/.exec(a[1]);
    const n = Number(m[1]);
    return { stdout: JSON.stringify(n === 1 ? page(1, 100) : n === 2 ? [...page(2, 29), { filename: "new.ts", previous_filename: "old.ts", additions: 0, deletions: 0, status: "renamed" }] : []) };
  }]]);
  const d = await detail({ repo: REPO, number: 5, part: "files", run, home: tmp() });
  assert.equal(d.total, 130);
  assert.equal(d.truncated, false);
  assert.equal(run.calls.length, 2, "stops at the first page with fewer than 100");
  assert.deepEqual(d.files.at(-1), { path: "new.ts", additions: 0, deletions: 0, status: "renamed", previousPath: "old.ts" });
  assert.deepEqual(d.files[3], { path: "src/f1-3.ts", additions: 3, deletions: 1, status: "modified" });
  assert.match(run.calls[0].args[1], /^repos\/o\/r\/pulls\/5\/files\?per_page=100&page=1$/);
});

test("diff: cut at 900 KB at a line end, truncated:true; a small diff is whole", async () => {
  const line = `+${"x".repeat(98)}\n`;
  const big = line.repeat(Math.ceil((1.2 * 1024 * 1024) / line.length));
  const run = fakeRun([[sh("diff"), { stdout: big }]]);
  const d = await detail({ repo: REPO, number: 5, part: "diff", run, home: tmp() });
  assert.equal(d.truncated, true);
  assert.ok(Buffer.byteLength(d.diff) <= DIFF_LIMIT);
  assert.ok(Buffer.byteLength(d.diff) > DIFF_LIMIT - 200);
  assert.ok(d.diff.endsWith("\n") === false || d.diff.endsWith(line.slice(-100)), "cut at a line end");
  assert.equal(d.bytes, Buffer.byteLength(big));
  assert.deepEqual(cutBytes("a\nb\n", 100), { text: "a\nb\n", truncated: false });
  assert.deepEqual(cutBytes("ab\ncd\nef", 5), { text: "ab\ncd", truncated: true });

  const small = fakeRun([[sh("diff"), { stdout: "diff --git a b\n" }]]);
  assert.deepEqual(await detail({ repo: REPO, number: 5, part: "diff", run: small, home: tmp() }), { part: "diff", diff: "diff --git a b\n", bytes: 15, truncated: false });
});

test("diff: GitHub refuses a huge diff", async () => {
  const run = fakeRun([[sh("diff"), { code: 1, stderr: "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000) (too_large)" }]]);
  const d = await detail({ repo: REPO, number: 5, part: "diff", run, home: tmp() });
  assert.match(d.error, /too large/);
});

test("threads: author, path, line, body, resolved", async () => {
  const answer = { data: { repository: { pullRequest: { reviewThreads: { totalCount: 2, nodes: [
    { isResolved: false, isOutdated: false, path: "a.ts", line: 12, originalLine: 10, comments: { nodes: [{ author: { login: "bob" }, body: "Why?", createdAt: "t1", url: "u1" }, { author: { login: "me" }, body: "Because.", createdAt: "t2", url: "u2" }] } },
    { isResolved: true, isOutdated: true, path: "b.ts", line: null, originalLine: 3, comments: { nodes: [{ author: null, body: "gone", createdAt: "t3", url: "u3" }] } },
  ] } } } } };
  const run = fakeRun([[(c, a) => c === "gh" && a[1] === "graphql", (c, a) => { assert.match(queryOf(a), /pullRequest\(number:5\)/); return { stdout: JSON.stringify(answer) }; }]]);
  const d = await detail({ repo: REPO, number: 5, part: "threads", run, home: tmp() });
  assert.equal(d.total, 2);
  assert.deepEqual(d.threads[0], { resolved: false, outdated: false, path: "a.ts", line: 12, author: "bob", body: "Why?", url: "u1", createdAt: "t1", replies: [{ author: "me", body: "Because.", createdAt: "t2" }] });
  assert.deepEqual([d.threads[1].resolved, d.threads[1].line, d.threads[1].author], [true, 3, null]);
});

test("a failing gh is an error field, not an exception", async () => {
  const run = fakeRun([[(c) => c === "gh", { code: 4, stderr: "gh auth login" }]]);
  const d = await detail({ repo: REPO, number: 5, part: "body", run, home: tmp() });
  assert.match(d.error, /not signed in/);
});

test("cache: keyed by head commit and update time; --fresh skips it; a pending check list is short-lived", async () => {
  const row = { repo: REPO, number: 5, headOid: "abc", updatedAt: "2026-11-09T09:00:00Z", checks: { state: "pass", pass: 3, fail: 0, pending: 0 } };
  const home = homeWith(row);
  assert.deepEqual(findRow(home, REPO, 5), row);
  assert.equal(findRow(home, REPO, 6), null);
  let n = 0;
  const run = fakeRun([[sh("view"), () => ({ stdout: JSON.stringify({ title: `T${++n}`, body: "b" }) })]]);
  const get = (extra = {}) => detail({ repo: REPO, number: 5, part: "body", run, home, ...extra });
  assert.equal((await get()).title, "T1");
  const again = await get();
  assert.equal(again.title, "T1");
  assert.equal(again.cached, true);
  assert.equal(n, 1);
  assert.equal((await get({ fresh: true })).title, "T2");
  // the PR moved on: the data file has a new update time
  fs.writeFileSync(path.join(home, "data/prs/t1.json"), JSON.stringify({ version: 1, at: "2026-11-09T10:05:00Z", prs: [{ ...row, updatedAt: "2026-11-09T10:04:00Z" }] }));
  assert.equal((await get()).title, "T3");

  // checks while pending
  const pend = { ...row, checks: { state: "pending", pass: 1, fail: 0, pending: 2 } };
  const home2 = homeWith(pend);
  let m = 0;
  const run2 = fakeRun([[sh("view"), () => ({ stdout: JSON.stringify({ statusCheckRollup: [], n: ++m }) })]]);
  let t = 1000;
  const getC = () => detail({ repo: REPO, number: 5, part: "checks", run: run2, home: home2, now: () => t });
  await getC();
  t += 5000;
  assert.equal((await getC()).cached, true);
  t += 20000;
  assert.equal((await getC()).cached, undefined);
  assert.equal(m, 2);
});

test("no data file row: no cache is written", async () => {
  const home = tmp();
  const run = fakeRun([[sh("view"), { stdout: JSON.stringify({ title: "T", body: "" }) }]]);
  await detail({ repo: REPO, number: 5, part: "body", run, home });
  assert.ok(!fs.existsSync(path.join(home, "data/prs/cache/detail")));
});
