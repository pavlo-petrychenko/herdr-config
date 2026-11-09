import { test } from "node:test";
import assert from "node:assert/strict";
import { currentAgent, shownView, isOpen, hasFlip, available, fallbacks, rightEdge } from "../logic.js";

const A = (address, tab) => ({ address, tab });
const agents = [A("t1", "tabA"), A("t2", "tabA"), A("t3", "tabB")];

test("current agent: the focused one, else the last focused in the tab, else the tab's first", () => {
  assert.equal(currentAgent(agents, { tab: "tabA", terminal: "t2" })?.address, "t2");
  assert.equal(currentAgent(agents, { tab: "tabA", terminal: null }, { tabA: "t2" })?.address, "t2");
  assert.equal(currentAgent(agents, { tab: "tabA", terminal: "zsh9" })?.address, "t1");
  assert.equal(currentAgent(agents, { tab: "tabA", terminal: "t3" })?.address, "t1", "an agent of another tab is not this tab's");
  assert.equal(currentAgent(agents, { tab: "tabC", terminal: null }), null, "a tab without an agent has none");
  assert.equal(currentAgent(agents, null), null);
});

test("layout: the stack's shown side, the flip, and open columns", () => {
  const tree = { id: "root", children: [{ id: "main-stack", active: "plan", children: [{ id: "main" }, { id: "plan" }] }, { id: "side", hidden: true }, { id: "panel" }] };
  assert.equal(shownView(tree, null), "plan");
  assert.equal(shownView({ id: "root" }, "plan"), "plan");
  assert.equal(shownView(tree, "main"), "main", "what we flipped to wins over the file");
  assert.equal(shownView({ id: "root" }, undefined), "main");
  assert.equal(hasFlip(tree), true);
  assert.equal(hasFlip({ id: "root", children: [{ id: "main" }] }), false, "a layout without the stack has no flip");
  const trimmed = { id: "root", children: [{ id: "main-stack", active: "main", children: [{ id: "main" }] }] };
  assert.equal(hasFlip(trimmed), false, "a stack without the plan block (no plan view installed) has no flip: nothing to flip to");
  assert.equal(shownView(trimmed, null), "main");
  assert.equal(isOpen(tree, "side"), false);
  assert.equal(isOpen(tree, "panel"), true);
  assert.equal(isOpen(tree, "nope"), false);
});

const prs = { kind: "prs", title: "Pull requests", icon: "i.svg", available: (c) => (c.terminal === "t1" ? { badge: { text: "2", tone: "ansi2" }, tip: "2 open" } : null) };
const todos = { kind: "todos", title: "TODOs", icon: "j.svg", available: () => ({}) };
const broken = { kind: "x", title: "X", icon: "k.svg", available: () => { throw new Error("boom"); } };

test("available: no providers, no agent, or nothing to show means no buttons", () => {
  const ctx = { agent: A("t1", "tabA"), terminal: "t1", tab: "tabA" };
  assert.deepEqual(available([], ctx), []);
  assert.deepEqual(available(undefined, ctx), []);
  assert.deepEqual(available([prs], null), []);
  assert.deepEqual(available([prs], { agent: A("t2", "tabA"), terminal: "t2" }), []);
});

test("available: only providers with something, in order, with defaults; a throwing one is skipped", () => {
  const got = available([prs, broken, todos], { agent: A("t1", "tabA"), terminal: "t1" });
  assert.deepEqual(got.map((x) => x.kind), ["prs", "todos"]);
  assert.deepEqual(got[0], { kind: "prs", title: "Pull requests", icon: "i.svg", badge: { text: "2", tone: "ansi2" }, tip: "2 open" });
  assert.deepEqual(got[1].badge, { text: "", tone: "dim" });
  assert.equal(got[1].tip, "TODOs");
});

test("fallbacks: plan without a plan goes back; a second view without its thing closes", () => {
  const agent = A("t1", "tabA");
  assert.deepEqual(fallbacks({ view: "plan", agent, plan: null, side: null, kinds: [] }), { view: "main" });
  assert.deepEqual(fallbacks({ view: "plan", agent: null, plan: null, side: "prs", kinds: [] }), { view: "main", close: true });
  assert.deepEqual(fallbacks({ view: "plan", agent, plan: { terminal: "t1" }, side: "prs", kinds: ["prs"] }), {});
  assert.deepEqual(fallbacks({ view: "main", agent, plan: null, side: "todos", kinds: ["prs"] }), { close: true });
});

test("fallbacks: the plan view is kept until the plan pointers were read", () => {
  const agent = A("t1", "tabA");
  assert.deepEqual(fallbacks({ view: "plan", agent, plan: null, side: null, kinds: [], loaded: false }), {});
  assert.deepEqual(fallbacks({ view: "plan", agent, plan: null, side: null, kinds: [], loaded: true }), { view: "main" });
});

test("right edge: the one opened last stays", () => {
  assert.equal(rightEdge({ panel: false, side: true }, { panel: true, side: true }), "side");
  assert.equal(rightEdge({ panel: true, side: false }, { panel: true, side: true }), "panel");
  assert.equal(rightEdge(undefined, { panel: true, side: true }), "side");
  assert.equal(rightEdge({ panel: true, side: false }, { panel: true, side: false }), null);
});
