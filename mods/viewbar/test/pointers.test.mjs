import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parsePointer, terminalOfFile, touchesPointers, planFor, planOfAgent, STATES } from "../pointers.js";

const good = { reviewId: "r1", projectKey: "p1", version: 2, status: "approved", title: "Auth", cwd: "/x", updatedAt: "2026-11-09T10:00:00Z", server: "http://127.0.0.1:4620/" };

test("parsePointer: the real file shape, cleaned", () => {
  assert.deepEqual(parsePointer(JSON.stringify(good)), { reviewId: "r1", projectKey: "p1", version: 2, status: "approved", title: "Auth", updatedAt: "2026-11-09T10:00:00Z" });
});

test("parsePointer: bad input is null; unknown status is pending; missing title is Plan", () => {
  for (const bad of ["", "nope", "[]", "null", "{}", JSON.stringify({ ...good, reviewId: "" }), JSON.stringify({ ...good, projectKey: 3 }), JSON.stringify({ ...good, version: 0 }), JSON.stringify({ ...good, version: "x" })])
    assert.equal(parsePointer(bad), null, bad);
  const p = parsePointer(JSON.stringify({ ...good, status: "weird", title: undefined }));
  assert.equal(p.status, "pending");
  assert.equal(p.title, "Plan");
});

test("every status has a label and a theme colour", () => {
  for (const s of ["pending", "approved", "rejected"]) assert.ok(STATES[s].label && STATES[s].color && STATES[s].short);
});

test("terminalOfFile and touchesPointers", () => {
  assert.equal(terminalOfFile("/h/data/plan-review/t3.json"), "t3");
  assert.equal(terminalOfFile("/h/data/plan-review/t3.json.tmp"), null);
  assert.equal(terminalOfFile("/h/data/plan-review/.hidden.json"), null);
  const dir = "/h/data/plan-review";
  assert.equal(touchesPointers(dir, dir), true);
  assert.equal(touchesPointers(`${dir}/t1.json`, dir), true);
  assert.equal(touchesPointers(`${dir}/images/a.json`, dir), false);
  assert.equal(touchesPointers(`${dir}/t1.json.tmp`, dir), false);
  assert.equal(touchesPointers("/h/data/other/t1.json", dir), false);
});

const ptr = (status = "pending") => ({ ...good, status });

test("planFor: the focused terminal's pointer, else another terminal in the tab, in pane order", () => {
  const m = new Map([["t1", ptr("pending")], ["z9", ptr("approved")], ["z8", ptr("rejected")]]);
  const panes = [{ tab: "a", terminal: "z8" }, { tab: "a", terminal: "z9" }, { tab: "b", terminal: "t1" }];
  assert.equal(planFor(m, { tab: "b", terminal: "t1" }, panes).terminal, "t1");
  assert.equal(planFor(m, { tab: "a", terminal: "t5" }, panes).terminal, "z8");
  assert.equal(planFor(m, { tab: "c", terminal: "t5" }, panes), null);
  assert.equal(planFor(m, null, panes), null);
  assert.equal(planFor(new Map(), { tab: "a", terminal: "t1" }, panes), null);
});

test("planOfAgent: the agent's own pointer, else its tab's; none without an agent", () => {
  const m = new Map([["t1", ptr("approved")], ["z9", ptr("rejected")]]);
  const panes = [{ tab: "a", terminal: "z9" }];
  assert.equal(planOfAgent(m, { address: "t1", tab: "b" }, panes).pointer.status, "approved");
  assert.equal(planOfAgent(m, { address: "t2", tab: "a" }, panes).pointer.status, "rejected");
  assert.equal(planOfAgent(m, { address: "t2", tab: "x" }, panes), null);
  assert.equal(planOfAgent(m, null, panes), null);
});

test("agent-queue carries an identical copy of pointers.js", () => {
  const mine = fs.readFileSync(new URL("../pointers.js", import.meta.url), "utf8");
  const theirs = fs.readFileSync(new URL("../../agent-queue/pointers.js", import.meta.url), "utf8");
  assert.equal(theirs, mine);
});
