import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { descendants, findLive, findSessions, findTranscript, parsePs, readHookSessions } from "../lib/sessions.mjs";
import { SESSION, claudeCopy, fakeRun, tmp } from "./helpers.mjs";

const PS = `
    1     0
  100     1
  200   100
  300   200
  301   200
  400   300
  999     1
`;

const hcAnswer = (t) => JSON.stringify(t);
const termJson = { address: "t9", pid: 100, cwd: "/work/app", foreground: { pid: 200, cwd: "/work/app/wt", name: "bash" } };

function sessionFile(claude, pid, extra = {}) {
  fs.mkdirSync(path.join(claude, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(claude, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: SESSION, cwd: "/work/app/wt", kind: "interactive", ...extra }));
}

test("parsePs and descendants walk down from the roots, shallowest first", () => {
  const kids = parsePs(PS);
  assert.deepEqual(kids.get(200), [300, 301]);
  const d = descendants(kids, [200, 100]);
  assert.deepEqual(d.map((x) => `${x.pid}:${x.depth}`), ["200:0", "100:0", "300:1", "301:1", "400:2"]);
});

test("findTranscript globs the project folders instead of guessing the slug", () => {
  const { dir, transcript } = claudeCopy();
  assert.equal(findTranscript(dir, SESSION), transcript);
  assert.equal(findTranscript(dir, "22222222-nope-nope"), null);
  assert.equal(findTranscript(dir, "../../etc/passwd"), null);
});

test("findLive: the claude process is a child of the foreground /bin/sh wrapper", async () => {
  const { dir } = claudeCopy();
  sessionFile(dir, 400);
  const run = fakeRun([["hc get t9", { stdout: hcAnswer(termJson) }], ["ps ", { stdout: PS }]]);
  const r = await findLive({ terminal: "t9", claudeDir: dir, run });
  assert.deepEqual(r.live, { pid: 400, sessionId: SESSION, cwd: "/work/app/wt" });
  assert.equal(r.fgCwd, "/work/app/wt");
  assert.deepEqual(r.errors, []);
});

test("findLive: the shallowest session file wins; interactive before others", async () => {
  const { dir } = claudeCopy();
  sessionFile(dir, 400, { sessionId: "deep-session-0000" });
  sessionFile(dir, 300, { sessionId: "shallow-session-1", kind: "sdk" });
  sessionFile(dir, 301, { sessionId: "interactive-sess-2" });
  const run = fakeRun([["hc get t9", { stdout: hcAnswer(termJson) }], ["ps ", { stdout: PS }]]);
  const r = await findLive({ terminal: "t9", claudeDir: dir, run });
  assert.equal(r.live.sessionId, "interactive-sess-2");
});

test("findLive: an unknown terminal is an error entry, not a crash", async () => {
  const { dir } = claudeCopy();
  const run = fakeRun([["hc get", { code: 3, stdout: JSON.stringify({ error: { kind: "not_found", message: 'no terminal "t9"' } }) }]]);
  const r = await findLive({ terminal: "t9", claudeDir: dir, run });
  assert.equal(r.live, null);
  assert.equal(r.errors[0].kind, "hc");
  assert.match(r.errors[0].message, /no terminal "t9"/);
});

test("findLive: hc missing is an error entry", async () => {
  const { dir } = claudeCopy();
  const run = fakeRun([["hc ", { code: null, error: "ENOENT: hc not found" }]]);
  const r = await findLive({ terminal: "t9", claudeDir: dir, run });
  assert.match(r.errors[0].message, /hc failed: ENOENT/);
});

test("readHookSessions de-duplicates by sessionId and skips bad lines; a missing file is fine", () => {
  const home = tmp();
  assert.deepEqual(readHookSessions(home, "t9"), []);
  const f = path.join(home, "data/agent-sessions/t9.jsonl");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, [
    JSON.stringify({ sessionId: "a-session-0001", transcriptPath: "/x/a.jsonl", cwd: "/w1", source: "startup", at: 1 }),
    "garbage",
    JSON.stringify({ sessionId: "b-session-0002", transcriptPath: "/x/b.jsonl", cwd: "/w2", source: "startup", at: 2 }),
    JSON.stringify({ sessionId: "a-session-0001", transcriptPath: "/x/a.jsonl", cwd: "/w3", source: "resume", at: 3 }),
    "",
  ].join("\n"));
  const got = readHookSessions(home, "t9");
  assert.deepEqual(got.map((s) => s.sessionId), ["b-session-0002", "a-session-0001"]);
  assert.equal(got[1].source, "resume");
});

test("findSessions: hook + live + --session, one entry per id; live outranks hook and arg", async () => {
  const { dir, transcript } = claudeCopy();
  const home = tmp();
  // the hook knows the live session and an older one that has no transcript on disk
  fs.mkdirSync(path.join(home, "data/agent-sessions"), { recursive: true });
  fs.writeFileSync(path.join(home, "data/agent-sessions/t9.jsonl"), [
    JSON.stringify({ sessionId: SESSION, transcriptPath: transcript, cwd: "/work/app", source: "startup", at: 1 }),
    JSON.stringify({ sessionId: "old-session-0000", transcriptPath: "/gone/old.jsonl", cwd: "/work/app", source: "startup", at: 2 }),
  ].join("\n"));
  sessionFile(dir, 400);
  const run = fakeRun([["hc get t9", { stdout: hcAnswer(termJson) }], ["ps ", { stdout: PS }]]);
  const r = await findSessions({ terminal: "t9", home, claudeDir: dir, run, args: [SESSION, "bad id!"] });
  assert.deepEqual(r.sessions.map((s) => [s.sessionId, s.from]), [[SESSION, "live"]]);
  assert.equal(r.hookCwd, "/work/app");
  assert.ok(r.errors.some((e) => e.kind === "session" && /old-session-0000/.test(e.message)), "an unfindable hook session is reported");
  assert.ok(r.errors.some((e) => /bad session id/.test(e.message)));
});

test("findSessions: --session alone (a fake terminal) works without any live session", async () => {
  const { dir } = claudeCopy();
  const run = fakeRun([["hc get", { code: 3, stdout: JSON.stringify({ error: { message: "no terminal" } }) }]]);
  const r = await findSessions({ terminal: "t77", home: tmp(), claudeDir: dir, run, args: [SESSION] });
  assert.deepEqual(r.sessions.map((s) => [s.sessionId, s.from]), [[SESSION, "arg"]]);
  assert.equal(r.live, null);
  assert.equal(r.errors.length, 1);
});
