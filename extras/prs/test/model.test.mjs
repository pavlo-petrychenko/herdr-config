import test from "node:test";
import assert from "node:assert/strict";
import { checkList, checkResult, checksOf, countChecks, latestRuns, linkRows, mergeBy, reviveRow, summarize, toRow } from "../lib/model.mjs";
import { readFixture } from "./helpers.mjs";

const REPO = "o/r";
let seq = 0;
/** A node as GraphQL returns it. */
const node = (number, head, base, extra = {}) => ({
  number, title: `PR ${number}`, state: "OPEN", isDraft: false, headRefName: head, baseRefName: base,
  updatedAt: `2026-11-0${(seq++ % 9) + 1}T00:00:00Z`, mergeable: "MERGEABLE", ...extra,
});
const rowsOf = (nodes, repo = REPO) => nodes.map((n) => { const r = toRow(n, repo); r.by = [{ kind: "agent" }]; return r; });
const find = (rows, n) => rows.find((r) => r.number === n);

test("native stack: the 9 stacked PRs come out in order with the right parents", () => {
  const repo = readFixture("real-response.json").data.repository;
  const rows = linkRows([57744, 57738, 57736, 57741, 57737, 57740, 57739, 57743, 57742].map((n) => toRow(repo[`p${n}`], "acme/shop")));
  assert.deepEqual(rows.map((r) => r.number), [57736, 57737, 57738, 57739, 57740, 57741, 57742, 57743, 57744]);
  assert.deepEqual(rows.map((r) => r.parent), [null, 57736, 57737, 57738, 57739, 57740, 57741, 57742, 57743]);
  assert.deepEqual(rows.map((r) => r.stack.position), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(rows.every((r) => r.stack.id === "acme/shop#57745" && r.stack.native === true));
});

test("native stack: a merged lower PR stays in place; a missing lower one falls back to the base chain", () => {
  const rows = linkRows(rowsOf([
    node(1, "a", "master", { state: "MERGED", stack: { number: 50 }, stackEntry: { position: 1 } }),
    node(2, "b", "master", { stack: { number: 50 }, stackEntry: { position: 2 } }), // retargeted to master after 1 merged
    node(4, "d", "c", { stack: { number: 50 }, stackEntry: { position: 4 } }),      // position 3 was not fetched
    node(9, "c", "b"),                                                                 // not a member, based on b
  ]));
  assert.equal(find(rows, 2).parent, 1, "sits on the merged PR at position 1");
  assert.equal(find(rows, 4).parent, 2, "nearest lower member");
  assert.equal(find(rows, 9).parent, 2, "head of 9 is c; its base b is PR 2's head");
  assert.deepEqual(find(rows, 9).stack, { id: "o/r#50", native: false, position: null });
});

test("base chain: A <- B <- C, ids by root, positions along the path", () => {
  const rows = linkRows(rowsOf([node(12, "c", "b"), node(10, "a", "master"), node(11, "b", "a"), node(20, "solo", "master")]));
  assert.deepEqual(rows.filter((r) => r.stack).map((r) => [r.number, r.parent, r.stack.id, r.stack.native, r.stack.position]), [
    [10, null, "o/r~10", false, 1], [11, 10, "o/r~10", false, 2], [12, 11, "o/r~10", false, 3],
  ]);
  assert.equal(find(rows, 20).stack, null, "a single PR is in no stack");
  assert.equal(find(rows, 20).parent, null);
  assert.equal(rows.at(-1).number, 20, "stacks first, singles after");
});

test("base chain: two PRs share a parent", () => {
  const rows = linkRows(rowsOf([node(1, "a", "master"), node(2, "b", "a"), node(3, "c", "a")]));
  assert.equal(find(rows, 2).parent, 1);
  assert.equal(find(rows, 3).parent, 1);
  assert.deepEqual([find(rows, 2).stack.position, find(rows, 3).stack.position], [2, 2]);
  assert.ok(rows.every((r) => r.stack.id === "o/r~1"));
});

test("base chain: a loop is cut at its smallest number", () => {
  const rows = linkRows(rowsOf([node(5, "x", "z"), node(6, "y", "x"), node(7, "z", "y")]));
  assert.equal(find(rows, 5).parent, null, "the smallest number becomes the root");
  assert.equal(find(rows, 6).parent, 5);
  assert.equal(find(rows, 7).parent, 6);
  assert.deepEqual(rows.map((r) => r.stack.position).sort(), [1, 2, 3]);
});

test("base chain: a PR based on its own head is no parent of itself", () => {
  const rows = linkRows(rowsOf([node(1, "same", "same")]));
  assert.equal(rows[0].parent, null);
  assert.equal(rows[0].stack, null);
});

test("base chain: an open PR is the parent before a merged one with the same head", () => {
  const rows = linkRows(rowsOf([
    node(1, "feat", "master", { state: "MERGED" }),
    node(2, "feat", "master"),
    node(3, "child", "feat"),
  ]));
  assert.equal(find(rows, 3).parent, 2);
});

test("PRs of different repos never link, even with the same branch names", () => {
  const a = toRow(node(1, "a", "master"), "o/one");
  const b = toRow(node(2, "b", "a"), "o/two");
  const rows = linkRows([a, b]);
  assert.equal(find(rows, 2).parent, null);
});

test("stack ordering: stacks first, newest change first; singles by newest", () => {
  const rows = linkRows(rowsOf([
    node(1, "a", "master", { updatedAt: "2026-01-01T00:00:00Z" }), node(2, "b", "a", { updatedAt: "2026-01-02T00:00:00Z" }),
    node(3, "c", "master", { updatedAt: "2026-02-01T00:00:00Z" }), node(4, "d", "c", { updatedAt: "2026-02-02T00:00:00Z" }),
    node(5, "e", "master", { updatedAt: "2026-03-01T00:00:00Z" }),
    node(6, "f", "master", { updatedAt: "2026-04-01T00:00:00Z" }),
  ]));
  assert.deepEqual(rows.map((r) => r.number), [3, 4, 1, 2, 6, 5]);
});

test("reviveRow gives a row from the last file back its native stack", () => {
  const rows = linkRows(rowsOf([node(1, "a", "master", { stack: { number: 50 }, stackEntry: { position: 1 } }), node(2, "b", "a", { stack: { number: 50 }, stackEntry: { position: 2 } })]));
  const back = JSON.parse(JSON.stringify(rows)).map(reviveRow);
  assert.deepEqual(back.map((r) => r._native), [{ number: 50, position: 1, total: null }, { number: 50, position: 2, total: null }]);
  const again = linkRows(back);
  assert.deepEqual(again.map((r) => [r.number, r.parent, r.stack.id]), [[1, null, "o/r#50"], [2, 1, "o/r#50"]]);
});

test("count and problems: open and draft PRs of the agent; failing checks or conflicts", () => {
  const mk = (n, state, checks, conflicts, kinds) => {
    const r = toRow(node(n, `h${n}`, "master", { state: state === "draft" ? "OPEN" : state.toUpperCase(), isDraft: state === "draft", mergeable: conflicts ? "CONFLICTING" : "MERGEABLE" }), REPO);
    r.checks.state = checks;
    r.by = kinds.map((kind) => ({ kind }));
    return r;
  };
  const rows = [
    mk(1, "open", "pass", false, ["agent"]),
    mk(2, "open", "fail", false, ["subagent"]),            // problem
    mk(3, "draft", "pass", true, ["worktree", "agent"]),   // problem (conflicts)
    mk(4, "draft", "pending", false, ["workflow"]),
    mk(5, "merged", "fail", true, ["agent"]),              // not open
    mk(6, "closed", "fail", true, ["agent"]),              // not open
    mk(7, "open", "fail", true, ["other"]),                // only in a stack: not counted
    mk(8, "open", "none", false, ["other", "agent"]),      // has a real kind
  ];
  assert.deepEqual(summarize(rows), { count: 5, problems: 2 });
  assert.deepEqual(summarize([]), { count: 0, problems: 0 });
});

test("mergeBy: de-duplicates, orders worktree/agent/subagent/workflow, drops other when there is more", () => {
  assert.deepEqual(mergeBy([{ kind: "other" }], [{ kind: "subagent", name: "b" }], [{ kind: "worktree" }], [{ kind: "subagent", name: "b" }, { kind: "agent" }, { kind: "subagent", name: "a" }]).map((b) => b.name ?? b.kind),
    ["worktree", "agent", "a", "b"]);
  assert.deepEqual(mergeBy([{ kind: "other" }]), [{ kind: "other" }]);
  assert.deepEqual(mergeBy(undefined, null), []);
});

test("checks: the rollup state decides; counts map CheckRun and StatusContext states", () => {
  const c = checksOf({
    state: "PENDING",
    contexts: {
      checkRunCountsByState: [{ state: "SUCCESS", count: 3 }, { state: "SKIPPED", count: 10 }, { state: "FAILURE", count: 1 }, { state: "TIMED_OUT", count: 1 }, { state: "QUEUED", count: 2 }, { state: "NEUTRAL", count: 1 }, { state: "COMPLETED", count: 0 }],
      statusContextCountsByState: [{ state: "SUCCESS", count: 2 }, { state: "ERROR", count: 1 }, { state: "EXPECTED", count: 1 }],
    },
  });
  assert.deepEqual({ ...c }, { state: "pending", pass: 5, fail: 3, pending: 3, skip: 11 });
  assert.equal(checksOf({ state: "ERROR", contexts: {} }).state, "fail");
  assert.equal(checksOf({ state: "EXPECTED", contexts: {} }).state, "pending");
  assert.equal(checksOf(null).state, "none");
});

test("checkList: latest run per check, skipped dropped, sorted fail, pending, pass", () => {
  const rollup = [
    { __typename: "CheckRun", name: "lint", workflowName: "CI", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-11-01T10:00:00Z", completedAt: "2026-11-01T10:01:00Z", detailsUrl: "https://github.com/o/r/actions/runs/1/job/11" },
    { __typename: "CheckRun", name: "lint", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-01T11:00:00Z", completedAt: "2026-11-01T11:02:00Z", detailsUrl: "https://github.com/o/r/actions/runs/2/job/22" },
    { __typename: "CheckRun", name: "test", workflowName: "CI", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-01T11:00:00Z", completedAt: "2026-11-01T11:10:00Z", detailsUrl: "https://github.com/o/r/actions/runs/2/job/23" },
    { __typename: "CheckRun", name: "build", workflowName: "CI", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-11-01T11:00:00Z" },
    { __typename: "CheckRun", name: "docs", workflowName: "CI", status: "COMPLETED", conclusion: "SKIPPED", startedAt: "2026-11-01T11:00:00Z" },
    { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", targetUrl: "https://ci.example/1", createdAt: "2026-11-01T11:00:00Z" },
  ];
  assert.equal(latestRuns(rollup).length, 5);
  const list = checkList(rollup);
  assert.deepEqual(list.map((c) => `${c.result}:${c.name}`), ["fail:test", "pending:build", "pass:ci/legacy", "pass:lint"]);
  assert.deepEqual(list.find((c) => c.name === "lint"), { name: "lint", workflow: "CI", result: "pass", url: "https://github.com/o/r/actions/runs/2/job/22", runId: "2", jobId: "22", seconds: 120 });
  assert.deepEqual(countChecks(list), { pass: 2, fail: 1, pending: 1, skip: 0 });
  assert.equal(checkResult({ status: "COMPLETED", conclusion: "NEUTRAL" }), "skip");
});
