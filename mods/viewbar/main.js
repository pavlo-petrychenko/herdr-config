// The view bar: a thin fixed-height bar under the tabs. One mod, three roles (props().role):
//   bar          Left: Agent | Plan, the flip of the layout stack "main-stack" (the tab area and the
//                plan-review mod; the same as cmd-shift-r, `viewbar.flip` in keys.json). Right: one
//                button per panel the agent has (providers.js; none ship yet): each opens the second
//                view beside the main one, and clicking it again closes it.
//                A button shows only when its thing exists: Agent when the focused tab has an agent,
//                Plan when that agent has a plan. A shown view that loses its thing falls back
//                (Plan -> Agent; the second view closes).
//   side         the second view (layout column "side"): the open provider's body.
//   keys-button  the status bar's hotkeys button; opens the map (a dialog, role "keys").
// Files / Changes (column "panel") and the second view share the right edge: the one opened last stays.
// Plans: the agent-plan-review pointer files, <app home>/data/plan-review/<terminal>.json (pointers.js).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, panes, focused, layout, shared, setShared, run, theme, props, appHome, exec, readTextFile, watchFolder, openOverlay, keys, window, nextCommand } from "herdr";
import { STACK, AGENT_VIEW, PLAN_VIEW, SIDE, PANEL, currentAgent, shownView, isOpen, hasFlip, available, fallbacks, rightEdge } from "./logic.js";
import { keyGroups } from "./keymap.js";
import { POINTER_DIR, STATES, parsePointer, terminalOfFile, touchesPointers, planFor } from "./pointers.js";
import { PROVIDERS } from "./providers.js";

const ICON = (name) => `mods/viewbar/icons/${name}.svg`;
const VIEW_KEY = "plan-review.view"; // the stack side we last flipped to (the plan-review mod reads it too)
const SIDE_KEY = "viewbar.side"; // the second view's kind, or null

// Kept across reloads and shared by this mod's copies.
const PLANS = (globalThis.__viewbarPlans ??= { map: new Map(), raw: new Map(), loaded: false }); // terminal -> pointer
const LAST = (globalThis.__viewbarLast ??= {}); // tab -> the agent last focused there
const mac = () => window()?.platform === "macos";
const kit = { div, svg, h_flex, v_flex };

// What the agent is doing: its own title, else a named tab, else the program.
function agentLabel(a) {
  const own = String(a?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const prog = a?.program?.name ?? "";
  return own && own !== prog && !/^[~/]/.test(own) ? own : a?.tab_name && !/^\d+$/.test(a.tab_name) ? a.tab_name : prog;
}

// Everything the bar and the second view decide from, read once per render.
function world() {
  const f = focused();
  const list = agents();
  if (f?.terminal && list.some((a) => a.address === f.terminal && a.tab === f.tab)) LAST[f.tab] = f.terminal;
  const agent = currentAgent(list, f, LAST);
  // The plan exactly as the plan view picks it (the focused terminal's, else the tab's).
  const plan = agent ? planFor(PLANS.map, f, panes()) : null;
  const tree = layout();
  const sideOpen = isOpen(tree, SIDE);
  const side = shared(SIDE_KEY) ?? null;
  const ctx = agent ? { agent, terminal: agent.address, tab: agent.tab, space: agent.space } : null;
  return { f, agent, ctx, plan, loaded: PLANS.loaded, flip: hasFlip(tree), tree, view: shownView(tree, shared(VIEW_KEY)),
    things: ctx ? available(PROVIDERS, ctx) : [], side, sideOpen, active: sideOpen ? side : null, panelOpen: isOpen(tree, PANEL) };
}

// Flip the stack, and move the keyboard with it, so plan keys never reach the hidden agent terminal
// (it could type into a running agent) and typing reaches the agent again after the flip back.
//   plan:  the plan-review mod takes the keyboard itself when it first shows (it retries until it
//          holds); `plan-review.focus` asks again, now and once more after the frame that shows it
//          (a command reaches shown copies only).
//   agent: pane.focus gives the keyboard back to the tab's pane.
function flipTo(view, cx = null) {
  run("layout.select", { stack: STACK, child: view });
  setShared(VIEW_KEY, view);
  if (view === PLAN_VIEW) {
    run("plan-review.focus");
    if (cx) cx.timer.after(150, () => run("plan-review.focus"));
    return;
  }
  const pane = focused()?.pane;
  if (pane) run("pane.focus", { pane });
}

function openSide(kind, w) {
  if (w.panelOpen) run("layout.hide", { id: PANEL });
  setShared(SIDE_KEY, kind);
  if (!w.sideOpen) run("layout.show", { id: SIDE });
}

function closeSide() {
  setShared(SIDE_KEY, null);
  run("layout.hide", { id: SIDE });
}

const openKeys = () => openOverlay({ mod: "viewbar", kind: "dialog", width: 790, height: 580, props: { role: "keys" } });

export default class ViewBar extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.role = p.overlay ? "keys" : p.role ?? "bar";
    this.prevEdge = null;
    this.lastFix = null;
    if (this.role === "bar") {
      this.readPlans(cx);
      for (const provider of PROVIDERS) provider.init?.(cx);
      // Keys can do what the buttons do (`viewbar.<command>` in keys.json; also `herdr-app do`):
      //   agent, plan, flip, keys (the map), close (cmd-w: in the plan view back to the agent, else
//   close the pane), and a provider's kind (toggle that panel).
      cx.spawn(async (cx) => {
        for (;;) {
          const c = String(await nextCommand()).replace(/^viewbar\./, "");
          const w = world();
          if (c === "keys") openKeys();
          else if (c === "close") w.flip && w.view === PLAN_VIEW ? flipTo(AGENT_VIEW, cx) : run("pane.close");
          else if (!w.flip) { /* this layout has no flip */ }
          else if ((c === "plan" || (c === "flip" && w.view !== PLAN_VIEW)) && w.plan) flipTo(PLAN_VIEW, cx);
          else if (c === "agent" || c === "flip") flipTo(AGENT_VIEW, cx);
          else if (w.things.some((x) => x.kind === c)) w.active === c ? closeSide() : openSide(c, w);
          cx.notify();
        }
      });
    }
  }

  // The plan pointers: the whole folder once, then each file as it changes.
  readPlans(cx) {
    const dir = `${appHome()}/${POINTER_DIR}`;
    const read = async (files) => {
      let list = files;
      if (!list) {
        const r = await exec("ls", ["-1", dir]).catch(() => null);
        const names = String(r?.stdout ?? "").split("\n").filter((n) => n.endsWith(".json"));
        list = names.map((n) => `${dir}/${n}`);
        for (const t of [...PLANS.map.keys()]) if (!names.includes(`${t}.json`)) { PLANS.map.delete(t); PLANS.raw.delete(t); }
      }
      for (const f of list) {
        const terminal = terminalOfFile(f);
        if (!terminal) continue;
        const raw = await readTextFile(f).catch(() => null);
        if (raw === (PLANS.raw.get(terminal) ?? null)) continue;
        const ptr = raw == null ? null : parsePointer(raw);
        PLANS.raw.set(terminal, raw);
        if (ptr) PLANS.map.set(terminal, ptr); else PLANS.map.delete(terminal);
      }
    };
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", dir]).catch(() => null);
      await read(null);
      PLANS.loaded = true;
      cx.notify();
      for (;;) {
        const changed = await watchFolder(dir).catch(() => null);
        if (!changed) { await new Promise((done) => cx.timer.after(5000, done)); await read(null); cx.notify(); continue; }
        const mine = changed.filter((c) => touchesPointers(c, dir));
        if (!mine.length) continue;
        await read(mine.includes(dir) || mine.includes(`${dir}/`) ? null : mine);
        cx.notify();
      }
    });
  }

  // Fallbacks and the right edge, once per change of what they depend on (the bar copy only).
  fix(w) {
    const fb = fallbacks({ view: w.view, agent: w.agent, plan: w.plan, side: w.active, kinds: w.things.map((x) => x.kind), loaded: w.loaded });
    if (!w.flip) delete fb.view;
    const edge = rightEdge(this.prevEdge, { panel: w.panelOpen, side: w.sideOpen });
    this.prevEdge = { panel: w.panelOpen && edge !== PANEL, side: w.sideOpen && edge !== SIDE };
    const stale = Boolean(w.side) && !w.sideOpen; // the column was hidden some other way
    if (!fb.view && !fb.close && !edge && !stale) { this.lastFix = null; return; }
    const key = JSON.stringify([fb, edge, stale, w.agent?.address ?? null, w.f?.tab ?? null]);
    if (key === this.lastFix) return;
    this.lastFix = key;
    if (fb.view) flipTo(fb.view);
    if (fb.close || edge === SIDE) closeSide();
    else if (stale) setShared(SIDE_KEY, null);
    if (edge === PANEL) run("layout.hide", { id: PANEL });
  }

  // ---- bar ----------------------------------------------------------------------------------------

  segment(t, id, icon, label, on, tip, click, extra = null) {
    return h_flex().id(`vb-${id}`).h(24).px(9).gap(6).items_center().rounded(6).text_size(12).cursor_pointer()
      .border_1().border_color(on ? t.border : "#00000000")
      .when(on, (el) => el.bg(t.background).text_color(t.foreground))
      .when(!on, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
      .tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); click(cx); })
      .child(svg(ICON(icon)).size(14).flex_none())
      .child(div().flex_none().child(label))
      .children(extra ? [extra] : []);
  }

  bar(t) {
    const w = world();
    this.fix(w);
    const flip = `${mac() ? "⌘⇧R" : "Ctrl+Shift+R"}`;
    const state = w.plan && STATES[w.plan.pointer.status];
    const left = !w.agent || !w.flip ? [] : [h_flex().h(28).p(2).gap(2).items_center().rounded(8).bg(t.raised)
      .child(this.segment(t, "agent", "bot", "Agent", w.view !== PLAN_VIEW, `The agent's terminal${w.plan ? ` (${flip})` : ""}`, (cx) => w.view === PLAN_VIEW && flipTo(AGENT_VIEW, cx)))
      .when(Boolean(w.plan), (el) => el.child(this.segment(t, "plan", "plan", "Plan", w.view === PLAN_VIEW, `Its plan · ${state?.label ?? ""} (${flip})`, (cx) => w.view !== PLAN_VIEW && flipTo(PLAN_VIEW, cx),
        div().size(6).flex_none().rounded(3).bg(t[state?.color] ?? t.dim))))];
    const right = w.things.map((thing) => {
      const on = w.active === thing.kind;
      return h_flex().id(`vb-${thing.kind}`).h(26).px(7).gap(5).items_center().rounded(7).cursor_pointer()
        .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .tooltip(on ? `${thing.tip} · click to close` : thing.tip)
        .on_click((_e, cx) => { cx.stop_propagation(); on ? closeSide() : openSide(thing.kind, world()); })
        .child(svg(thing.icon).size(15).flex_none().text_color(on ? t.foreground : t.muted))
        .when(Boolean(thing.badge.text), (el) => el.child(div().flex_none().text_size(10.5).font_semibold().text_color(t[thing.badge.tone] ?? t.dim).child(thing.badge.text)));
    });
    // Fixed height whatever shows, so nothing under it moves when buttons come and go.
    return h_flex().id("viewbar").size_full().px(8).gap(8).items_center()
      .children(left)
      .child(div().flex_1())
      .child(h_flex().gap(2).items_center().children(right));
  }

  // ---- the second view ----------------------------------------------------------------------------------

  side(t) {
    const w = world();
    const provider = PROVIDERS.find((p) => p.kind === w.active);
    if (!provider || !w.ctx) return div().size_full();
    let body = [];
    try { body = provider.body(w.ctx, t, kit) ?? []; } catch (e) { body = [div().text_size(12).text_color(t.blocked).child(`${provider.title}: ${e?.message ?? e}`)]; }
    return v_flex().size_full().min_h(0).bg(t.background).rounded(10).border_1().border_color(t.border).overflow_hidden()
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(provider.icon).size(15).flex_none().text_color(t.muted))
        .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child(provider.title))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(agentLabel(w.agent)))
        .child(h_flex().id("vb-close").size(24).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover)).tooltip("Close").on_click(() => closeSide())
          .child(svg(ICON("x")).size(14).text_color(t.muted))))
      .child(v_flex().id("vb-side-body").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(10).children(body));
  }

  // ---- hotkeys --------------------------------------------------------------------------------------

  keysButton(t) {
    return h_flex().size_full().pr(10).justify_end().items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .child(h_flex().id("vb-keys").h(22).px(6).items_center().rounded(6).cursor_pointer().text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Keyboard shortcuts")
        .on_click(() => openKeys())
        .child(svg(ICON("keyboard")).size(16)));
  }

  caps(t, combo) {
    return h_flex().gap(2).flex_none().children(combo.map((c) => h_flex().h(19).min_w(19).px(5).items_center().justify_center().rounded(4)
      .bg(t.raised).border_1().border_color(t.border).text_size(10.5).text_color(t.foreground).child(c)));
  }

  keysMap(t) {
    const where = shared("layout");
    const groups = keyGroups(keys(), { layout: where, mac: mac() });
    return v_flex().id("vb-keys-map").size_full().bg(t.popover).px(18).pt(16).pb(10).gap(12)
      .child(h_flex().gap(9).items_center()
        .child(svg(ICON("keyboard")).size(17).text_color(t.muted))
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Keyboard shortcuts"))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(where ? `keys.json · ${where}` : "keys.json"))
        .child(div().px(5).h(18).rounded(4).border_1().border_color(t.border).text_size(10.5).text_color(t.dim).child("Esc")))
      .child(div().h(1).flex_none().bg(t.border))
      .child(div().id("vb-keys-body").flex_1().min_h(0).overflow_y_scrollbar()
        .child(h_flex().flex_wrap().items_start().gap(18).pb(8).children(groups.map((g) => v_flex().w(236).gap(1)
          .child(div().pb(4).text_size(10.5).font_semibold().text_color(t.dim).child(g.title.toUpperCase()))
          .children(g.rows.map((r) => h_flex().min_h(24).gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(r.label))
            .child(h_flex().flex_none().gap(4).items_center().children(r.keys.flatMap((k, i) => [
              ...(i ? [div().text_size(10).text_color(t.dim).child("or")] : []), this.caps(t, k)])))))))));
  }

  render() {
    const t = theme();
    if (this.role === "side") return this.side(t);
    if (this.role === "keys-button") return this.keysButton(t);
    if (this.role === "keys") return this.keysMap(t);
    return this.bar(t);
  }
}
