import test from "node:test";
import assert from "node:assert/strict";
import { Deadline, makeRunner } from "../lib/run.mjs";

const node = process.execPath;

test("run: stdout, stderr and the exit code come back; it never rejects", async () => {
  const run = makeRunner();
  const ok = await run(node, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"]);
  assert.deepEqual([ok.code, ok.stdout, ok.stderr, ok.error], [3, "out", "err", undefined]);
  const missing = await run("definitely-not-a-program-xyz", []);
  assert.equal(missing.code, null);
  assert.match(missing.error, /ENOENT/);
});

test("run: a program that takes too long is killed", async () => {
  const run = makeRunner();
  const t = Date.now();
  const r = await run(node, ["-e", "setTimeout(() => {}, 10000)"], { timeout: 200 });
  assert.match(r.error, /timeout/);
  assert.ok(Date.now() - t < 3000);
});

test("run: too much output is cut off and reported", async () => {
  const run = makeRunner();
  const r = await run(node, ["-e", "process.stdout.write('x'.repeat(200000))"], { maxBuffer: 1000 });
  assert.equal(r.error, "output too large");
});

test("run: stdin input; and the deadline stops new programs from starting", async () => {
  const run = makeRunner();
  const r = await run(node, ["-e", "process.stdin.pipe(process.stdout)"], { input: "hello" });
  assert.equal(r.stdout, "hello");
  let t = 0;
  const late = makeRunner({ deadline: new Deadline(1000, () => t) });
  t = 900;
  const r2 = await late(node, ["-e", "1"]);
  assert.match(r2.error, /out of time/);
});

test("run: the environment of the program is the caller's, with gh made non-interactive", async () => {
  const run = makeRunner({ env: { PATH: process.env.PATH, FOO: "bar" } });
  const r = await run(node, ["-e", "process.stdout.write([process.env.FOO, process.env.GH_PROMPT_DISABLED, process.env.NO_COLOR].join(','))"]);
  assert.equal(r.stdout, "bar,1,1");
});
