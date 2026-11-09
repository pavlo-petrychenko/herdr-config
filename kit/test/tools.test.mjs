import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hashFile } from "../util.mjs";
import { kit, readJson, snapshot, world } from "./helpers.mjs";

const PROGRAMS = ["python3", "git", "gh", "claude", "jq"];
const manifestOf = (w) => readJson(path.join(w.state, "manifest.json"));
const onPath = (w) => { w.env.PATH = `${w.bin}:${w.links}`; };

// A terminal as Herdr gives it: the variables the tools read.
const inHerdr = (w, extra = {}) => ({
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: w.root, HERDR_APP_HOME: w.home, HC_TERMINAL_ID: "t9", ...extra,
});

test("tools are copied to <state>/<version>, `current` points to it, links point through `current`", async () => {
  const w = world({ programs: PROGRAMS });
  onPath(w);
  const r = await kit(w, ["--yes"]);
  assert.equal(r.code, 0, r.text);
  const t = manifestOf(w).tools;
  assert.equal(t.version, "0.1.0");
  assert.equal(fs.readlinkSync(path.join(w.state, "current")), "0.1.0");
  for (const name of ["herdr-prs", "herdr-show", "herdr-status"]) {
    const link = path.join(w.links, name);
    assert.equal(fs.readlinkSync(link), path.join(w.state, "current", "bin", name));
    assert.ok(fs.statSync(link).mode & 0o100, `${name} is executable`);
  }
  for (const rel of ["prs/cli.mjs", "prs/lib/main.mjs", "claude/hooks/herdr-status.mjs", "claude/statusline-herdr.sh", "package.json"]) {
    assert.ok(fs.existsSync(path.join(w.state, "0.1.0", rel)), rel);
    assert.equal(hashFile(path.join(w.state, "0.1.0", rel)), t.files[rel], rel);
  }
  assert.ok(!Object.keys(t.files).some((f) => f.includes("/test/") || f.startsWith("hrt/")), "no tests, no hrt");
  assert.ok(fs.statSync(path.join(w.state, "0.1.0", "claude/statusline-herdr.sh")).mode & 0o100);
  assert.doesNotMatch(r.text, /not on your PATH/);
});

test("the tools find each other from the state folder, through the link", async () => {
  const w = world({ programs: PROGRAMS });
  assert.equal((await kit(w, ["--yes"])).code, 0);
  // herdr-status: link -> current/bin/herdr-status -> ../claude/hooks/herdr-status.mjs
  const s = spawnSync(path.join(w.links, "herdr-status"), ["review", "look at it"], { env: inHerdr(w), encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr);
  assert.equal(readJson(path.join(w.home, "data/agent-status/t9.json")).text, "look at it");
  // herdr-prs: link -> current/bin/herdr-prs -> ../prs/cli.mjs
  const p = spawnSync(path.join(w.links, "herdr-prs"), ["bogus"], { env: inHerdr(w), encoding: "utf8" });
  assert.equal(p.status, 2);
  assert.match(p.stderr, /unknown command: bogus/);
  // herdr-show: needs only the file-viewer mod in the Herdr home
  const h = spawnSync(path.join(w.links, "herdr-show"), ["--help"], { env: inHerdr(w), encoding: "utf8" });
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /usage: herdr-show/);
});

test("mods/prs/config.json holds the absolute path of herdr-prs; a config the person wrote is kept", async () => {
  const w = world({ programs: PROGRAMS });
  assert.equal((await kit(w, ["--yes"])).code, 0);
  const file = path.join(w.home, "mods/prs/config.json");
  assert.deepEqual(readJson(file), { cli: path.join(w.state, "current", "bin", "herdr-prs") });
  assert.equal(manifestOf(w).herdr.files["mods/prs/config.json"], hashFile(file));
  const d = await kit(w, ["doctor"]);
  assert.equal(d.code, 0, d.text);

  fs.writeFileSync(file, '{ "cli": "/mine/herdr-prs" }\n');
  const u = await kit(w, ["update", "--yes"]);
  assert.match(u.text, /Kept mods\/prs\/config.json/);
  assert.equal(readJson(file).cli, "/mine/herdr-prs");
  const r = await kit(w, ["uninstall", "--yes"]);
  assert.match(r.text, /Kept mods\/prs\/config.json/);
  assert.ok(fs.existsSync(file));
});

test("without the PRs piece there is no config.json and no herdr-prs link", async () => {
  const w = world({ programs: ["python3", "git", "claude", "jq"] });
  assert.equal((await kit(w, ["--yes"])).code, 0);
  assert.ok(!fs.existsSync(path.join(w.home, "mods/prs")));
  assert.ok(!fs.existsSync(path.join(w.links, "herdr-prs")));
  assert.ok(!fs.existsSync(path.join(w.state, "0.1.0/prs")));
  assert.ok(fs.existsSync(path.join(w.links, "herdr-status")));
});

test("a bin folder that is not on PATH is named, in setup and in doctor (a warning, not a problem)", async () => {
  const w = world({ programs: PROGRAMS });
  const r = await kit(w, ["--yes"]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, new RegExp(`${w.links.replace(/[/.]/g, "\\$&")} is not on your PATH`));
  assert.match(r.text, /export PATH=/);
  const d = await kit(w, ["doctor"]);
  assert.equal(d.code, 0, d.text);
  assert.match(d.text, /warning: .* is not on your PATH/);
  onPath(w);
  assert.doesNotMatch((await kit(w, ["doctor"])).text, /warning/);
});

test("doctor names a missing or foreign link and a changed tool file", async () => {
  const w = world({ programs: PROGRAMS });
  onPath(w);
  assert.equal((await kit(w, ["--yes"])).code, 0);
  fs.rmSync(path.join(w.links, "herdr-show"));
  fs.rmSync(path.join(w.links, "herdr-status"));
  fs.symlinkSync("/elsewhere", path.join(w.links, "herdr-status"));
  fs.appendFileSync(path.join(w.state, "0.1.0/bin/herdr-prs"), "# x\n");
  const d = await kit(w, ["doctor"]);
  assert.equal(d.code, 1);
  assert.match(d.text, /missing link: .*herdr-show/);
  assert.match(d.text, /herdr-status is not the kit's link any more/);
  assert.match(d.text, /changed: .*bin\/herdr-prs/);
});

test("a program of the same name that the kit did not link stops the install before anything changes", async () => {
  const w = world({ programs: PROGRAMS });
  fs.mkdirSync(w.links);
  fs.writeFileSync(path.join(w.links, "herdr-status"), "#!/bin/sh\n");
  const before = { home: snapshot(w.home), links: snapshot(w.links) };
  const r = await kit(w, ["--yes"]);
  assert.equal(r.code, 1);
  assert.match(r.text, /herdr-status is already there and the kit did not put it there/);
  assert.deepEqual({ home: snapshot(w.home), links: snapshot(w.links) }, before);
  assert.ok(!fs.existsSync(w.state) && !fs.existsSync(w.claude));
});

test("update makes a new version folder, flips `current`, and keeps only this and the previous version", async () => {
  const w = world({ programs: PROGRAMS });
  assert.equal((await kit(w, ["--yes"], { version: "0.1.0" })).code, 0);
  const cfg = path.join(w.home, "mods/prs/config.json");
  assert.equal((await kit(w, ["update", "--yes"], { version: "0.2.0" })).code, 0);
  assert.equal(fs.readlinkSync(path.join(w.state, "current")), "0.2.0");
  assert.deepEqual(fs.readdirSync(w.state).filter((f) => /^\d/.test(f)).sort(), ["0.1.0", "0.2.0"]);
  assert.equal(manifestOf(w).tools.previous, "0.1.0");
  // The link names `current`, so it needs no change; the prs config names `current` too.
  assert.equal(fs.readlinkSync(path.join(w.links, "herdr-status")), path.join(w.state, "current/bin/herdr-status"));
  assert.equal(readJson(cfg).cli, path.join(w.state, "current/bin/herdr-prs"));
  assert.equal((await kit(w, ["update", "--yes"], { version: "0.3.0" })).code, 0);
  assert.deepEqual(fs.readdirSync(w.state).filter((f) => /^\d/.test(f)).sort(), ["0.2.0", "0.3.0"]);
  assert.equal(manifestOf(w).tools.previous, "0.2.0");
  const d = await kit(w, ["doctor"]);
  assert.equal(d.code, 0, d.text);
  // A second update of the same version changes nothing.
  assert.equal((await kit(w, ["update", "--yes"], { version: "0.3.0" })).code, 0);
  assert.equal(manifestOf(w).tools.previous, "0.2.0");
});

test("uninstall removes the links, the version folders, `current`, and the state and bin folders the kit made", async () => {
  const w = world({ programs: PROGRAMS });
  assert.equal((await kit(w, ["--yes"], { version: "0.1.0" })).code, 0);
  assert.equal((await kit(w, ["update", "--yes"], { version: "0.2.0" })).code, 0);
  const foreign = path.join(w.links, "herdr-show");
  fs.rmSync(foreign);
  fs.symlinkSync("/elsewhere", foreign);
  const r = await kit(w, ["uninstall", "--yes"]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Kept .*herdr-show: it is not the kit's link any more/);
  assert.deepEqual(fs.readdirSync(w.links), ["herdr-show"]);
  assert.ok(!fs.existsSync(w.state), "the state folder is gone when nothing else is in it");
});
