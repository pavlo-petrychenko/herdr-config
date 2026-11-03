import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpec, addTab, closeTab, parseState, stateFile, languageOf, EMPTY, MAX_TABS } from "../state.js";

test("spec: path, line, range, column, GitHub anchor, file URL, relative parts", () => {
  const cwd = "/repo/api";
  assert.deepEqual(parseSpec("src/a.ts", cwd), { path: "/repo/api/src/a.ts", from: null, to: null });
  assert.deepEqual(parseSpec("./src/a.ts:12", cwd), { path: "/repo/api/src/a.ts", from: 12, to: null });
  assert.deepEqual(parseSpec("src/a.ts:12-30", cwd), { path: "/repo/api/src/a.ts", from: 12, to: 30 });
  assert.deepEqual(parseSpec("src/a.ts:30-12", cwd), { path: "/repo/api/src/a.ts", from: 12, to: 30 });
  assert.deepEqual(parseSpec("src/a.ts:12:5", cwd), { path: "/repo/api/src/a.ts", from: 12, to: null });
  assert.deepEqual(parseSpec("src/a.ts#L3-L9", cwd), { path: "/repo/api/src/a.ts", from: 3, to: 9 });
  assert.deepEqual(parseSpec("../web/b.md", cwd), { path: "/repo/web/b.md", from: null, to: null });
  assert.deepEqual(parseSpec("file:///tmp/a%20b.txt:4", cwd), { path: "/tmp/a b.txt", from: 4, to: null });
});

test("tabs: a shown file goes to the front, again updates it, the oldest drop off", () => {
  let s = addTab({ ...EMPTY }, { path: "/a", from: 1 });
  s = addTab(s, { path: "/b", note: "why" });
  s = addTab(s, { path: "/a", from: 5, to: 9 });
  assert.deepEqual(s.tabs.map((t) => [t.path, t.from, t.to]), [["/b", null, null], ["/a", 5, 9]]);
  assert.equal(s.active, "/a");
  assert.equal(s.seq, 3);
  for (let i = 0; i < MAX_TABS + 3; i++) s = addTab(s, { path: `/f${i}` });
  assert.equal(s.tabs.length, MAX_TABS);
  assert.equal(s.tabs.at(-1).path, `/f${MAX_TABS + 2}`);
});

test("tabs: closing the active one selects its neighbour; the last leaves none", () => {
  let s = ["/a", "/b", "/c"].reduce((st, path) => addTab(st, { path }), { ...EMPTY });
  s = closeTab(s, "/c");
  assert.equal(s.active, "/b");
  s = closeTab(s, "/a");
  assert.equal(s.active, "/b");
  s = closeTab(s, "/b");
  assert.deepEqual([s.tabs.length, s.active], [0, null]);
  assert.equal(closeTab(s, "/zzz"), s);
});

test("state file: broken text is empty state; the name is safe", () => {
  assert.deepEqual(parseState("{oops"), { ...EMPTY });
  assert.deepEqual(parseState(null), { ...EMPTY });
  assert.equal(parseState('{"tabs":[{"path":"/a"},{"x":1}],"pane":"p1","seq":4}').tabs.length, 1);
  assert.equal(stateFile("/h", "m1/t3"), "/h/data/file-viewer/m1_t3.json");
});

test("language: by extension", () => {
  assert.equal(languageOf("/a/b.tsx"), "js");
  assert.equal(languageOf("/a/Makefile"), "txt");
  assert.equal(languageOf("/a/x.SQL"), "sql");
});
