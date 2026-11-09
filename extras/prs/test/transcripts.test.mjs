import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ScanCache } from "../lib/cache.mjs";
import { applyRecord, scanFile, scanSession, sessionFiles } from "../lib/transcripts.mjs";
import { claudeCopy, tmp } from "./helpers.mjs";

const freshCache = () => new ScanCache(path.join(tmp(), "scan.json"));

test("sessionFiles lists main, subagents, workflow agents; journal.jsonl is not an agent", async () => {
  const { transcript } = claudeCopy();
  const files = await sessionFiles(transcript);
  const kinds = files.map((f) => `${f.kind}:${path.basename(f.path)}`).sort();
  assert.deepEqual(kinds, [
    "main:11111111-aaaa-4bbb-8ccc-000000000001.jsonl",
    "sub:agent-aaa111.jsonl", "sub:agent-bbb222.jsonl", "sub:agent-ddd444.jsonl", "sub:agent-eee555.jsonl", "sub:agent-ggg777.jsonl", "sub:agent-hhh888.jsonl", "sub:agent-iii999.jsonl",
    "wf:agent-ccc333.jsonl", "wf:agent-fff666.jsonl",
  ]);
});

test("scanSession: created PRs, pr-link, pushes, worktrees and who made them", async () => {
  const { transcript } = claudeCopy();
  const r = await scanSession(transcript, freshCache());

  const created = r.created.map((c) => `${c.n} ${c.by.kind}${c.by.name ? ":" + c.by.name : ""}`).sort();
  assert.deepEqual(created, [
    "101 agent",
    "102 subagent:Fix the parser", // no meta.name: the description
    "103 subagent:docs-writer",    // meta.name wins
    "104 workflow:absolute-imports", // the name comes from workflows/wf_123-abc.json
    "105 subagent:Result text only", // no toolUseResult: read from the text `gh pr create` printed
    "106 workflow:absolute-imports", // the same in a workflow agent (these never have a toolUseResult)
    "201 subagent:Read old transcripts", // the scanner reports what the records say; the refresh weighs it
    "204 subagent:Writer",
    "205 subagent:Read old transcripts",
  ]);
  assert.equal(r.created.find((c) => c.n === 105).url, "https://github.com/acme/app/pull/105", "the last PR URL of the text");
  assert.equal(r.created.find((c) => c.n === 106).cwd, "/work/app/.claude/worktrees/wf_123-abc-2");
  // "edited" and "ready" are not creations.
  assert.equal(r.created.filter((c) => c.n === 101).length, 1);
  assert.equal(r.created.find((c) => c.n === 101).url, "https://github.com/acme/app/pull/101");
  assert.equal(r.created.find((c) => c.n === 102).cwd, "/work/app/.claude/worktrees/agent-aaa111");

  // Each claim keeps the times of the records that made it: 101 has its created record and 2 of its 3 pr-links
  // at distinct times, in file order.
  assert.deepEqual(r.created.find((c) => c.n === 101).ts, ["2026-11-01T10:00:00.000Z"]);
  assert.deepEqual(r.created.find((c) => c.n === 201).ts, ["2026-11-01T10:03:00.000Z"]);
  assert.deepEqual(r.links.find((l) => l.n === 101).ts, ["2026-11-01T10:00:01.000Z", "2026-11-01T10:05:01.000Z"]);
  assert.deepEqual(r.links.find((l) => l.n === 201).ts, ["2026-11-01T10:06:00.000Z"]);

  // pr-link: de-duplicated, main transcript only.
  assert.deepEqual(r.links.map((l) => `${l.repo}#${l.n}`).sort(), ["acme/app#101", "acme/app#102", "acme/app#110", "acme/app#201", "acme/app#204", "acme/app#205", "acme/app#207"]);

  const pushes = r.pushes.map((p) => `${p.branch} ${p.by.kind}`).sort();
  assert.deepEqual(pushes, ["docs/readme subagent", "feat/main-work agent", "fix/parser subagent", "wf/imports workflow"]);

  const wts = r.worktrees.map((w) => `${path.basename(w.path)} ${w.by.kind}:${w.by.name} ${w.branch0}`).sort();
  assert.deepEqual(wts, [
    "agent-aaa111 subagent:Fix the parser worktree-agent-aaa111",
    "wf_123-abc-1 workflow:absolute-imports null",
  ]);
});

test("a line that only mentions the markers inside text is not parsed; a broken line is counted", async () => {
  const { transcript } = claudeCopy();
  const r = await scanSession(transcript, freshCache());
  assert.equal(r.bad, 0, "the cut-off line has no marker, so it is skipped without a parse");
  // A cut-off line WITH a marker is a parse failure, and is counted.
  fs.appendFileSync(transcript, '{"toolUseResult":{"gitOperation":{"pr":{"number":9\n');
  const r2 = await scanSession(transcript, freshCache());
  assert.equal(r2.bad, 1);
  assert.ok(!r2.created.some((c) => c.n === 9));
});

test("the transcript-format error: gh pr create ran, but no result and no PR record can be read", async () => {
  const { transcript } = claudeCopy();
  const later = () => Date.now() + 60 * 60 * 1000;
  const r = await scanSession(transcript, freshCache(), { now: later });
  assert.equal(r.formatErrors.length, 1);
  assert.match(r.formatErrors[0].file, /agent-ggg777\.jsonl$/);
  assert.match(r.formatErrors[0].message, /format may have changed/);
  // A failed create (eee555, is_error), a create read from the text (ddd444, fff666) and files with PR records raise nothing.
  assert.ok(!r.formatErrors.some((e) => /eee555|ddd444|fff666|aaa111|main/.test(e.file)));
  // A file that was written a moment ago may just not have the result yet.
  const fresh = await scanSession(transcript, freshCache());
  assert.deepEqual(fresh.formatErrors, []);
});

test("incremental: an unchanged file is not read again; a grown file resumes at its old end", async () => {
  const { transcript } = claudeCopy();
  const cache = freshCache();
  const first = await scanFile(transcript, null);
  assert.equal(first.changed, true);
  const second = await scanFile(transcript, first.entry);
  assert.equal(second.changed, false);
  assert.equal(second.bytes, 0);

  const line = JSON.stringify({ type: "user", cwd: "/work/app", toolUseResult: { gitOperation: { pr: { number: 120, url: "https://github.com/acme/app/pull/120", action: "created" } } } });
  fs.appendFileSync(transcript, `${line}\n`);
  const third = await scanFile(transcript, first.entry);
  assert.equal(third.changed, true);
  assert.equal(third.bytes, Buffer.byteLength(line) + 1, "only the appended bytes were read");
  assert.deepEqual(third.entry.prs.map((p) => p.n).sort(), [101, 120]);
  assert.equal(third.entry.o, fs.statSync(transcript).size);
  void cache;
});

test("incremental: a half-written last line waits for its end", async () => {
  const { transcript } = claudeCopy();
  const first = await scanFile(transcript, null);
  const line = JSON.stringify({ type: "user", cwd: "/work/app", toolUseResult: { gitOperation: { pr: { number: 121, url: "https://github.com/acme/app/pull/121", action: "created" } } } });
  const cut = Math.floor(line.length / 2);
  fs.appendFileSync(transcript, line.slice(0, cut)); // no newline yet
  const half = await scanFile(transcript, first.entry);
  assert.deepEqual(half.entry.prs.map((p) => p.n), [101]);
  assert.equal(half.entry.o, first.entry.o, "the offset stays before the partial line");
  assert.equal(half.entry.bad ?? 0, 0, "a partial line is not a bad line");
  fs.appendFileSync(transcript, `${line.slice(cut)}\n`);
  const done = await scanFile(transcript, half.entry);
  assert.deepEqual(done.entry.prs.map((p) => p.n).sort(), [101, 121]);
});

test("incremental: a last line complete JSON without a newline is taken", async () => {
  const { transcript } = claudeCopy();
  const first = await scanFile(transcript, null);
  const line = JSON.stringify({ type: "user", cwd: "/work/app", toolUseResult: { gitOperation: { pr: { number: 122, url: "https://github.com/acme/app/pull/122", action: "created" } } } });
  fs.appendFileSync(transcript, line);
  const r = await scanFile(transcript, first.entry);
  assert.deepEqual(r.entry.prs.map((p) => p.n).sort(), [101, 122]);
  fs.appendFileSync(transcript, "\n");
  const r2 = await scanFile(transcript, r.entry);
  assert.deepEqual(r2.entry.prs.map((p) => p.n).sort(), [101, 122], "the newline alone does not duplicate it");
});

test("a rewritten file starts again", async () => {
  const { transcript } = claudeCopy();
  const first = await scanFile(transcript, null);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "user", cwd: "/x", toolUseResult: { gitOperation: { pr: { number: 7, url: "https://github.com/acme/app/pull/7", action: "created" } } } })}\n${"x".repeat(5000)}\n`);
  const r = await scanFile(transcript, first.entry);
  assert.deepEqual(r.entry.prs.map((p) => p.n), [7]);
});

test("scanSession goes through the cache: second run reads nothing; an append is picked up", async () => {
  const { transcript, sessionDir } = claudeCopy();
  const cache = freshCache();
  const a = await scanSession(transcript, cache);
  assert.ok(a.stats.scanned >= 6);
  assert.equal(cache.save(), true);
  const reloaded = new ScanCache(cache.file);
  const b = await scanSession(transcript, reloaded);
  assert.equal(b.stats.scanned, 0);
  assert.equal(b.created.length, a.created.length);
  const sub = path.join(sessionDir, "subagents/agent-bbb222.jsonl");
  fs.appendFileSync(sub, `${JSON.stringify({ cwd: "/work/other", toolUseResult: { gitOperation: { pr: { number: 130, url: "https://github.com/acme/other/pull/130", action: "created" } } } })}\n`);
  const c = await scanSession(transcript, reloaded);
  assert.equal(c.stats.scanned, 1);
  assert.deepEqual(c.created.filter((x) => x.n === 130).map((x) => x.by.name), ["docs-writer"]);
});

test("applyRecord ignores shapes it does not know", () => {
  const e = { prs: [], links: [], pushes: [], bad: 0, gh: { cmds: 0, ok: 0, err: 0, pending: [] } };
  applyRecord(null, e);
  applyRecord({ toolUseResult: "a string" }, e);
  applyRecord({ toolUseResult: [{ gitOperation: {} }] }, e);
  applyRecord({ toolUseResult: { gitOperation: { pr: { number: "12", action: "created" } } } }, e);
  applyRecord({ toolUseResult: { gitOperation: { pr: { number: 12, action: "closed" } } } }, e);
  applyRecord({ type: "pr-link", prNumber: 5 }, e);
  assert.deepEqual([e.prs, e.links, e.pushes], [[], [], []]);
});

test("a gh pr create result is read across a resume: the command in one run, its result in the next", async () => {
  const { transcript } = claudeCopy();
  const first = await scanFile(transcript, null);
  const use = JSON.stringify({ type: "assistant", cwd: "/work/app", message: { content: [{ type: "tool_use", id: "toolu_Z1", name: "Bash", input: { command: "gh pr create --fill" } }] } });
  fs.appendFileSync(transcript, `${use}\n`);
  const mid = await scanFile(transcript, first.entry);
  assert.deepEqual(mid.entry.gh.pending, ["toolu_Z1"]);
  const res = JSON.stringify({ type: "user", cwd: "/work/app", message: { content: [{ type: "tool_result", tool_use_id: "toolu_Z1", content: [{ type: "text", text: "https://github.com/acme/app/pull/140" }], is_error: false }] } });
  fs.appendFileSync(transcript, `${res}\n`);
  const done = await scanFile(transcript, mid.entry);
  assert.deepEqual(done.entry.prs.map((p) => p.n).sort(), [101, 140]);
  assert.deepEqual(done.entry.gh.pending, []);
});

test("a cache written by an older scanner is dropped", () => {
  const dir = tmp();
  const file = path.join(dir, "scan.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, scan: 1, files: { "/x": { s: 1, m: 1, o: 1, h: "" } }, repos: { "/r": "o/r" } }));
  const c = new ScanCache(file);
  assert.deepEqual(c.files, {});
  assert.deepEqual(c.repos, { "/r": "o/r" }, "the folder lookups stay");
});

test("gh pr create: only a command that runs it, and only the URL on the last line", async () => {
  const { runsGhCreate, createdUrl } = await import("../lib/transcripts.mjs");
  assert.equal(runsGhCreate("gh pr create --fill"), true);
  assert.equal(runsGhCreate("cd /w && gh pr create --title \"x\" --body 'y'"), true);
  assert.equal(runsGhCreate("grep -rlF 'gh pr create' ~/.claude/projects"), false);
  assert.equal(runsGhCreate("jq -r 'select(.cmd | test(\"gh pr create\"))' f.jsonl"), false);
  assert.equal(runsGhCreate("rg \"gh pr create\" . | head"), false);
  assert.equal(createdUrl("Creating pull request\nhttps://github.com/o/r/pull/12\n"), "https://github.com/o/r/pull/12");
  assert.equal(createdUrl("found https://github.com/o/r/pull/12 in a log\nmore output"), null);
  assert.equal(createdUrl("https://github.com/o/r/pull/12 and https://github.com/o/r/pull/13"), null);
});

test("record times: the first 8 distinct ones are kept, in file order; a record without a time adds none", () => {
  const e = { prs: [], links: [], pushes: [], bad: 0, gh: { cmds: 0, ok: 0, err: 0, pending: [] } };
  for (let i = 0; i < 20; i++) applyRecord({ type: "pr-link", prNumber: 5, prRepository: "o/r", timestamp: `2026-11-01T10:00:${String(i).padStart(2, "0")}.000Z` }, e);
  applyRecord({ type: "pr-link", prNumber: 5, prRepository: "o/r", timestamp: "2026-11-01T10:00:03.000Z" }, e);
  applyRecord({ type: "pr-link", prNumber: 6, prRepository: "o/r" }, e);
  assert.equal(e.links.length, 2);
  assert.deepEqual(e.links[0].ts, Array.from({ length: 8 }, (_, i) => `2026-11-01T10:00:0${i}.000Z`));
  assert.deepEqual(e.links[1].ts, []);
});
