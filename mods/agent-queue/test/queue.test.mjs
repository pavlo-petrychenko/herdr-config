import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQueue, classify, sentence, since, stamp, statusKey, parseDeclared, keepsAwake, WAITING_AWAKE_MS, scope, elsewhere, place } from "../queue.js";
import { parseConfig, parseManual } from "../groups.js";

const claude = { name: "Claude Code", key: "claude" };
const agent = (address, status, title, extra = {}) => ({ address, status, title, space_name: "website", tab_name: "1", program: claude, ...extra });
const term = (address, status_ms, msg, extra = {}) => ({ address, status_ms, report: { msg }, ...extra });
const said = (kind, text, at, source = "agent") => ({ kind, text, at, source });

test("classify: a live prompt wins over anything declared", () => {
  assert.deepEqual(classify("blocked", "Claude needs your permission to use Bash: make deploy", said("review", "x", 1), 5), { section: "queue", kind: "approve", why: "Bash: make deploy", since: 5 });
  assert.equal(classify("blocked", "Claude has a question for you", said("answer", "Which flag name?", 3, "question"), 5).why, "Which flag name?");
  assert.deepEqual(classify("working", "Running tests", said("review", "x", 1), 9), { section: "working", kind: null, why: "Running tests", since: 9 });
});

test("classify: a blocking plan review beats working, but not a live prompt", () => {
  const plan = said("review", "Plan waits for your review", 4, "plan-review");
  assert.deepEqual(classify("working", "Running", plan, 9), { section: "queue", kind: "review", why: "Plan waits for your review", since: 4 });
  assert.equal(classify("blocked", "Claude needs your permission to use x", plan, 9).kind, "approve");
});

test("classify: what was declared, after the turn", () => {
  assert.equal(classify("idle", "", said("blocked", "Stage DB rejects my login", 4), 1).kind, "blocked");
  assert.equal(classify("idle", "", said("waiting", "CI is running", 4), 1).section, "working");
  assert.equal(classify("done", "", said("done", "Deleted 3 branches", 4), 1).section, "queue");
  assert.equal(classify("idle", "", said("done", "Deleted 3 branches", 4), 1).section, "quiet");
  assert.equal(classify("idle", "", said("bogus", "x", 4), 1).section, "quiet");
});

test("classify: nothing declared — unseen finish is review, seen idle is quiet", () => {
  assert.deepEqual(classify("done", "Claude is waiting for your input", null, 7), { section: "queue", kind: "review", why: "Claude is waiting for your input", since: 7 });
  assert.equal(classify("idle", "", null, 7).section, "quiet");
});

test("queue order: kind first, then who waited longest; unknown waits last in their kind", () => {
  const declared = new Map([["t1", said("review", "PR ready", 100)], ["t2", said("answer", "Which name?", 300)], ["t3", said("review", "Plan ready", 50)], ["t5", said("waiting", "CI", 10)]]);
  const q = buildQueue(
    [agent("t1", "idle", "A"), agent("t2", "idle", "B"), agent("t3", "idle", "C"), agent("t4", "blocked", "D"), agent("t5", "idle", "E"), agent("t6", "working", "F"), agent("t7", "idle", "G"), agent("t8", "done", "H")],
    [term("t4", 999, "Claude needs your permission to use Bash"), term("t6", 20, "Running"), term("t8", null, "")],
    new Map(),
    declared,
  );
  assert.deepEqual(q.map((s) => [s.key, s.items.map((i) => `${i.address}:${i.kind ?? "-"}`)]), [
    ["queue", ["t4:approve", "t2:answer", "t3:review", "t1:review", "t8:review"]],
    ["working", ["t6:-", "t5:waiting"]],
    ["quiet", ["t7:-"]],
  ]);
});

test("helpers, task names, declared files", () => {
  const [s] = buildQueue([agent("a", "working", "✳ Herdr worktrees")], [term("a", 1, "x"), { address: "h", parent: "a" }, { address: "g", parent: "a", state: "finished" }]);
  assert.deepEqual([s.items[0].task, s.items[0].helpers], ["Herdr worktrees", 1]);
  const [q] = buildQueue([agent("b", "idle", "~/Desktop", { tab_name: "review" })], [], new Map(), new Map([["b", said("review", "x", 1)]]));
  assert.equal(q.items[0].task, "review");
  assert.equal(statusKey("m1/t3"), "m1_t3");
  assert.deepEqual([...parseDeclared('t1.json\t{"kind":"review","text":"x","at":1}\nbad\nt2.json\t{oops\n').keys()], ["t1"]);
});

test("sentence, since, stamp", () => {
  assert.equal(sentence("  ✳ Done. Next part"), "Done.");
  assert.equal(sentence("a".repeat(200), 10), `${"a".repeat(9)}…`);
  assert.deepEqual([since(9000, 21000), since(0, 1), since(1000, 1000 + 4 * 60000)], ["12 s", "", "4 m"]);
  const memo = stamp(new Map(), [{ address: "a", status: "working" }], 1000);
  stamp(memo, [{ address: "a", status: "blocked" }, { address: "c", status: "working" }], 5000);
  assert.deepEqual([memo.get("a"), memo.get("c")], [{ status: "blocked", at: 5000 }, { status: "working", at: 5000 }]);
});

test("keepsAwake: agents at work and recent waits only", () => {
  const working = (...items) => [{ key: "working", items }];
  assert.equal(keepsAwake([]), false);
  assert.equal(keepsAwake([{ key: "queue", items: [{ kind: "review", since: 1 }] }, { key: "quiet", items: [{ kind: null }] }]), false);
  assert.equal(keepsAwake(working({ kind: null, since: null })), true);
  assert.equal(keepsAwake(working({ kind: "waiting", since: 1000 }), 1000 + WAITING_AWAKE_MS - 1), true);
  assert.equal(keepsAwake(working({ kind: "waiting", since: 1000 }), 1000 + WAITING_AWAKE_MS), false);
});

// Groups: the queue shows the shown space's group only.
const RULES = parseConfig(JSON.stringify({ groups: [{ name: "Work", folders: ["~/work/**"] }, { name: "Personal", folders: ["~/me/**"] }] }), "/h");
const sp = (id, folder, active = false, tabs = []) => ({ id, folder, active, tabs });
const SPACES = [sp("w1", "/h/work/api", true), sp("p1", "/h/me/blog"), sp("o1", "/tmp/x")];
const AGENTS = [agent("a", "idle", "api", { space: "w1" }), agent("b", "idle", "blog", { space: "p1" }), agent("c", "idle", "x", { space: "o1" })];

test("place: a space is where its first terminal is, else its folder", () => {
  const s = sp("s", "/h/me", false, [{ id: "t1" }]);
  assert.equal(place(s, [{ tab: "t1", cwd: "/h/work/api" }]), "/h/work/api");
  assert.equal(place(s, [{ tab: "t2", cwd: "/h/work/api" }]), "/h/me");
});

test("scope: only the shown space's group", () => {
  const s = scope(AGENTS, SPACES, [], RULES, parseManual(null));
  assert.equal(s.group, "Work");
  assert.deepEqual(s.mine.map((a) => a.address), ["a"]);
  const p = scope(AGENTS, SPACES.map((x) => ({ ...x, active: x.id === "p1" })), [], RULES, parseManual(null));
  assert.deepEqual([p.group, p.mine.map((a) => a.address)], ["Personal", ["b"]]);
  const o = scope(AGENTS, SPACES.map((x) => ({ ...x, active: x.id === "o1" })), [], RULES, parseManual(null));
  assert.deepEqual([o.group, o.mine.map((a) => a.address)], ["Other", ["c"]]);
});

test("scope: a space you moved goes by your folder; no groups or no shown space = everyone", () => {
  const moved = scope(AGENTS, SPACES, [], RULES, parseManual({ folders: [], of: { p1: "Work" } }));
  assert.deepEqual(moved.mine.map((a) => a.address), ["a", "b"]);
  assert.equal(scope(AGENTS, SPACES, [], { groups: [] }, parseManual(null)).group, null);
  assert.equal(scope(AGENTS, SPACES.map((x) => ({ ...x, active: false })), [], RULES, parseManual(null)).mine.length, 3);
});

test("elsewhere: who waits in the other groups, most first", () => {
  const g = new Map([["p1", "Personal"], ["o1", "Other"], ["o2", "Other"]]);
  const sections = [{ key: "queue", items: [{ spaceId: "p1" }, { spaceId: "o1" }, { spaceId: "o2" }] }, { key: "working", items: [{ spaceId: "p1" }] }];
  assert.deepEqual(elsewhere(sections, g), [{ name: "Other", n: 2 }, { name: "Personal", n: 1 }]);
  assert.deepEqual(elsewhere([], g), []);
});
