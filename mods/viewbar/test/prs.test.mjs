import { test } from "node:test";
import assert from "node:assert/strict";
import { parseData, prsBadge, decideRefresh, FOCUS_FLOOR_MS, STAY_MS, DISCOVER_MS } from "../prs-logic.js";
import { available } from "../logic.js";
import { describe } from "../keymap.js";

const file = (o) => JSON.stringify({ version: 1, at: "2026-11-09T10:00:00Z", count: 2, problems: 0, prs: [], ...o });

test("data file: count, problems and time; anything else is no data", () => {
  assert.deepEqual(parseData(file({ count: 3, problems: 1 })), { count: 3, problems: 1, at: "2026-11-09T10:00:00Z" });
  assert.equal(parseData(null), null, "missing file");
  assert.equal(parseData(""), null);
  assert.equal(parseData("{not json"), null);
  assert.equal(parseData("[]"), null);
  assert.equal(parseData(file({ version: 2 })), null, "another format version is ignored");
  assert.deepEqual(parseData(JSON.stringify({ version: 1 })), { count: 0, problems: 0, at: null }, "missing numbers are 0");
  assert.equal(parseData(file({ count: "x", problems: -1 })).count, 0);
  assert.equal(parseData(file({ problems: -1 })).problems, 0);
});

test("button: hidden without data or without PRs", () => {
  assert.equal(prsBadge(undefined), null);
  assert.equal(prsBadge(null), null);
  assert.equal(prsBadge({ count: 0, problems: 0 }), null);
  assert.equal(prsBadge({ count: 0, problems: 3 }), null, "problems without PRs cannot happen; no button");
});

test("button: no badge when nothing needs attention", () => {
  const b = prsBadge({ count: 2, problems: 0 });
  assert.deepEqual(b, { tip: "Pull requests · 2 open" });
  assert.equal("badge" in b, false);
});

test("button: a red badge with the number of PRs that need attention", () => {
  assert.deepEqual(prsBadge({ count: 3, problems: 2 }), { badge: { text: "2", tone: "ansi1" }, tip: "Pull requests · 3 open · 2 need attention" });
});

test("through the bar's available(): no badge is an empty badge, nothing drawn; no data is no button", () => {
  const prs = (data) => ({ kind: "prs", title: "Pull requests", icon: "x.svg", available: () => prsBadge(data) });
  const ctx = { agent: { address: "t1" }, terminal: "t1" };
  assert.deepEqual(available([prs({ count: 1, problems: 0 })], ctx).map((x) => x.badge), [{ text: "", tone: "dim" }]);
  assert.deepEqual(available([prs({ count: 1, problems: 4 })], ctx).map((x) => x.badge), [{ text: "4", tone: "ansi1" }]);
  assert.deepEqual(available([prs(undefined)], ctx), []);
});

test("refresh: nothing without a terminal", () => {
  assert.equal(decideRefresh({ terminal: null, now: 1e9, last: undefined, focusChanged: true }), null);
});

test("refresh: a terminal never refreshed runs at once, with discover", () => {
  assert.deepEqual(decideRefresh({ terminal: "t1", now: 1e9, last: undefined, focusChanged: true }), { discover: true });
});

test("refresh: a focus change waits for the 60 s floor", () => {
  const last = { start: 1e9, discover: 1e9 };
  assert.equal(decideRefresh({ terminal: "t1", now: 1e9 + FOCUS_FLOOR_MS - 1, last, focusChanged: true }), null);
  assert.deepEqual(decideRefresh({ terminal: "t1", now: 1e9 + FOCUS_FLOOR_MS, last, focusChanged: true }), { discover: false });
});

test("refresh: staying focused runs every 5 minutes, not before", () => {
  const last = { start: 1e9, discover: 1e9 };
  assert.equal(decideRefresh({ terminal: "t1", now: 1e9 + 2000, last, focusChanged: false }), null);
  assert.equal(decideRefresh({ terminal: "t1", now: 1e9 + FOCUS_FLOOR_MS, last, focusChanged: false }), null, "the floor is for focus changes only");
  assert.equal(decideRefresh({ terminal: "t1", now: 1e9 + STAY_MS - 1, last, focusChanged: false }), null);
  assert.deepEqual(decideRefresh({ terminal: "t1", now: 1e9 + STAY_MS, last, focusChanged: false }), { discover: false });
});

test("refresh: discover only when the last one is more than 5 minutes old, or never succeeded", () => {
  const start = 1e9;
  const at = (discover) => decideRefresh({ terminal: "t1", now: start + 10 * 60_000, last: { start, discover }, focusChanged: false });
  assert.deepEqual(at(start + 10 * 60_000 - DISCOVER_MS), { discover: false }, "exactly 5 minutes: not yet");
  assert.deepEqual(at(start + 10 * 60_000 - DISCOVER_MS - 1), { discover: true });
  assert.deepEqual(at(null), { discover: true }, "a failed discover is tried again");
});

test("keys: viewbar.prs is a named action", () => {
  assert.deepEqual(describe("viewbar.prs"), { group: "Agents & plans", label: "Pull requests" });
});
