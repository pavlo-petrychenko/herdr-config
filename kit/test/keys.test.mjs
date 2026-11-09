import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyKeys, planKeys, removeKeys, wantedKeys } from "../keys.mjs";
import { PIECES } from "../pieces.mjs";

const kitKeys = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "keys.json"), "utf8"));

test("every key in kit/keys.json belongs to a piece, and every piece key is in the file", () => {
  const fromPieces = PIECES.flatMap((p) => p.herdr?.keys ?? []).map(([s, k]) => `${s} ${k}`).sort();
  const inFile = Object.entries(kitKeys).flatMap(([s, keys]) => Object.keys(keys).map((k) => `${s} ${k}`)).sort();
  assert.deepEqual(fromPieces, inFile);
});

test("planKeys sorts keys into add, same and clashes", () => {
  const current = { global: { "cmd-shift-n": "space.new", "cmd-shift-r": "viewbar.flip" } };
  const wanted = wantedKeys(kitKeys, [["global", "cmd-shift-n"], ["global", "cmd-shift-r"], ["global", "cmd-shift-g"], ["mod:plan-review", "cmd-w"]]);
  const p = planKeys(current, wanted);
  assert.deepEqual(p.add.map((k) => k.key), ["cmd-shift-g", "cmd-w"]);
  assert.deepEqual(p.same.map((k) => k.key), ["cmd-shift-r"]);
  assert.deepEqual(p.clashes, [{ section: "global", key: "cmd-shift-n", action: "mod.open:repo-worktree", theirs: "space.new" }]);
});

test("applyKeys adds keys and sections without changing the input; removeKeys takes them out again", () => {
  const current = { global: { "cmd-t": "tab.new", "cmd-shift-n": "space.new" } };
  const copy = structuredClone(current);
  const { next, added } = applyKeys(current, [
    { section: "global", key: "cmd-shift-g", action: "viewbar.prs" },
    { section: "mod:plan-review", key: "cmd-w", action: "plan-review.back" },
    { section: "global", key: "cmd-shift-n", action: "mod.open:repo-worktree", theirs: "space.new" },
  ]);
  assert.deepEqual(current, copy);
  assert.equal(next.global["cmd-shift-g"], "viewbar.prs");
  assert.equal(next.global["cmd-shift-n"], "mod.open:repo-worktree");
  assert.equal(next["mod:plan-review"]["cmd-w"], "plan-review.back");
  assert.equal(added.find((a) => a.section === "mod:plan-review").newSection, true);
  assert.equal(added.find((a) => a.key === "cmd-shift-n").replaced, "space.new");

  const { next: back, kept } = removeKeys(next, added);
  assert.deepEqual(back, current);
  assert.deepEqual(kept, []);
});

test("removeKeys keeps a key the person changed after the install, and its section", () => {
  const { next, added } = applyKeys({}, [{ section: "mod:plan-review", key: "cmd-w", action: "plan-review.back" }]);
  next["mod:plan-review"]["cmd-w"] = "something.else";
  const { next: back, kept } = removeKeys(next, added);
  assert.equal(back["mod:plan-review"]["cmd-w"], "something.else");
  assert.equal(kept.length, 1);
});
