// The view bar's decisions, pure (no Herdr imports): node tests load it.
//   which agent the bar is about, which panels exist for it (from the providers), what to fall
//   back to when a shown view loses its thing, and Files/Changes vs the second view.
// The hotkeys map is in keymap.js, the plan pointers in pointers.js, the panels in providers.js.

export const STACK = "main-stack"; // the layout stack: the tab area and the plan
export const AGENT_VIEW = "main";
export const PLAN_VIEW = "plan";
export const SIDE = "side"; // the layout column of the second view
export const PANEL = "panel"; // the layout column of Files / Changes

/**
 * The agent the bar is about: the focused terminal when it is an agent in the focused tab, else
 * the one last focused in that tab (`last`: tab -> terminal), else the tab's first agent.
 * `agents` in Herdr's order (space, tab, pane). Returns an agent or null.
 */
export function currentAgent(agents, focused, last = {}) {
  if (!focused?.tab) return null;
  const mine = (agents ?? []).filter((a) => a.tab === focused.tab);
  return mine.find((a) => a.address === focused.terminal)
    ?? mine.find((a) => a.address === last[focused.tab])
    ?? mine[0] ?? null;
}

/** The side shown in the stack: what we last flipped to (the layout file keeps saying "main"),
 *  else the layout's, else the agent. */
export function shownView(layoutTree, remembered) {
  if (remembered === PLAN_VIEW || remembered === AGENT_VIEW) return remembered;
  return stackActive(layoutTree, STACK) === PLAN_VIEW ? PLAN_VIEW : AGENT_VIEW;
}

export function findNode(tree, id) {
  if (!tree || typeof tree !== "object") return null;
  if (tree.id === id) return tree;
  for (const c of tree.children ?? []) {
    const r = findNode(c, id);
    if (r) return r;
  }
  return null;
}

export function stackActive(tree, id = STACK) {
  const n = findNode(tree, id);
  return n && typeof n.active === "string" ? n.active : null;
}

/** Shown: in the layout and not hidden. */
export const isOpen = (tree, id) => { const n = findNode(tree, id); return Boolean(n) && !n.hidden; };

/** Whether this layout has the flip at all (the stack, with the plan side). */
export const hasFlip = (tree) => findNode(tree, STACK) !== null;

// ---- panels ----------------------------------------------------------------------------------------
//
// A provider is one kind of panel for the second view (providers.js):
//   { kind, title, icon, init?(cx), available(ctx), body(ctx, t, kit) }
//   kind        a short id: the layout never needs it; `viewbar.<kind>` in keys.json toggles it
//   title       the panel's heading; icon  an svg path under mods/viewbar/
//   init(cx)    optional, once per bar copy: start reading the provider's data (cx.notify() to redraw)
//   available   (ctx) -> { badge: { text, tone }, tip } when the agent HAS this thing, else null
//   body        (ctx, t, kit) -> an array of elements, the panel's content; kit = { div, svg, h_flex, v_flex }
// ctx = { agent, terminal, tab, space }: the agent the bar is about.

/**
 * The panels the agent has: each provider that says it is available, in provider order, as
 * { kind, title, icon, badge, tip }. A provider that throws counts as not available.
 */
export function available(providers, ctx) {
  const out = [];
  if (!ctx?.agent) return out;
  for (const p of providers ?? []) {
    let a = null;
    try { a = p.available(ctx); } catch { a = null; }
    if (!a) continue;
    out.push({ kind: p.kind, title: p.title, icon: p.icon, badge: a.badge ?? { text: "", tone: "dim" }, tip: a.tip ?? p.title });
  }
  return out;
}

// ---- what to do when something is gone ---------------------------------------------------------------

/**
 * Fallbacks: the plan is shown but there is no plan (or no agent) -> back to the agent; a second
 * view is open but the agent has no such thing -> close it. Nothing is decided before the plan
 * pointers were read once (`loaded`), or a restart would always flip back. Returns
 * { view?: "main", close?: true }.
 */
export function fallbacks({ view, agent, plan, side, kinds, loaded = true }) {
  const out = {};
  if (loaded && view === PLAN_VIEW && (!agent || !plan)) out.view = AGENT_VIEW;
  if (side && (!agent || !kinds.includes(side))) out.close = true;
  return out;
}

/**
 * Files/Changes and the second view share the right edge: when both are open, the one opened last
 * stays. `prev` / `now`: { panel, side } open at the last look and now. Returns the id to hide.
 */
export function rightEdge(prev, now) {
  if (!now.panel || !now.side) return null;
  if (prev?.panel && !prev?.side) return PANEL; // the second view just opened
  return SIDE; // Files/Changes just opened, or we can't tell: keep Files/Changes
}
