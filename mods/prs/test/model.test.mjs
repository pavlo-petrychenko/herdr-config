import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as M from "../model.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(here, "fixtures/t35.json"), "utf8");
const { data: FILE } = M.parseData(raw);

/** A row in the shape of the data file. */
const pr = (number, o = {}) => ({
  repo: "acme/app", number, title: `PR ${number}`, url: `https://github.com/acme/app/pull/${number}`, author: "me", state: "open",
  head: `b${number}`, base: "main", headOid: `oid${number}`, createdAt: "2026-11-01T00:00:00Z", updatedAt: `2026-11-0${number % 9 + 1}T00:00:00Z`,
  mergedAt: null, closedAt: null, additions: 1, deletions: 1, changedFiles: 1, review: "none", mergeState: "CLEAN", conflicts: false, autoMerge: false,
  checks: { state: "pass", pass: 1, fail: 0, pending: 0, skip: 0 }, parent: null, stack: null, by: [{ kind: "agent" }], ...o,
});
const stackOf = (id, nums, o = {}) => nums.map((n, i) => pr(n, { stack: { id, native: false, position: i + 1 }, parent: i ? nums[i - 1] : null, ...(o[n] ?? {}) }));
const nums = (list) => list.map((x) => x.p.number);

test("the real file shape: rows normalize", () => {
  assert.equal(FILE.prs.length, 8);
  const draft = FILE.prs.find((p) => p.number === 57783);
  assert.equal(M.stateOf(draft), "draft");
  assert.equal(M.checksOf(draft), "pass");
  assert.equal(M.reviewOf(draft), "approved");
  assert.equal(M.mergeOf(draft).key, "draft");
  assert.equal(M.checksOf(FILE.prs.find((p) => p.number === 57784)), "pending");
  assert.equal(M.checksOf({}), "none");
  assert.equal(M.idOf(draft), "acme/shop#57783");
});

test("checks come from checks.state, never from the counts", () => {
  assert.equal(M.checksOf(pr(1, { checks: { state: "pass", pass: 5, fail: 3, pending: 0, skip: 0 } })), "pass");
  assert.equal(M.checksOf(pr(1, { checks: { state: "none", pass: 0, fail: 0, pending: 0, skip: 0 } })), "none");
});

test("mergeOf: conflicts win, merged and closed are final", () => {
  assert.equal(M.mergeOf(pr(1, { conflicts: true })).key, "conflicts");
  assert.equal(M.mergeOf(pr(1, { mergeState: "BLOCKED" })).key, "blocked");
  assert.equal(M.mergeOf(pr(1, { mergeState: "UNSTABLE" })).key, "unstable");
  assert.equal(M.mergeOf(pr(1, { mergeState: "BEHIND" })).key, "behind");
  assert.equal(M.mergeOf(pr(1, { state: "merged", conflicts: true })).key, "merged");
  assert.equal(M.mergeOf(pr(1, { state: "closed" })).key, "closed");
  assert.equal(M.mergeOf(pr(1, { mergeState: null })).key, "unknown");
});

test("parseData: version, shape, errors default", () => {
  assert.match(M.parseData("nope").error, /not valid JSON/);
  assert.match(M.parseData('{"version":2,"prs":[]}').error, /version/);
  assert.match(M.parseData('{"version":1}').error, /no PR list/);
  const ok = M.parseData('{"version":1,"prs":[],"stale":1}').data;
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.stale, true);
});

test("errorLine: the first error and how many more", () => {
  assert.equal(M.errorLine([]), null);
  assert.deepEqual(M.errorLine([{ kind: "gh", message: "gh is not signed in: run `gh auth login`" }]), { text: "gh is not signed in: run `gh auth login`", kind: "gh", more: 0 });
  assert.equal(M.errorLine([{ kind: "a", message: "x" }, { kind: "b", message: "y" }, { kind: "c", message: "z" }]).more, 2);
});

test("updatedLabel and age", () => {
  const at = "2026-11-09T10:00:00Z";
  const t = (s) => Date.parse(at) + s * 1000;
  assert.equal(M.updatedLabel(at, t(3)), "Updated just now");
  assert.equal(M.updatedLabel(at, t(20)), "Updated 20 s ago");
  assert.equal(M.updatedLabel(at, t(59)), "Updated 50 s ago");
  assert.equal(M.updatedLabel(at, t(125)), "Updated 2 min ago");
  assert.equal(M.updatedLabel(at, t(3 * 3600)), "Updated 3 h ago");
  assert.equal(M.updatedLabel("junk"), "");
  assert.equal(M.age(at, t(90)), "2m");
  assert.equal(M.age(at, t(3 * 3600)), "3h");
});

test("splitTitle", () => {
  assert.deepEqual(M.splitTitle("[Area H | Topic 5]: Run the chain (T-6)"), { area: "Area H | Topic 5", text: "Run the chain", ticket: "T-6" });
  assert.equal(M.splitTitle("plain").text, "plain");
});

// ---- scopes and makers ----

test("Agent scope: every PR whose `by` has a kind other than other", () => {
  const prs = [pr(1), pr(2, { by: [{ kind: "other" }] }), pr(3, { by: [{ kind: "worktree" }] }), pr(4, { by: [{ kind: "subagent", name: "S" }] })];
  assert.deepEqual(prs.filter((p) => M.inScope(p, "agent")).map((p) => p.number), [1, 3, 4]);
  assert.deepEqual(prs.filter((p) => M.inScope(p, "worktree")).map((p) => p.number), [3]);
  assert.deepEqual(M.scopeCounts(prs), { worktree: 1, agent: 3 });
});

test("scope counts count open and draft PRs only", () => {
  const prs = [pr(1), pr(2, { state: "draft" }), pr(3, { state: "merged" }), pr(4, { state: "closed" })];
  assert.deepEqual(M.scopeCounts(prs), { worktree: 0, agent: 2 });
  assert.deepEqual(M.scopeCounts(FILE.prs), { worktree: 0, agent: 2 });
});

test("makers and the chip a row shows", () => {
  const p = pr(1, { by: [{ kind: "worktree" }, { kind: "agent" }, { kind: "subagent", name: "Fixer" }, { kind: "workflow", name: "wf-x" }] });
  assert.deepEqual(M.makersOf(p).map((m) => m.key), ["agent", "subagent:Fixer", "workflow:wf-x"]);
  assert.equal(M.creatorOf(p).label, "Fixer");
  assert.equal(M.creatorOf(pr(1, { by: [{ kind: "worktree" }] })).label, "this worktree");
  assert.equal(M.creatorOf(pr(1, { by: [{ kind: "other" }], author: "zed" })).label, "zed");
  assert.equal(M.creatorOf(pr(1, { by: [{ kind: "agent" }, { kind: "workflow", name: "w" }] })).label, "w");
});

test("chips: by creator, for what the list shows; filtering keeps the stacks that hold them", () => {
  const prs = [
    ...stackOf("acme/app#1", [10, 11, 12], { 10: { by: [{ kind: "subagent", name: "A" }] }, 11: { by: [{ kind: "subagent", name: "B" }] }, 12: { by: [{ kind: "subagent", name: "A" }] } }),
    pr(20, { by: [{ kind: "agent" }] }), pr(21, { by: [{ kind: "workflow", name: "wf" }] }), pr(22, { by: [{ kind: "workflow", name: "wf" }], state: "merged" }),
  ];
  assert.deepEqual(M.creators(prs, "agent").map((c) => [c.key, c.n]), [["agent", 1], ["subagent:A", 2], ["subagent:B", 1], ["workflow:wf", 1]]);
  // A merged PR counts once the done toggle shows it.
  assert.equal(M.creators(prs, "agent", { showDone: true }).find((c) => c.key === "workflow:wf").n, 2);
  const g = M.groups(prs, { scope: "agent", filter: "subagent:B" });
  assert.equal(g.live.length, 1);
  assert.deepEqual(g.live[0].chain.map((x) => [x.p.number, x.inScope]), [[10, false], [11, true], [12, false]]);
  assert.deepEqual(M.groups(prs, { scope: "agent", filter: "agent" }).live.map((x) => x.id), ["pr:acme/app#20"]);
});

// ---- groups ----

test("stacks and singles: order, positions, rail data", () => {
  const prs = [
    pr(30, { updatedAt: "2026-11-05T00:00:00Z" }),
    ...stackOf("acme/app~1", [1, 2, 3], { 3: { updatedAt: "2026-11-08T00:00:00Z" } }),
    pr(31, { updatedAt: "2026-11-07T00:00:00Z" }),
  ];
  const g = M.groups(prs, { scope: "agent" });
  assert.deepEqual(g.live.map((x) => [x.kind, x.id]), [["stack", "stack:acme/app~1"], ["single", "pr:acme/app#31"], ["single", "pr:acme/app#30"]]);
  const st = g.live[0];
  assert.deepEqual(st.chain.map((x) => [x.p.number, x.pos, x.depth]), [[1, 1, 0], [2, 2, 0], [3, 3, 0]]);
  assert.equal(st.base, "main");
  assert.equal(st.foreignBase, false);
  assert.equal(st.hidden, 0);
  const items = M.listItems(g);
  assert.deepEqual(items.map((i) => i.kind), ["section", "head", "base", "row", "row", "row", "section", "row", "row"]);
  assert.deepEqual(M.rowOrder(items), ["acme/app#1", "acme/app#2", "acme/app#3", "acme/app#31", "acme/app#30"]);
  assert.deepEqual(items.filter((i) => i.kind === "row" && i.group === st).map((i) => [i.first, i.last]), [[true, false], [false, false], [false, true]]);
});

test("a native stack uses GitHub's positions; a lower merged member that is gone leaves a gap in the numbers", () => {
  const prs = stackOf("acme/app#9", [5, 6]).map((p, i) => ({ ...p, stack: { id: "acme/app#9", native: true, position: i + 3 } }));
  const g = M.groups(prs, { scope: "agent" });
  assert.deepEqual(g.live[0].chain.map((x) => x.pos), [3, 4]);
});

test("a stack with a fork: the second child goes one deeper", () => {
  const prs = [pr(1, { stack: { id: "acme/app~1", native: false, position: 1 } }),
    pr(2, { parent: 1, stack: { id: "acme/app~1", native: false, position: 2 } }), pr(3, { parent: 1, stack: { id: "acme/app~1", native: false, position: 2 } })];
  assert.deepEqual(M.groups(prs, { scope: "agent" }).live[0].chain.map((x) => [x.p.number, x.depth]), [[1, 0], [2, 0], [3, 1]]);
});

test("a base that is not a default branch shows as foreign", () => {
  const prs = stackOf("acme/app~1", [1, 2], { 1: { base: "feature/x" } });
  assert.equal(M.groups(prs, { scope: "agent" }).live[0].foreignBase, true);
});

test("stack name: the common area after the bar", () => {
  const prs = [pr(1, { title: "[A | Fallback]: one" }), pr(2, { title: "[B | Fallback]: two" }), pr(3, { title: "[X]: three" })];
  assert.equal(M.stackName(prs), "Fallback");
  assert.equal(M.stackName([pr(1, { title: "plain title" })]), "plain title");
});

test("Worktree scope: the rest of the stack folds into n more; expanded unfolds", () => {
  const prs = stackOf("acme/app#1", [1, 2, 3, 4], { 3: { by: [{ kind: "worktree" }, { kind: "agent" }] } });
  const g = M.groups(prs, { scope: "worktree" });
  assert.equal(g.live.length, 1);
  assert.deepEqual(g.live[0].chain.map((x) => x.p.number), [3]);
  assert.equal(g.live[0].hidden, 3);
  assert.equal(g.live[0].size, 4);
  const items = M.listItems(g);
  assert.deepEqual(items.map((i) => i.kind), ["section", "head", "base", "row", "more"]);
  assert.equal(items.find((i) => i.kind === "more").n, 3);
  assert.equal(items.find((i) => i.kind === "row").last, false, "the rail continues into the fold row");
  const open = M.groups(prs, { scope: "worktree", expanded: new Set(["stack:acme/app#1"]) });
  assert.deepEqual(open.live[0].chain.map((x) => [x.p.number, x.inScope]), [[1, false], [2, false], [3, true], [4, false]]);
  assert.equal(open.live[0].hidden, 0);
  // Agent scope never folds.
  assert.equal(M.groups(prs, { scope: "agent" }).live[0].hidden, 0);
});

test("Worktree scope: a stack with no PR of the worktree is not listed", () => {
  const prs = stackOf("acme/app#1", [1, 2]);
  assert.equal(M.groups(prs, { scope: "worktree" }).live.length, 0);
});

// ---- done ----

test("merged PRs stay in their stack, dimmed, while the stack has an open or draft PR", () => {
  const prs = stackOf("acme/app#1", [1, 2, 3], { 1: { state: "merged", mergedAt: "2026-11-02T00:00:00Z" }, 3: { state: "draft" } });
  const g = M.groups(prs, { scope: "agent" });
  assert.deepEqual(g.live[0].chain.map((x) => [x.p.number, x.p.state]), [[1, "merged"], [2, "open"], [3, "draft"]]);
  assert.equal(g.doneCount, 0);
  assert.deepEqual(M.stackStats(g.live[0]), { fail: 0, pending: 0, conflicts: 0, pass: 2, merged: 1, live: 2 });
});

test("a closed PR inside a live stack hides; the rows above it sit on the next one down", () => {
  const prs = stackOf("acme/app#1", [1, 2, 3], { 2: { state: "closed" } });
  const g = M.groups(prs, { scope: "agent" });
  assert.deepEqual(nums(g.live[0].chain), [1, 3]);
  assert.deepEqual(g.live[0].chain.map((x) => x.depth), [0, 0]);
  assert.equal(g.doneCount, 1);
  const all = M.groups(prs, { scope: "agent", showDone: true });
  assert.deepEqual(nums(all.live[0].chain), [1, 2, 3]);
});

test("standalone merged, standalone closed and a fully merged stack hide behind the toggle", () => {
  const prs = [
    pr(1), pr(2, { state: "merged" }), pr(3, { state: "closed" }),
    ...stackOf("acme/app#9", [10, 11], { 10: { state: "merged" }, 11: { state: "merged" } }),
  ];
  const g = M.groups(prs, { scope: "agent" });
  assert.deepEqual(g.live.map((x) => x.id), ["pr:acme/app#1"]);
  assert.deepEqual(g.done, []);
  assert.equal(g.doneCount, 4);
  const items = M.listItems(g);
  assert.deepEqual(M.rowOrder(items), ["acme/app#1"]);

  const all = M.groups(prs, { scope: "agent", showDone: true });
  assert.equal(all.doneCount, 4, "the count stays while shown, for the toggle's label");
  assert.deepEqual(all.live.map((x) => x.id), ["pr:acme/app#1"]);
  assert.deepEqual(all.done.map((x) => x.id).sort(), ["pr:acme/app#2", "pr:acme/app#3", "stack:acme/app#9"]);
  const list = M.listItems(all);
  assert.deepEqual(list.filter((i) => i.kind === "section").map((i) => i.label), ["Single PRs", "Done: stacks", "Done: single PRs"]);
});

test("the real file: two drafts live, the rest is done", () => {
  const g = M.groups(FILE.prs, { scope: "agent" });
  assert.deepEqual(g.live.map((x) => x.chain[0].p.number).sort(), [57783, 57784]);
  assert.equal(g.doneCount, 6);
  const all = M.groups(FILE.prs, { scope: "agent", showDone: true });
  const stack = all.done.find((x) => x.kind === "stack");
  assert.deepEqual(nums(stack.chain), [57514, 57518, 57540]);
  assert.deepEqual(stack.chain.map((x) => x.pos), [1, 2, 3]);
  assert.equal(stack.name, "Topic 6");
  assert.equal(M.groups(FILE.prs, { scope: "worktree" }).live.length, 0);
});

test("done counts follow the scope and the filter", () => {
  const prs = [pr(1, { state: "merged", by: [{ kind: "subagent", name: "A" }] }), pr(2, { state: "merged", by: [{ kind: "worktree" }] }), pr(3, { state: "merged", by: [{ kind: "other" }] })];
  assert.equal(M.groups(prs, { scope: "agent" }).doneCount, 2);
  assert.equal(M.groups(prs, { scope: "worktree" }).doneCount, 1);
  assert.equal(M.groups(prs, { scope: "agent", filter: "subagent:A" }).doneCount, 1);
});

test("stack members that are 'other' show faded in the Agent scope's stacks", () => {
  const prs = stackOf("acme/app#1", [1, 2], { 1: { by: [{ kind: "other" }] } });
  assert.deepEqual(M.groups(prs, { scope: "agent" }).live[0].chain.map((x) => [x.p.number, x.inScope]), [[1, false], [2, true]]);
});

test("stackOf: the preview's dots", () => {
  const prs = [...stackOf("acme/app#1", [1, 2, 3]), pr(9)];
  assert.deepEqual(nums(M.stackOf(prs, prs[1])), [1, 2, 3]);
  assert.deepEqual(M.stackOf(prs, prs[3]), []);
});

test("stackStats ignore the old checks of merged PRs", () => {
  const prs = stackOf("acme/app#1", [1, 2, 3], { 1: { state: "merged", checks: { state: "fail" } }, 2: { checks: { state: "fail" } }, 3: { checks: { state: "pending" }, conflicts: true } });
  const s = M.stackStats(M.groups(prs, { scope: "agent" }).live[0]);
  assert.deepEqual(s, { fail: 1, pending: 1, conflicts: 1, pass: 0, merged: 1, live: 2 });
});

test("a loop in parents does not hang or lose rows", () => {
  const prs = [pr(1, { parent: 2, stack: { id: "s", native: false, position: null } }), pr(2, { parent: 1, stack: { id: "s", native: false, position: null } })];
  assert.deepEqual(nums(M.groups(prs, { scope: "agent" }).live[0].chain).sort(), [1, 2]);
});

test("collapsed stacks keep only their head", () => {
  const prs = stackOf("acme/app#1", [1, 2]);
  const items = M.listItems(M.groups(prs, { scope: "agent" }), { collapsed: new Set(["stack:acme/app#1"]) });
  assert.deepEqual(items.map((i) => i.kind), ["section", "head"]);
});

test("step moves inside the list", () => {
  assert.equal(M.step(["a", "b", "c"], "a", 1), "b");
  assert.equal(M.step(["a", "b", "c"], "c", 1), "c");
  assert.equal(M.step(["a", "b", "c"], "a", -1), "a");
  assert.equal(M.step(["a", "b"], null, 1), "a");
  assert.equal(M.step(["a", "b"], "zz", -1), "b");
  assert.equal(M.step([], "a", 1), null);
});

test("splitPath, cleanBody", () => {
  assert.deepEqual(M.splitPath("src/a/b.js"), { dir: "src/a/", name: "b.js" });
  assert.deepEqual(M.splitPath("b.js"), { dir: "", name: "b.js" });
  assert.equal(M.cleanBody("a<!-- x -->b\r\n<details><summary>Hi</summary>\nin</details>"), "ab\n**Hi**\n\nin");
});

// ---- the agent ----

test("pickAgent: the focused terminal, else the last one of the tab, else the first; none outside a tab with an agent", () => {
  const agents = [{ address: "t1", tab: "A" }, { address: "t2", tab: "A" }, { address: "t3", tab: "B" }];
  assert.equal(M.pickAgent(agents, { tab: "A", terminal: "t2" })?.address, "t2");
  assert.equal(M.pickAgent(agents, { tab: "A", terminal: null }, { A: "t2" })?.address, "t2");
  assert.equal(M.pickAgent(agents, { tab: "A", terminal: "tx" }, { A: "gone" })?.address, "t1");
  assert.equal(M.pickAgent(agents, { tab: "B", terminal: "t1" })?.address, "t3", "a terminal of another tab does not count");
  assert.equal(M.pickAgent(agents, { tab: "C", terminal: null }), null);
  assert.equal(M.pickAgent(agents, null), null);
  assert.equal(M.pickAgent(undefined, { tab: "A" }), null);
});

// ---- the refresh timer ----

test("refreshPlan: hidden never runs", () => {
  assert.deepEqual(M.refreshPlan({ now: 1e6, shown: false, lastEnd: null, force: true }), { run: false, discover: false, wait: null });
  assert.equal(M.refreshPlan({ now: 1e9, shown: false, lastEnd: 1 }).run, false);
});

test("refreshPlan: the first run and a forced run discover", () => {
  assert.deepEqual(M.refreshPlan({ now: 1e6, shown: true, lastEnd: null }), { run: true, discover: true, wait: 0 });
  const r = M.refreshPlan({ now: 1e6, shown: true, lastEnd: 1e6 - 1000, lastDiscover: 1e6 - 1000, force: true });
  assert.deepEqual(r, { run: true, discover: true, wait: 0 });
});

test("refreshPlan: every 45 s, every 15 s while a check is pending", () => {
  const base = { shown: true, lastEnd: 1_000_000, lastDiscover: 1_000_000 };
  assert.deepEqual(M.refreshPlan({ ...base, now: 1_030_000 }), { run: false, discover: false, wait: 15000 });
  assert.deepEqual(M.refreshPlan({ ...base, now: 1_044_999 }), { run: false, discover: false, wait: 1 });
  assert.deepEqual(M.refreshPlan({ ...base, now: 1_045_000 }), { run: true, discover: false, wait: 0 });
  assert.deepEqual(M.refreshPlan({ ...base, now: 1_010_000, pending: true }), { run: false, discover: false, wait: 5000 });
  assert.deepEqual(M.refreshPlan({ ...base, now: 1_015_000, pending: true }), { run: true, discover: false, wait: 0 });
});

test("refreshPlan: discover every 5 minutes, and when the view opens (not more than once a minute)", () => {
  const lastEnd = 1_000_000;
  const at = (ms, o = {}) => M.refreshPlan({ shown: true, lastEnd, now: lastEnd + ms, ...o });
  assert.equal(at(60_000, { lastDiscover: lastEnd - 200_000 }).discover, false);
  assert.equal(at(60_000, { lastDiscover: lastEnd - 240_000 }).discover, true, "5 minutes since the last discover");
  assert.equal(at(60_000, { lastDiscover: lastEnd - 10_000 }).discover, false);
  assert.equal(at(60_000, { lastDiscover: lastEnd - 10_000, opened: true }).discover, true, "opened, last discover over a minute ago");
  assert.equal(at(50_000, { lastDiscover: lastEnd - 5_000, opened: true }).discover, false, "opened again within a minute");
  assert.equal(at(60_000, { lastDiscover: null }).discover, true);
});

test("anyPending looks at open and draft PRs only", () => {
  assert.equal(M.anyPending([pr(1), pr(2, { checks: { state: "pending" } })]), true);
  assert.equal(M.anyPending([pr(1, { state: "merged", checks: { state: "pending" } })]), false);
  assert.equal(M.anyPending(FILE.prs), true);
  assert.equal(M.anyPending([]), false);
});

// ---- the scope the view opens on ----

test("pickScope: Worktree only when it has an open or draft PR; else Agent, whatever was saved", () => {
  const live = [pr(1, { by: [{ kind: "worktree" }, { kind: "agent" }] }), pr(2)];
  const draft = [pr(1, { state: "draft", by: [{ kind: "worktree" }] })];
  const doneOnly = [pr(1, { state: "merged", by: [{ kind: "worktree" }] }), pr(2, { state: "closed", by: [{ kind: "worktree" }, { kind: "agent" }] }), pr(3)];
  assert.equal(M.pickScope(live, "worktree"), "worktree");
  assert.equal(M.pickScope(draft, "worktree"), "worktree");
  assert.equal(M.pickScope(live, "agent"), "agent", "the saved choice is Agent");
  assert.equal(M.pickScope(live, undefined), "agent");
  assert.equal(M.pickScope(doneOnly, "worktree"), "agent", "Worktree has only done PRs: empty");
  assert.equal(M.pickScope([], "worktree"), "agent");
  assert.equal(M.pickScope(FILE.prs, "worktree"), "agent", "the real file has no worktree PR");
});

test("an empty Worktree keeps its count and its done PRs behind the toggle", () => {
  const prs = [pr(1, { state: "merged", by: [{ kind: "worktree" }, { kind: "agent" }] }), pr(2, { state: "closed", by: [{ kind: "worktree" }, { kind: "agent" }] }), pr(3)];
  assert.equal(M.scopeCounts(prs).worktree, 0);
  const g = M.groups(prs, { scope: "worktree" });
  assert.deepEqual(M.listItems(g), []);
  assert.equal(g.doneCount, 2);
  assert.deepEqual(M.rowOrder(M.listItems(M.groups(prs, { scope: "worktree", showDone: true }))).sort(), ["acme/app#1", "acme/app#2"]);
});

test("worktreeEmptyText: the branch, or no worktree", () => {
  assert.equal(M.worktreeEmptyText({ path: "/w", branch: "shop-feature", repo: "o/r" }), "No open PR for branch shop-feature");
  assert.equal(M.worktreeEmptyText({ path: "/w", branch: null, repo: null }), "This agent's folder is not a git worktree");
  assert.equal(M.worktreeEmptyText(null), "This agent's folder is not a git worktree");
  assert.equal(M.worktreeEmptyText(FILE.worktree), "No open PR for branch shop-feature");
});
