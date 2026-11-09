import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dataFile, refresh } from "../lib/refresh.mjs";
import { SESSION, claudeCopy, fakeRun, queryOf, tmp } from "./helpers.mjs";

const WT = "/work/app-wt"; // the terminal's worktree (fake: nothing is read from disk)
const REMOTES = { "/work/app": "git@github.com:acme/app.git", "/work/other": "https://github.com/acme/other.git", [WT]: "ssh://git@github.com/acme/app" };
const BRANCHES = {
  [WT]: "feat/main-work",
  "/work/app/.claude/worktrees/agent-aaa111": "fix/parser",
  "/work/app/.claude/worktrees/wf_123-abc-1": "wf/imports",
};
const exists = (p) => p in REMOTES || p in BRANCHES || p.startsWith("/work/app");

/** GitHub's side: PR nodes by repo and number. */
function world() {
  const mk = (number, head, base, extra = {}) => ({
    number, title: `PR ${number}`, url: `https://github.com/acme/app/pull/${number}`, state: "OPEN", isDraft: false,
    baseRefName: base, headRefName: head, headRefOid: `oid${number}`, updatedAt: `2026-11-0${(number % 9) + 1}T00:00:00Z`, createdAt: "2026-11-01T00:00:00Z",
    mergedAt: null, closedAt: null, author: { login: "me" }, reviewDecision: null, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    additions: 1, deletions: 2, changedFiles: 3, autoMergeRequest: null, stack: null, stackEntry: null,
    commits: { nodes: [{ commit: { oid: `oid${number}`, statusCheckRollup: { state: "SUCCESS", contexts: { totalCount: 1, checkRunCountsByState: [{ state: "SUCCESS", count: 1 }], statusContextCountsByState: [] } } } }] },
    ...extra,
  });
  return {
    "acme/app": new Map([
      [101, mk(101, "feat/main-work", "main")],
      [102, mk(102, "fix/parser", "main", { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })],
      [104, mk(104, "wf/imports", "main", { state: "MERGED", mergedAt: "2026-11-02T00:00:00Z" })],
      [110, mk(110, "other/work", "main", { isDraft: true })],
      [150, mk(150, "wf/imports", "main", { author: { login: "someone" } })],
      [160, mk(160, "child-of-101", "feat/main-work")],
    ]),
    "acme/other": new Map([[103, mk(103, "docs/readme", "main", { url: "https://github.com/acme/other/pull/103" })]]),
  };
}

function setup({ gh, extra = [] } = {}) {
  const { dir, transcript } = claudeCopy();
  const home = tmp("prs-home-");
  const calls = { gh: [] };
  const w = world();
  const ghRule = [(c, a) => c === "gh" && a[0] === "api" && a[1] === "graphql", gh ?? ((c, a) => {
    const q = queryOf(a);
    calls.gh.push(q);
    const m = /repository\(owner:"([^"]+)",name:"([^"]+)"\)/.exec(q);
    const prs = w[`${m?.[1]}/${m?.[2]}`] ?? new Map();
    const data = { rateLimit: { cost: 1, remaining: 4000, resetAt: "2026-11-09T12:00:00Z" } };
    if (m) {
      data.repository = {};
      for (const x of q.matchAll(/p(\d+): pullRequest/g)) data.repository[`p${x[1]}`] = prs.get(Number(x[1])) ?? null;
    }
    for (const x of q.matchAll(/s(\d+): search\(query:("(?:[^"\\]|\\.)*")/g)) {
      const str = JSON.parse(x[2]);
      const repo = /repo:(\S+)/.exec(str)[1];
      const heads = [...str.matchAll(/head:(\S+)/g)].map((y) => y[1]);
      const bases = [...str.matchAll(/base:(\S+)/g)].map((y) => y[1]);
      data[`s${x[1]}`] = { nodes: [...(w[repo] ?? new Map()).values()].filter((n) => heads.includes(n.headRefName) || bases.includes(n.baseRefName)) };
    }
    return { stdout: JSON.stringify({ data }) };
  })];
  const run = fakeRun([
    ["hc get t1", { stdout: JSON.stringify({ pid: 1, foreground: { pid: 2, cwd: WT } }) }],
    ["ps ", { stdout: "  1 0\n  2 1\n" }],
    [(c, a) => c === "git" && a[2] === "remote", (c, a) => (REMOTES[a[1]] ? { stdout: `${REMOTES[a[1]]}\n` } : { code: 128 })],
    [(c, a) => c === "git" && a[2] === "rev-parse", (c, a) => (BRANCHES[a[1]] ? { stdout: `${BRANCHES[a[1]]}\n` } : { code: 128 })],
    [(c, a) => c === "git" && a[2] === "config", { code: 1 }],
    [(c, a) => c === "git" && a[2] === "symbolic-ref", { code: 128 }],
    ghRule,
    ...extra,
  ]);
  const go = (o = {}) => refresh({ terminal: "t1", home, claudeDir: dir, run, exists, sessionArgs: [SESSION], now: () => Date.parse("2026-11-09T10:00:00Z"), ...o });
  return { go, home, dir, transcript, run, calls, world: w };
}

const byOf = (out, n) => out.prs.find((p) => p.number === n).by.map((b) => (b.name ? `${b.kind}:${b.name}` : b.kind));

test("refresh --discover: PRs, who made them, stacks, count, problems; file written", async () => {
  const t = setup();
  const out = await t.go({ discover: true });
  assert.equal(out.version, 1);
  assert.equal(out.terminal, "t1");
  assert.equal(out.stale, false);
  assert.deepEqual(out.worktree, { path: WT, branch: "feat/main-work", repo: "acme/app" });
  assert.deepEqual(out.sessions.map((s) => [s.sessionId, s.from]), [[SESSION, "arg"]]);
  assert.deepEqual(out.errors, [], "ggg777's format error needs a file at rest; these are fresh");
  assert.deepEqual(out.repos, ["acme/app", "acme/other"]);

  assert.deepEqual(byOf(out, 101), ["worktree", "agent"]);
  assert.deepEqual(byOf(out, 102), ["subagent:Fix the parser"]);
  assert.deepEqual(byOf(out, 103), ["subagent:docs-writer"]);
  assert.deepEqual(byOf(out, 104), ["workflow:absolute-imports"]);
  assert.deepEqual(byOf(out, 110), ["agent"], "only a pr-link: the agent");
  assert.deepEqual(byOf(out, 150), ["workflow:absolute-imports"], "found by the branch the workflow pushed");
  assert.deepEqual(byOf(out, 160), ["other"], "only there because it sits on 101");

  // 160's base is 101's head: a stack of two
  const p160 = out.prs.find((p) => p.number === 160);
  assert.equal(p160.parent, 101);
  assert.deepEqual(p160.stack, { id: "acme/app~101", native: false, position: 2 });
  assert.deepEqual(out.prs.find((p) => p.number === 101).stack, { id: "acme/app~101", native: false, position: 1 });

  // open + draft with a real kind: 101, 102, 103, 110, 150 (104 merged, 160 other)
  assert.equal(out.count, 5);
  assert.equal(out.problems, 1, "102 has conflicts");
  assert.deepEqual(out.branches.map((b) => `${b.repo}:${b.name}`), ["acme/app:feat/main-work", "acme/app:fix/parser", "acme/app:wf/imports", "acme/other:docs/readme"]);
  assert.ok(out.discoveredAt);

  const onDisk = JSON.parse(fs.readFileSync(dataFile(t.home, "t1"), "utf8"));
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(out)));
  assert.ok(!JSON.stringify(onDisk).includes("_native"));
  assert.ok(fs.readdirSync(path.dirname(dataFile(t.home, "t1"))).every((n) => !n.endsWith(".tmp")), "no temp file is left");
  assert.deepEqual(Object.keys(onDisk), ["version", "at", "terminal", "stale", "worktree", "sessions", "repos", "prs", "count", "problems", "branches", "discoveredAt", "errors"]);
});

const askedNumbers = (calls) => [...calls.join("\n").matchAll(/p(\d+): pullRequest/g)].map((m) => Number(m[1])).sort();

test("a later refresh without --discover reuses what discovery found, and does not ask for merged PRs again", async () => {
  const t = setup();
  await t.go({ discover: true });
  t.calls.gh.length = 0;
  const out = await t.go();
  const asked = askedNumbers(t.calls.gh);
  assert.ok(asked.includes(150), "the discovered PR is asked by number");
  assert.ok(!asked.includes(104), "104 is merged: its row comes from the last file");
  assert.ok(!t.calls.gh.some((q) => /search\(/.test(q)), "no search without --discover");
  assert.ok(out.prs.some((p) => p.number === 104 && p.state === "merged"));
  assert.equal(out.prs.length, 7);
  assert.deepEqual(byOf(out, 104), ["workflow:absolute-imports"]);
});

test("a branch that was never searched makes the refresh discover by itself", async () => {
  const t = setup();
  await t.go({ discover: true });
  t.calls.gh.length = 0;
  fs.appendFileSync(path.join(path.dirname(t.transcript), `${SESSION}/subagents/agent-bbb222.jsonl`),
    `${JSON.stringify({ cwd: "/work/other", toolUseResult: { gitOperation: { push: { branch: "docs/more" } } } })}\n`);
  await t.go();
  assert.ok(t.calls.gh.some((q) => /search\(/.test(q) && q.includes("head:docs/more")));
  t.calls.gh.length = 0;
  await t.go();
  assert.ok(!t.calls.gh.some((q) => /search\(/.test(q)), "searched once, then not again");
});

test("gh not signed in: errors says so, the last good PRs stay, stale", async () => {
  const t = setup();
  const good = await t.go({ discover: true });
  // same home and claude dir, but gh fails
  const run2 = fakeRun([
    ["hc get t1", { stdout: JSON.stringify({ pid: 1, foreground: { pid: 2, cwd: WT } }) }],
    ["ps ", { stdout: "" }],
    [(c, a) => c === "git" && a[2] === "remote", (c, a) => (REMOTES[a[1]] ? { stdout: `${REMOTES[a[1]]}\n` } : { code: 128 })],
    [(c, a) => c === "git" && a[2] === "rev-parse", (c, a) => (BRANCHES[a[1]] ? { stdout: `${BRANCHES[a[1]]}\n` } : { code: 128 })],
    [(c, a) => c === "git", { code: 1 }],
    [(c) => c === "gh", { code: 4, stderr: "To authenticate, run: gh auth login" }],
  ]);
  const out = await refresh({ terminal: "t1", home: t.home, claudeDir: t.dir, run: run2, exists, sessionArgs: [SESSION], now: () => Date.parse("2026-11-09T10:05:00Z") });
  assert.equal(out.stale, true);
  assert.ok(out.errors.some((e) => e.kind === "gh" && /not signed in/.test(e.message)));
  assert.deepEqual(out.prs.map((p) => p.number).sort(), good.prs.map((p) => p.number).sort(), "the last good rows are kept");
  assert.equal(out.prs.find((p) => p.number === 102).title, "PR 102");
  assert.ok(out.count > 0);
});

test("gh missing and no earlier file: no PRs, an error, exit-0 behaviour (no throw)", async () => {
  const t = setup({ gh: { code: null, error: "ENOENT: gh not found" } });
  const out = await t.go({ discover: true });
  assert.deepEqual(out.prs, []);
  assert.equal(out.stale, true);
  assert.ok(out.errors.some((e) => e.kind === "gh" && /not installed/.test(e.message)));
  assert.equal(out.discoveredAt, null, "a failed discovery is not recorded as done");
});

test("hc failing is an error entry; sessions from --session still work; --cwd overrides the worktree", async () => {
  const t = setup({ extra: [] });
  const run = fakeRun([
    ["hc get", { code: 3, stdout: JSON.stringify({ error: { message: 'no terminal "t1"' } }) }],
    [(c, a) => c === "git" && a[2] === "remote", (c, a) => (REMOTES[a[1]] ? { stdout: `${REMOTES[a[1]]}\n` } : { code: 128 })],
    [(c, a) => c === "git" && a[2] === "rev-parse", (c, a) => (BRANCHES[a[1]] ? { stdout: `${BRANCHES[a[1]]}\n` } : { code: 128 })],
    [(c) => c === "git", { code: 1 }],
    [(c) => c === "gh", (c, a) => ({ stdout: JSON.stringify({ data: { repository: Object.fromEntries([...(world()["acme/app"].entries())].map(([n, v]) => [`p${n}`, v])) } }) })],
  ]);
  const out = await refresh({ terminal: "t1", home: t.home, claudeDir: t.dir, run, exists, sessionArgs: [SESSION], cwdArg: "/work/app/.claude/worktrees/agent-aaa111" });
  assert.ok(out.errors.some((e) => e.kind === "hc"));
  assert.equal(out.worktree.path, "/work/app/.claude/worktrees/agent-aaa111");
  assert.equal(out.worktree.branch, "fix/parser");
  assert.ok(out.prs.length > 0);
  assert.ok(byOf(out, 102).includes("worktree"), "102's head is the worktree's branch");
});

test("no sessions and no worktree: an empty file, not a crash", async () => {
  const home = tmp();
  const run = fakeRun([["hc get", { code: 3, stdout: "{}" }]]);
  const out = await refresh({ terminal: "t5", home, claudeDir: tmp(), run, exists });
  assert.deepEqual([out.prs, out.sessions, out.worktree, out.count, out.problems], [[], [], null, 0, 0]);
  assert.ok(fs.existsSync(dataFile(home, "t5")));
});

test("native stacks: members that were not asked for are completed from the stack entries", async () => {
  const w = world();
  const app = w["acme/app"];
  for (const [n, pos] of [[101, 2], [160, 3], [150, 1]]) {
    const node = app.get(n);
    node.stack = { number: 900, baseRefName: "main", entries: { totalCount: 3 } };
    node.stackEntry = { position: pos };
  }
  let entryQueries = 0;
  const t = setup({
    gh: (c, a) => {
      const q = queryOf(a);
      if (/e900: pullRequest/.test(q)) {
        entryQueries++;
        return { stdout: JSON.stringify({ data: { repository: { e900: { stack: { number: 900, entries: { totalCount: 3, nodes: [{ position: 1, pullRequest: { number: 150 } }, { position: 2, pullRequest: { number: 101 } }, { position: 3, pullRequest: { number: 160 } }] } } } } } }) };
      }
      const data = { repository: {} };
      for (const x of q.matchAll(/p(\d+): pullRequest/g)) data.repository[`p${x[1]}`] = app.get(Number(x[1])) ?? w["acme/other"].get(Number(x[1])) ?? null;
      return { stdout: JSON.stringify({ data }) };
    },
  });
  // only 101 is known (pr-link / created); 150 and 160 come through the stack
  const out = await t.go();
  const stacked = out.prs.filter((p) => p.stack?.id === "acme/app#900");
  assert.deepEqual(stacked.map((p) => [p.number, p.parent, p.stack.position]), [[150, null, 1], [101, 150, 2], [160, 101, 3]]);
  assert.equal(entryQueries, 1);
  assert.deepEqual(byOf(out, 160), ["other"]);
  // the member list is cached: the next refresh needs no entries query
  await t.go();
  assert.equal(entryQueries, 1);
});

test("a GitHub without stacked PRs: asked again without the stack fields, and not asked with them for a while", async () => {
  const queries = [];
  const w = world();
  const t = setup({
    gh: (c, a) => {
      const q = queryOf(a);
      queries.push(q);
      if (/stack/.test(q)) return { code: 1, stdout: JSON.stringify({ errors: [{ message: "Field 'stack' doesn't exist on type 'PullRequest'" }] }) };
      const data = { repository: {} };
      for (const x of q.matchAll(/p(\d+): pullRequest/g)) data.repository[`p${x[1]}`] = w["acme/app"].get(Number(x[1])) ?? w["acme/other"].get(Number(x[1])) ?? null;
      return { stdout: JSON.stringify({ data }) };
    },
  });
  const out = await t.go();
  assert.ok(out.prs.length >= 5);
  assert.equal(queries.filter((q) => /stack/.test(q)).length, 2, "one try per repo with the fields, then without");
  assert.ok(fs.existsSync(path.join(t.home, "data/prs/cache/gh.json")));
  queries.length = 0;
  await t.go();
  assert.ok(queries.length > 0 && queries.every((q) => !/stack/.test(q)), "the next refresh does not try again");
  assert.ok(out.prs.every((p) => p.stack === null || p.stack.native === false));
});

test("the output stays small: 100 PRs under 200 KB", async () => {
  const w = world();
  const many = new Map();
  for (let n = 1; n <= 100; n++) many.set(n, { ...w["acme/app"].get(101), number: n, headRefName: `branch-${n}`, baseRefName: n % 10 === 1 ? "main" : `branch-${n - 1}`, title: `[Area | Thing]: A realistic pull request title number ${n} (PF-${n})` });
  const { dir } = claudeCopy();
  const lines = [...many.keys()].map((n) => JSON.stringify({ cwd: "/work/app", toolUseResult: { gitOperation: { pr: { number: n, url: `https://github.com/acme/app/pull/${n}`, action: "created" } } } }));
  const tp = path.join(dir, "projects/-work-app", `${SESSION}.jsonl`);
  fs.appendFileSync(tp, `${lines.join("\n")}\n`);
  const run = fakeRun([
    ["hc get", { code: 3, stdout: "{}" }],
    [(c) => c === "git", { code: 1 }],
    [(c) => c === "gh", (c, a) => {
      const q = queryOf(a);
      const data = { repository: {} };
      for (const x of q.matchAll(/p(\d+): pullRequest/g)) data.repository[`p${x[1]}`] = many.get(Number(x[1])) ?? null;
      return { stdout: JSON.stringify({ data }) };
    }],
  ]);
  const home = tmp();
  const out = await refresh({ terminal: "t2", home, claudeDir: dir, run, exists, sessionArgs: [SESSION], cwdArg: "/work/app" });
  assert.equal(out.prs.filter((p) => many.has(p.number)).length, 100);
  assert.ok(fs.statSync(dataFile(home, "t2")).size < 200 * 1024);
});

test("merged PRs are kept from the last file, also when discovering, and asked for again after an hour", async () => {
  const t = setup();
  let clock = Date.parse("2026-11-09T10:00:00Z");
  await t.go({ discover: true, now: () => clock });
  t.calls.gh.length = 0;
  clock += 10 * 60 * 1000;
  await t.go({ discover: true, now: () => clock });
  assert.ok(t.calls.gh.some((q) => /search\(/.test(q)), "it did search");
  assert.ok(!askedNumbers(t.calls.gh).includes(104));
  t.calls.gh.length = 0;
  clock += 2 * 60 * 60 * 1000;
  const out = await t.go({ now: () => clock });
  assert.ok(askedNumbers(t.calls.gh).includes(104), "after an hour the merged PR is asked for again");
  assert.equal(out.prs.find((p) => p.number === 104).state, "merged");
  t.calls.gh.length = 0;
  clock += 60 * 1000;
  await t.go({ now: () => clock });
  assert.ok(!askedNumbers(t.calls.gh).includes(104));
});

test("a transcript whose gh pr create cannot be read is an error entry (once the file is at rest), and the PRs are still found", async () => {
  const t = setup();
  const out = await t.go({ discover: true, now: () => Date.now() + 60 * 60 * 1000 });
  const fmt = out.errors.filter((e) => e.kind === "transcript-format");
  assert.equal(fmt.length, 1);
  assert.match(fmt[0].file, /agent-ggg777\.jsonl$/);
  assert.ok(out.prs.some((p) => p.number === 101), "everything else still works");
});

test("an unexpected failure inside a run keeps the last good file, stale, with an internal error", async () => {
  const t = setup();
  const good = await t.go({ discover: true });
  const boom = await t.go({ exists: () => { throw new Error("boom"); } });
  assert.equal(boom.stale, true);
  assert.equal(boom.errors.length, 1);
  assert.equal(boom.errors[0].kind, "internal");
  assert.match(boom.errors[0].message, /boom/);
  assert.deepEqual(boom.prs.map((p) => p.number), good.prs.map((p) => p.number));
  const onDisk = JSON.parse(fs.readFileSync(dataFile(t.home, "t1"), "utf8"));
  assert.equal(onDisk.errors[0].kind, "internal");
});
