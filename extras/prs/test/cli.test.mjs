import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { main, parseArgs } from "../lib/main.mjs";
import { here, tmp } from "./helpers.mjs";

const sink = () => { const chunks = []; return { write: (s) => chunks.push(s), text: () => chunks.join("") }; };
const call = async (argv, env = {}) => { const stdout = sink(), stderr = sink(); const code = await main(argv, { stdout, stderr, env: { ...process.env, ...env } }); return { code, out: stdout.text(), err: stderr.text() }; };

test("usage errors exit 2 and say what is wrong", async () => {
  for (const argv of [[], ["nope"], ["refresh"], ["refresh", "a", "b"], ["refresh", "t1", "--wat"], ["refresh", "t1", "--session"], ["refresh", "bad/id"], ["detail", "o/r", "5"], ["detail", "o/r", "x", "body"], ["detail", "orr", "5", "body"], ["detail", "o/r", "5", "nope"]]) {
    const r = await call(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.err, /usage:/);
  }
  assert.match((await call(["detail", "o/r", "5", "nope"])).err, /bad part: nope/);
  assert.equal((await call(["--help"])).code, 0);
});

test("parseArgs: repeatable --session, --flag=value, booleans", () => {
  const { pos, flags } = parseArgs(["t1", "--discover", "--session", "a", "--session=b", "--cwd", "/x", "--print"], { discover: "bool", print: "bool", session: "list", cwd: "value" });
  assert.deepEqual(pos, ["t1"]);
  assert.deepEqual(flags, { session: ["a", "b"], discover: true, cwd: "/x", print: true });
});

test("refresh runs as a program: writes the file, prints nothing, exits 0 even when parts failed", () => {
  const home = tmp();
  // A bare PATH that has node but no hc, gh or git: every part fails, the command still succeeds.
  const bin = tmp("prs-bin-");
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  const r = spawnSync(path.join(bin, "node"), [path.join(here, "..", "cli.mjs"), "refresh", "t3", "--cwd", home], { env: { PATH: bin, HERDR_APP_HOME: home, CLAUDE_CONFIG_DIR: tmp() }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  const file = JSON.parse(fs.readFileSync(path.join(home, "data/prs/t3.json"), "utf8"));
  assert.equal(file.terminal, "t3");
  assert.ok(file.errors.some((e) => e.kind === "hc" && /ENOENT/.test(e.message)));
  assert.deepEqual(file.prs, []);

  const p = spawnSync(path.join(bin, "node"), [path.join(here, "..", "cli.mjs"), "refresh", "t3", "--print"], { env: { PATH: bin, HERDR_APP_HOME: home, CLAUDE_CONFIG_DIR: tmp() }, encoding: "utf8" });
  assert.equal(JSON.parse(p.stdout).terminal, "t3");
  const bad = spawnSync(path.join(bin, "node"), [path.join(here, "..", "cli.mjs"), "bogus"], { env: { PATH: bin }, encoding: "utf8" });
  assert.equal(bad.status, 2);
  void execFileSync;
});

test("the shim (extras/bin/herdr-prs) finds node on Herdr's bare PATH and follows a symlink to the repo", () => {
  const home = tmp("prs-shim-home-");
  const fnm = path.join(home, ".local/share/fnm/aliases/default/bin");
  fs.mkdirSync(fnm, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(fnm, "node"));
  const shim = path.join(here, "../../bin/herdr-prs");
  const dir = tmp("prs-shim-bin-");
  const link = path.join(dir, "herdr-prs");
  fs.symlinkSync(shim, link);
  const link2 = path.join(dir, "again");
  fs.symlinkSync(link, link2); // a link to a link
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, HERDR_APP_HOME: home, CLAUDE_CONFIG_DIR: tmp() };

  const usage = spawnSync(link2, ["--help"], { env, encoding: "utf8" });
  assert.equal(usage.status, 0, usage.stderr);
  assert.match(usage.stdout, /herdr-prs refresh <terminal>/);

  const r = spawnSync(link, ["refresh", "t8", "--cwd", home], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(home, "data/prs/t8.json")));

  const none = spawnSync(link, ["--help"], { env: { PATH: "/usr/bin:/bin", HOME: tmp() }, encoding: "utf8" });
  assert.equal(none.status, 127);
  assert.match(none.stderr, /node not found/);
});
