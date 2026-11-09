import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { choosePieces } from "../pieces.mjs";
import { kit, world } from "./helpers.mjs";

const all = { window: { ok: true }, node20: { ok: true }, git: { ok: true }, python3: { ok: true }, gh: { ok: true }, "agent-plan-review": { ok: true } };

test("a missing program switches off only the pieces that need it, and those built on them", () => {
  const { on, off } = choosePieces({ ...all, python3: { ok: false, why: "Python 3 was not found" } });
  assert.deepEqual(on, ["prs", "repo-worktree", "file-viewer", "plan"]);
  assert.deepEqual(off, [
    { id: "core", why: "Python 3 was not found" },
    { id: "viewbar", why: "needs the Flat sidebar piece (core)" },
  ]);
});

test("an installed base piece counts for requires", () => {
  const { on } = choosePieces({ ...all, python3: { ok: false } }, ["viewbar"], ["core"]);
  assert.deepEqual(on, ["viewbar"]);
});

test("setup with python3, gh login and agent-plan-review missing installs the rest and says why", async () => {
  const w = world({ programs: ["git", "gh-logged-out"] });
  const r = await kit(w, ["--yes"]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Flat sidebar \(core\).*Off: Python 3 was not found/);
  assert.match(r.text, /View bar \(viewbar\).*Off: needs the Flat sidebar piece/);
  assert.match(r.text, /PRs view \(prs\).*Off: gh is not logged in/);
  assert.match(r.text, /Plan view \(plan\).*Off: agent-plan-review was not found/);
  const mods = fs.readdirSync(path.join(w.home, "mods")).sort();
  assert.deepEqual(mods, ["file-viewer", "repo-worktree", "spaces"]);
  assert.ok(!fs.existsSync(path.join(w.home, "layouts", "main-flat.json")));
});

test("no Herdr window: the flat sidebar is off, the rest goes in", async () => {
  const w = world({ window: false });
  const r = await kit(w, ["--yes"]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Flat sidebar \(core\).*Off: no Herdr window is open/);
  assert.ok(fs.existsSync(path.join(w.home, "mods", "prs", "main.js")));
  assert.ok(!fs.existsSync(path.join(w.home, "mods", "spaces-flat")));
});
