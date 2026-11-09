import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { LOCK_STALE_MS, liveLock, lockFile, withLock } from "../lib/lock.mjs";
import { main } from "../lib/main.mjs";
import { dataFile } from "../lib/refresh.mjs";
import { here, tmp } from "./helpers.mjs";

/** A clock the test moves: sleep(ms) advances it. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; }, get t() { return t; } };
}
const lockPath = () => path.join(tmp("prs-lock-"), "data/prs/t1.lock");
const write = (file, o) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(o)); };

test("lockFile sits next to the data file", () => {
  assert.equal(lockFile("/h/data/prs/t35.json"), "/h/data/prs/t35.lock");
});

test("no lock: runs, holds the lock while it runs, lets go after", async () => {
  const file = lockPath();
  const c = clock();
  let during = null;
  const r = await withLock(file, async () => { during = JSON.parse(fs.readFileSync(file, "utf8")); return 7; }, { pid: 4242, ...c });
  assert.deepEqual(r, { ran: true, value: 7 });
  assert.deepEqual(during, { pid: 4242, at: c.t });
  assert.equal(fs.existsSync(file), false);
});

test("lets go even when the run throws", async () => {
  const file = lockPath();
  await assert.rejects(withLock(file, async () => { throw new Error("boom"); }, { pid: 1, ...clock() }), /boom/);
  assert.equal(fs.existsSync(file), false);
});

test("a live young lock: waits, and when it goes the run is skipped", async () => {
  const file = lockPath();
  const c = clock();
  write(file, { pid: 99, at: c.now() - 5000 });
  let sleeps = 0;
  const sleep = async (ms) => { c.advance(ms); if (++sleeps === 3) fs.unlinkSync(file); };
  let ran = false;
  const r = await withLock(file, async () => { ran = true; }, { pid: 1, now: c.now, sleep, alive: () => true });
  assert.deepEqual(r, { ran: false });
  assert.equal(ran, false);
  assert.equal(sleeps, 3);
});

test("a live lock that stays: gives up after 15 s, still without refreshing", async () => {
  const file = lockPath();
  const c = clock();
  write(file, { pid: 99, at: c.now() });
  let ran = false;
  const r = await withLock(file, async () => { ran = true; }, { pid: 1, ...c, alive: () => true });
  assert.deepEqual(r, { ran: false });
  assert.equal(ran, false);
  assert.ok(c.t - 1_000_000 >= 15000 && c.t - 1_000_000 < 16000, `waited ${c.t - 1_000_000} ms`);
  assert.ok(fs.existsSync(file), "the other run's lock is not touched");
});

test("a lock of a dead process is taken over", async () => {
  const file = lockPath();
  const c = clock();
  write(file, { pid: 99, at: c.now() - 1000 });
  const r = await withLock(file, async () => "mine", { pid: 1, ...c, alive: () => false });
  assert.deepEqual(r, { ran: true, value: "mine" });
});

test("a lock of 60 s or more is taken over, a junk file too", async () => {
  const file = lockPath();
  const c = clock();
  write(file, { pid: 99, at: c.now() - LOCK_STALE_MS });
  assert.equal(liveLock(file, { ...c, alive: () => true }), null);
  assert.deepEqual(await withLock(file, async () => 1, { pid: 1, ...c, alive: () => true }), { ran: true, value: 1 });
  fs.writeFileSync(file, "not json");
  assert.deepEqual(await withLock(file, async () => 2, { pid: 1, ...c, alive: () => true }), { ran: true, value: 2 });
});

test("a holder that dies while we wait: we take over and refresh", async () => {
  const file = lockPath();
  const c = clock();
  write(file, { pid: 99, at: c.now() });
  let dead = false;
  const sleep = async (ms) => { c.advance(ms); dead = true; };
  const r = await withLock(file, async () => "took over", { pid: 1, now: c.now, sleep, alive: () => !dead });
  assert.deepEqual(r, { ran: true, value: "took over" });
});

test("the command: a held lock makes `refresh` exit 0 without writing; no lock writes the file", async () => {
  const home = tmp("prs-lock-home-");
  const env = { ...process.env, HERDR_APP_HOME: home, CLAUDE_CONFIG_DIR: tmp(), PATH: "/nonexistent" };
  const out = { write() {} };
  const file = dataFile(home, "t9");
  // A live holder: this very test process, so the pid is alive. The wait is short because the lock goes after 300 ms.
  write(lockFile(file), { pid: process.pid, at: Date.now() });
  setTimeout(() => fs.unlinkSync(lockFile(file)), 300);
  const code = await main(["refresh", "t9", "--cwd", home], { stdout: out, stderr: out, env });
  assert.equal(code, 0);
  assert.equal(fs.existsSync(file), false, "the run was skipped");
  const code2 = await main(["refresh", "t9", "--cwd", home], { stdout: out, stderr: out, env });
  assert.equal(code2, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).terminal, "t9");
  assert.equal(fs.existsSync(lockFile(file)), false, "the lock is gone after a run");
});

test("two commands at once: one refreshes, the other waits and leaves the file", async () => {
  const home = tmp("prs-lock-two-");
  const env = { ...process.env, HERDR_APP_HOME: home, CLAUDE_CONFIG_DIR: tmp(), PATH: "/nonexistent" };
  const run = () => new Promise((ok) => {
    const p = spawn(process.execPath, [path.join(here, "..", "cli.mjs"), "refresh", "t5", "--cwd", home], { env });
    let err = ""; p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => ok({ code, err }));
  });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  assert.equal(JSON.parse(fs.readFileSync(dataFile(home, "t5"), "utf8")).terminal, "t5");
  assert.equal(fs.existsSync(lockFile(dataFile(home, "t5"))), false);
});
