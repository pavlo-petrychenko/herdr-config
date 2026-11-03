import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, matches, parseManual, groupOf, assign, move, addFolder, removeFolder, renameFolder, prune, OTHER } from "../groups.js";

const HOME = "/Users/p";
const config = parseConfig(JSON.stringify({ groups: [{ name: "Work", folders: ["~/Desktop/project/**"] }, { name: "Personal", folders: ["~/Documents/personal/**"] }, { name: "" }] }), HOME);
const sp = (id, folder) => ({ id, folder });

test("config: ~ expands, nameless groups drop, broken text is no groups", () => {
  assert.deepEqual(config.groups.map((g) => [g.name, g.folders]), [["Work", ["/Users/p/Desktop/project/**"]], ["Personal", ["/Users/p/Documents/personal/**"]]]);
  assert.deepEqual(parseConfig("{oops", HOME), { groups: [] });
});

test("patterns", () => {
  assert.ok(matches("/a/b/**", "/a/b"));
  assert.ok(matches("/a/b/**", "/a/b/c/d"));
  assert.ok(!matches("/a/b/**", "/a/bc"));
  assert.ok(matches("/a/b/*", "/a/b/c"));
  assert.ok(!matches("/a/b/*", "/a/b/c/d"));
  assert.ok(matches("/a/b", "/a/b/"));
  assert.ok(!matches("/a/b", null));
});

test("assign: rules, then your folders (even empty), then Other; a move wins over rules", () => {
  let manual = addFolder(parseManual(null), "Clients");
  manual = addFolder(manual, "Clients");
  manual = move(manual, "w2", "Personal");
  const spaces = [sp("w1", "/Users/p/Desktop/project/website"), sp("w2", "/Users/p/Desktop/project/website-x"), sp("p1", "/Users/p/Documents/personal/notes"), sp("o1", "/tmp")];
  assert.deepEqual(assign(spaces, config, manual).map((g) => [g.name, g.mine, g.ids]), [
    ["Work", false, ["w1"]],
    ["Personal", false, ["w2", "p1"]],
    ["Clients", true, []],
    [OTHER, false, ["o1"]],
  ]);
  assert.deepEqual(groupOf(spaces[1], config, manual), { name: "Personal", why: "moved" });
  // A move to a folder that no longer exists falls back to the rules.
  assert.deepEqual(groupOf(spaces[1], config, move(manual, "w2", "Gone")), { name: "Work", why: "rule" });
});

test("no groups at all: one unnamed group", () => {
  assert.deepEqual(assign([sp("a", "/x")], { groups: [] }, parseManual(null)), [{ name: null, mine: false, ids: ["a"] }]);
});

test("folders: rename carries the spaces, remove sends them back to the rules, prune forgets gone spaces", () => {
  let m = move(addFolder(parseManual(null), "A"), "s1", "A");
  m = renameFolder(m, "A", "B");
  assert.deepEqual(m, { folders: ["B"], of: { s1: "B" } });
  assert.equal(renameFolder(m, "B", OTHER), m);
  assert.deepEqual(removeFolder(m, "B"), { folders: [], of: {} });
  assert.deepEqual(prune(move(m, "gone", "B"), new Set(["s1"])).of, { s1: "B" });
  assert.deepEqual(move(m, "s1", null).of, {});
});
