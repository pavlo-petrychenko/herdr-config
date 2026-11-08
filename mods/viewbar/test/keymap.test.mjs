import { test } from "node:test";
import assert from "node:assert/strict";
import { keyCaps, describe, keyGroups } from "../keymap.js";

test("key caps: symbols on a Mac, words elsewhere; '-' as a key", () => {
  assert.deepEqual(keyCaps("cmd-shift-]"), ["⌘", "⇧", "]"]);
  assert.deepEqual(keyCaps("cmd--"), ["⌘", "-"]);
  assert.deepEqual(keyCaps("cmd-alt-shift-left"), ["⌘", "⌥", "⇧", "←"]);
  assert.deepEqual(keyCaps("ctrl-shift-tab", false), ["Ctrl", "Shift", "⇥"]);
  assert.deepEqual(keyCaps("shift-f2"), ["⇧", "F2"]);
  assert.deepEqual(keyCaps("cmd-,"), ["⌘", ","]);
  assert.deepEqual(keyCaps("cmd-shift-enter"), ["⌘", "⇧", "↩"]);
});

test("describe: readable names and groups", () => {
  assert.deepEqual(describe("tab.new"), { group: "Tabs", label: "New tab" });
  assert.equal(describe("pane.split:right").label, "Split right");
  assert.equal(describe("send:\u001bb", "terminal").label, "Word left");
  assert.equal(describe("terminal.copy", "terminal").group, "Terminal");
  assert.deepEqual(describe("viewbar.flip"), { group: "Agents & plans", label: "Agent ⇄ plan" });
  assert.equal(describe("mod.open:picker").label, "Go to anything");
  assert.equal(describe("plan-review.back", "mod:plan-review").group, "In the plan view");
  assert.equal(describe("x.y", "mod:my-thing").group, "In my thing");
  assert.equal(describe("app.zoom_in").group, "Window");
  assert.equal(describe("layout.toggle:sidebar").label, "Show/hide sidebar");
  assert.equal(describe("foo.bar-baz").group, "Mods");
});

test("key groups: merges keys of one action, folds 1–9 runs, keeps only sections that apply", () => {
  const keys = [
    { section: "global", keys: "ctrl-tab", action: "tab.next" },
    { section: "global", keys: "cmd-shift-]", action: "tab.next" },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ section: "global", keys: `cmd-${n}`, action: `tab.select:${n}` })),
    { section: "terminal", keys: "cmd-c", action: "terminal.copy" },
    { section: "layout:other", keys: "cmd-x", action: "tab.new" },
    { section: "layout:mine", keys: "cmd-y", action: "space.new" },
    { section: "global", keys: "cmd-shift-r", action: "viewbar.flip" },
  ];
  const g = keyGroups(keys, { layout: "mine" });
  assert.deepEqual(g.map((x) => x.title), ["Agents & plans", "Tabs", "Spaces", "Terminal"]);
  const tabs = g.find((x) => x.title === "Tabs").rows;
  assert.deepEqual(tabs.find((r) => r.label === "Next tab").keys, [["⌃", "⇥"], ["⌘", "⇧", "]"]]);
  assert.deepEqual(tabs.find((r) => r.label === "Tab 1–9").keys, [["⌘", "1–9"]]);
  assert.ok(!g.some((x) => x.rows.some((r) => r.keys.some((k) => k.includes("X")))), "another layout's keys are left out");
});

test("viewbar.close on a layout section is the same row as pane.close", () => {
  const g = keyGroups([
    { section: "global", keys: "cmd-w", action: "pane.close" },
    { section: "layout:mine", keys: "cmd-w", action: "viewbar.close" },
    { section: "mod:plan-review", keys: "cmd-w", action: "plan-review.back" },
  ], { layout: "mine" });
  const panes = g.find((x) => x.title === "Panes").rows;
  assert.deepEqual(panes, [{ label: "Close pane", keys: [["⌘", "W"]] }]);
  assert.deepEqual(g.find((x) => x.title === "In the plan view").rows, [{ label: "Back to the agent", keys: [["⌘", "W"]] }]);
});

test("key groups: a short or broken run stays as single rows", () => {
  const g = keyGroups([{ section: "global", keys: "ctrl-1", action: "space.select:1" }, { section: "global", keys: "ctrl-3", action: "space.select:3" }]);
  assert.deepEqual(g[0].rows.map((r) => r.label), ["Space 1", "Space 3"]);
});

test("key groups: pane arrows fold into one row; rows follow the action order", () => {
  const dirs = ["down", "up", "left", "right"];
  const keys = [
    ...dirs.map((d) => ({ section: "global", keys: `cmd-alt-${d}`, action: `pane.go:${d}` })),
    ...dirs.map((d) => ({ section: "global", keys: `cmd-alt-shift-${d}`, action: `pane.swap:${d}` })),
    { section: "global", keys: "cmd-shift-w", action: "pane.close" },
    { section: "global", keys: "cmd-d", action: "pane.split:right" },
    { section: "global", keys: "cmd-[", action: "agent.prev" },
    { section: "global", keys: "cmd-]", action: "agent.next" },
  ];
  const g = keyGroups(keys);
  const panes = g.find((x) => x.title === "Panes").rows;
  assert.deepEqual(panes.map((r) => r.label), ["Split right", "Focus pane", "Swap pane", "Close pane"]);
  assert.deepEqual(panes[1].keys, [["⌘", "⌥", "←→↑↓"]]);
  assert.deepEqual(g.find((x) => x.title === "Agents & plans").rows.map((r) => r.label), ["Next agent", "Previous agent"]);
});
