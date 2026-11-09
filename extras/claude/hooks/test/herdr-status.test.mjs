import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("../herdr-status.mjs", import.meta.url).pathname;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "herdr-status-"));

function run(home, input, terminal = "t1") {
  const env = { ...process.env, HERDR_APP_HOME: home };
  delete env.HC_TERMINAL_ID;
  delete env.HERDR_STATUS_CHILD;
  if (terminal) env.HC_TERMINAL_ID = terminal;
  const r = spawnSync(process.execPath, [script, "hook", "SessionStart"], { input: JSON.stringify(input), env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}
const sess = (home, t = "t1") => path.join(home, "data/agent-sessions", `${t}.jsonl`);
const lines = (f) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const ev = (source, sessionId = "s1") => ({ session_id: sessionId, transcript_path: "/x/t.jsonl", cwd: "/work", source });

test("startup writes one line with all fields", () => {
  const home = tmp();
  run(home, ev("startup"));
  const l = lines(sess(home));
  assert.equal(l.length, 1);
  assert.deepEqual(Object.keys(l[0]).sort(), ["at", "cwd", "sessionId", "source", "transcriptPath"]);
  assert.equal(l[0].sessionId, "s1");
  assert.equal(l[0].transcriptPath, "/x/t.jsonl");
  assert.equal(l[0].cwd, "/work");
  assert.equal(l[0].source, "startup");
  assert.ok(!Number.isNaN(Date.parse(l[0].at)));
});

test("compact writes nothing", () => {
  const home = tmp();
  run(home, ev("compact"));
  assert.ok(!fs.existsSync(sess(home)));
});

test("no HC_TERMINAL_ID writes nothing", () => {
  const home = tmp();
  run(home, ev("startup"), null);
  assert.ok(!fs.existsSync(path.join(home, "data/agent-sessions")));
});

test("same sessionId+source twice is one line; resume adds a second", () => {
  const home = tmp();
  run(home, ev("startup"));
  run(home, ev("startup"));
  assert.equal(lines(sess(home)).length, 1);
  run(home, ev("resume"));
  const l = lines(sess(home));
  assert.equal(l.length, 2);
  assert.equal(l[1].source, "resume");
});

test("files older than 30 days are pruned, fresh ones stay", () => {
  const home = tmp();
  const dir = path.join(home, "data/agent-sessions");
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, "old.jsonl");
  const fresh = path.join(dir, "fresh.jsonl");
  fs.writeFileSync(old, "{}\n");
  fs.writeFileSync(fresh, "{}\n");
  const t = new Date(Date.now() - 31 * 24 * 3600 * 1000);
  fs.utimesSync(old, t, t);
  run(home, ev("startup"));
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(fresh));
});

test("agent-status is removed on startup but not on compact", () => {
  const home = tmp();
  const st = path.join(home, "data/agent-status/t1.json");
  fs.mkdirSync(path.dirname(st), { recursive: true });
  fs.writeFileSync(st, "{}");
  run(home, ev("compact"));
  assert.ok(fs.existsSync(st));
  run(home, ev("startup"));
  assert.ok(!fs.existsSync(st));
});
