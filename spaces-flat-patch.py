#!/usr/bin/env python3
"""Turns a fresh copy of Herdr's `spaces` mod into `spaces-flat`, and `main` into `main-flat`.

Run by spaces-flat-sync.sh after it re-copies them. Every change is an exact text swap: when
Herdr changed the text, it stops and names the swap, so nothing is patched half way.

  1. No nesting: every space is its own row, worktrees too.
  2. Agents inside spaces: under each space, one line per agent in it (status, what it is
     doing, since when). Click: go to that agent.
  3. No "repo · branch" text after a space's name, and no git checks at all.
  5. Groups: spaces under group headers (Work, Personal, your own folders; space-groups mod,
     rules in space-groups.json). Right-click a space: its group menu (space-groups).
  4. The layout: the sidebar shows spaces-flat with the agent queue (agent-queue) under it, the
     separate Agents list is gone, and the bottom bar is agent-usage (the shipped bar plus usage).
  6. The look ("airy", styles.js, written from STYLES below): nothing is cut. A space's name
     wraps at - _ / . (2 lines; "…" only when absurdly long), with one line under it ("1 needs
     you · 2 agents · 1 working"); its agents hang off a thin line under the badge, their titles
     wrapping too. No fill until hover or selected. The plain row (row()) keeps only its presses
     (attach(), shared by both) and loses the empty spacer that halved the name's width.
  7. The view bar (mods/viewbar, mods/plan-review): a bar under the tabs, the tab area and the plan in
     one stack (main-stack), a second view column beside Files/Changes, the hotkeys button in the
     status bar. See viewbar() below. Needs the viewbar mod (in this repo) and the plan-review mod
     (agent-plan-review: `agent-plan-review herdr install`).
"""
import json
import sys

home, = sys.argv[1:] or [__import__("os").path.expanduser("~/.config/herdr-app")]
mod = f"{home}/mods/spaces-flat/main.js"
s = open(mod).read()


# Herdr's presses on a space row (select, drag to reorder, right-click menu), exactly as in its
# spaces mod: moved to attach() (see 6).
PRESSES = r'''      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
'''

# The look (see 6): written to mods/spaces-flat/styles.js.
STYLES = r'''// spaces-flat: how a space and its agents look (written by spaces-flat-patch.py; edit it there).
// Nothing is cut: a name or an agent's title wraps (about 2 lines; "…" only when absurdly long).
// No fill until hover or selected. Under the name, one line: "1 needs you · 2 agents · 1 working".
// The agents hang off a thin line under the badge: status, what it is doing, since when.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";

// A hex colour with an alpha ("#d9649a" + 0.3 -> "#d9649a4d"); theme names pass through.
const alpha = (c, a) => (/^#[0-9a-f]{6}$/i.test(c) ? c + Math.round(a * 255).toString(16).padStart(2, "0") : c);

// The most of a text that fits in about `lines` lines of `width` px at `size` px (a rough
// average glyph width); longer gets "…" at a word end. Boxes allow one line more than that, as
// a hard stop for a bad guess, so normal names and titles are never cut.
function clamp(s, { width, size, lines }) {
  const per = Math.max(8, Math.floor(width / (size * 0.52)));
  const max = Math.floor(per * lines);
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const at = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("-"));
  return (at > max * 0.6 ? cut.slice(0, at + (cut[at] === "-" ? 1 : 0)) : cut).trimEnd() + "…";
}

// A text block that wraps (at most `lines` + 1 lines). `split`: a name without spaces
// ("shop-feature-implementation") wraps after - _ / . instead of inside a word:
// each piece is its own box in a wrapping row.
function wrap(text, { width, size, lines, lh, color, bold, split }) {
  const s = clamp(text, { width, size, lines: lines + 0.6 });
  return div().flex_1().min_w(0).text_size(size).line_height(`${lh}px`).max_h(lh * (lines + 1)).overflow_hidden().text_color(color)
    .when(Boolean(bold), (el) => el.font_semibold())
    .when(!split, (el) => el.child(s))
    .when(Boolean(split), (el) => el.child(h_flex().flex_wrap().children(s.split(/(?<=[-_/.])/).map((part) => div().flex_none().child(part)))));
}

function mark(t, status) {
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900);
  return div().size(7).flex_none().rounded(7)
    .when(status === "idle", (el) => el.border_1().border_color(t.dim))
    .when(status !== "idle", (el) => el.bg(t[status] ?? t.dim));
}

function badge(w, fill) {
  return h_flex().size(22).flex_none().rounded(6).bg(fill).items_center().justify_center()
    .text_size(11.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?");
}

// "needs you" / "4d" / "done": what the right side of an agent says.
function when(t, a) {
  if (a.status === "blocked") return div().flex_none().text_size(11).font_semibold().text_color(t.blocked).child("needs you");
  if (a.status === "done") return div().flex_none().text_size(11).text_color(t.done).child("done");
  return div().flex_none().text_size(11).text_color(t.dim).child(a.age);
}

// "2 agents · 1 working" (the line under a space's name).
function summary(list) {
  const n = (s) => list.filter((a) => a.status === s).length;
  const parts = [`${list.length} agent${list.length === 1 ? "" : "s"}`];
  if (n("working")) parts.push(`${n("working")} working`);
  if (n("done")) parts.push(`${n("done")} done`);
  return parts.join(" · ");
}

// One space and its agents. ctx: { w, t, fill, list: [{ address, status, focused, label, age }],
// width (the list's inner width), attach(el) (selecting, dragging, the menu), go(agent) }.
export function spaceBlock({ w, t, fill, list, attach, width, go }) {
  const on = w.active;
  const needs = list.filter((a) => a.status === "blocked").length;
  const tabs = w.tabs?.length ?? 0;
  const meta = list.length ? summary(list) : `${tabs} tab${tabs === 1 ? "" : "s"} · no agents`;
  const nameW = width - 16 - 22 - 10;
  const titleW = width - 16 - 32 - 11 - 8 - 36;
  return attach(v_flex().flex_none().mb(2).py(6).px(8).gap(4).rounded(10)
    .when(on, (el) => el.bg(t.selected))
    .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
    .child(h_flex().gap(10).items_start()
      .child(badge(w, fill))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().child(wrap(w.name, { width: nameW, size: 13, lines: 2, lh: 17, color: t.foreground, bold: on, split: true })))
        .child(h_flex().gap(5).text_size(11).text_color(t.dim)
          .when(needs > 0, (el) => el.child(div().flex_none().text_color(t.blocked).font_semibold().child(`${needs} needs you`)).child(div().child("·")))
          .child(div().min_w(0).truncate().child(meta)))))
    .when(list.length > 0, (el) => el.child(v_flex().ml(10).pl(12).gap(1).border_l(1).border_color(alpha(t.foreground, 0.12)).children(list.map((a) =>
      // A click goes to the agent and never starts a space drag.
      h_flex().id(`agent-${a.address}`).cursor_pointer().gap(8).items_start().py(3).px(6).ml(-6).rounded(6)
        .when(a.focused, (r) => r.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); go(a); })
        .child(h_flex().w(11).h(16).flex_none().justify_center().items_center().child(mark(t, a.status)))
        .child(wrap(a.label, { width: titleW, size: 12, lines: 2, lh: 16, color: a.status === "idle" ? t.muted : t.foreground }))
        .child(div().pt(1).child(when(t, a))))))));
}
'''


def swap(old, new, what):
    global s
    if s.count(old) != 1:
        sys.exit(f"spaces-flat: Herdr changed the code for '{what}'; patch {mod} by hand.")
    s = s.replace(old, new)


swap('import { spaces, machines, panes, run,', 'import { agents, terminals, spaces, machines, panes, run,', "imports")
swap("    const nested = (r) => r.g?.linked && mains.has(r.g.repo);\n",
     "    // spaces-flat: every space is its own row, worktrees too.\n    const nested = () => false;\n", "nesting")
swap("const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));",
     "const draw = (r) => (collapsed ? this.compact(r, t) : this.block(r, t));", "space rows")
swap("rows.map(draw)", "rows.flatMap(draw)", "rows")
# No git at all: the sidebar used it only for nesting and the repo · branch text, both gone.
# Herdr re-runs `git status` per space on every change under .git; on a big repo that is
# seconds per run, nonstop, and it slows every mod (they share one runtime).
swap("""    this.unsure.delete(key);
    try {""", """    this.unsure.delete(key);
    // spaces-flat: no git (see spaces-flat-patch.py).
    this.git[key] = null;
    return;
    try {""", "git checks")
# No "repo · branch" text after a space's name (to be replaced by something better later).
# (and no empty spacer after the name: it took half the row, so names were cut at half width)
swap("\n          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1()),", ",", "git tail")
swap(".child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))",
     ".child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(w.name))", "space name width")
swap("mine.map(draw)", "mine.flatMap(draw)", "machine rows")
swap("export default class", r'''// spaces-flat: the agents in a space, under it (block(), styles.js).
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
function since(ms) {
  if (!ms) return "";
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}
// When each agent's status last changed: terminals() copies every terminal, so read it at most
// twice a second, not once per space per redraw.
const times = { at: 0, map: new Map() };
function statusTimes() {
  if (Date.now() - times.at > 500) times.map = new Map(terminals().map((x) => [x.address, x.status_ms])), (times.at = Date.now());
  return times.map;
}
// What it is doing: the agent's own title (Claude Code titles the terminal with its task),
// else a tab someone named, else the program.
function agentLabel(a) {
  const prog = a.program?.name ?? "";
  const own = clean(a.title);
  return own && own !== prog && !/^[~/]/.test(own) ? own : !/^\d+$/.test(a.tab_name ?? "") && a.tab_name ? a.tab_name : prog;
}

export default class''', "agent rows")
# Groups (see the space-groups mod; groups.js is copied here: a mod imports only its own files).
swap('watchFolder, window, layout } from "herdr";',
     'watchFolder, window, layout, home, appHome, readTextFile } from "herdr";\n'
     'import { CONFIG_FILE as GROUPS_FILE, SHARED_KEY as GROUPS_KEY, parseConfig as parseGroups, parseManual, assign, prune } from "./groups.js";\n'
     'import { spaceBlock } from "./styles.js";',
     "groups import")
swap("""    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });""",
     """    // spaces-flat: the space-groups menu (groups, then Rename, Close, More… = Herdr's menu).
    openOverlay({ mod: "space-groups", kind: "popup", width: 230, height: 360, props: { space: w.id } });""", "space menu")
swap("""    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));""",
     """    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    // spaces-flat: groups. The rules file is read now and every 10 s (it is small).
    this.groupsFolded = new Set(JSON.parse(localStorage.getItem("groups.folded") ?? "[]"));
    this.groupRules = { groups: [] };
    const readRules = async (cx) => { this.groupRules = parseGroups(await readTextFile(`${appHome()}/${GROUPS_FILE}`).catch(() => null), home()); cx.notify(); };
    cx.spawn(readRules);
    cx.timer.every(10000, (cx) => { cx.spawn(readRules); });
    this.width = 252; // the list's inner width: styles.js wraps names and titles to it""", "groups init")
swap("""    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.flatMap(draw);""",
     """    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : this.byGroup(rows, t, collapsed, draw);""", "groups rows")
swap("""  // The rows, under a header per machine once one isn't this computer.""", """  // spaces-flat: the rows under a header per group (rules, your folders, Other).
  byGroup(rows, t, collapsed, draw) {
    const ps = panes();
    const live = new Set(spaces().map((s) => s.id));
    const stored = parseManual(shared(GROUPS_KEY));
    const manual = prune(stored, live);
    if (Object.keys(manual.of).length !== Object.keys(stored.of).length) setShared(GROUPS_KEY, manual);
    const groups = assign(rows.map((r) => ({ id: r.w.id, folder: place(r.w, ps) })), this.groupRules, manual);
    if (groups.length === 1 && groups[0].name === null) return rows.flatMap(draw);
    const byId = new Map(rows.map((r) => [r.w.id, r]));
    return groups.flatMap((g) => {
      const mine = g.ids.map((id) => byId.get(id)).filter(Boolean);
      if (collapsed) return [div().id(`group-${g.name}`).h(1).mx(6).my(5).flex_none().bg(t.border), ...mine.flatMap(draw)];
      const folded = this.groupsFolded.has(g.name);
      const urgent = ["blocked", "done", "working"].find((s) => mine.some((r) => r.w.status === s));
      const head = h_flex().id(`group-${g.name}`).h(26).flex_none().mt(6).px(8).gap(6).items_center().rounded(6).text_size(11).text_color(t.dim)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.groupsFolded.delete(g.name) : this.groupsFolded.add(g.name);
          localStorage.setItem("groups.folded", JSON.stringify([...this.groupsFolded]));
          cx.notify();
        })
        .when(g.mine, (el) => el.on_mouse_down("right", () => openOverlay({ mod: "space-groups", kind: "popup", width: 230, height: 120, props: { group: g.name } })))
        .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none())
        .child(div().flex_none().font_semibold().child(g.name.toUpperCase()))
        .child(div().flex_none().child(String(mine.length)))
        .child(div().flex_1())
        .when(folded && Boolean(urgent), (el) => el.child(div().size(6).rounded(3).flex_none().bg(t[urgent])));
      return [head, ...(folded ? [] : mine.flatMap(draw))];
    });
  }

  // The rows, under a header per machine once one isn't this computer.""", "groups method")

# The look (styles.js): row()'s presses (select, drag to reorder, right-click menu) move to
# attach(), so the taller block() has the same ones; row() keeps its own look.
swap("""    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
""" + PRESSES + """      .child(
""", """    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return this.attach(v_flex()
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover))), w, i, t)
      .child(
""", "row presses")
swap("""  compact({ w, i }, t) {""", """  // spaces-flat: one space and its agents, in the look of styles.js.
  block({ w, i }, t) {
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    const when = statusTimes();
    const list = agents().filter((a) => a.space === w.id).map((a) => ({
      address: a.address, status: a.status, focused: a.focused, label: agentLabel(a), age: since(when.get(a.address)),
    }));
    return spaceBlock({
      w, t, fill, list, width: this.width,
      attach: (el) => this.attach(el, w, i, t),
      go: (a) => run("agent.focus", { terminal: a.address }),
    });
  }

  // spaces-flat: selecting, dragging to reorder and the right-click menu (Herdr's, from row()).
  attach(el, w, i, t) {
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    return el
      .relative()
      .id(`space-${w.id}`)
""" + PRESSES.rstrip("\n") + """;
  }

  compact({ w, i }, t) {""", "space block")
# The list's inner width, for wrapping (styles.js).
# Herdr 0.1.14 made the list's side padding depend on the rail (px(collapsed ? 0 : 8)); 0.1.13 had px(8).
LIST = """      .child(v_flex().flex_1().min_h(0).px(%s).pb(14).overflow_y_scrollbar().mode("always")
"""
LIST_NEW = """      .child(v_flex().id("space-list").flex_1().min_h(0).px(%s).pb(14).overflow_y_scrollbar().mode("always")
        .on_size_change((size, cx) => { const w = Math.round(size.width) - 16; if (w > 0 && w !== this.width) { this.width = w; cx.notify(); } })
"""
pad = "collapsed ? 0 : 8" if LIST % "collapsed ? 0 : 8" in s else "8"
swap(LIST % pad, LIST_NEW % pad, "list width")
open(mod, "w").write(s)
open(f"{home}/mods/spaces-flat/styles.js", "w").write(STYLES)
import shutil
shutil.copy(f"{home}/mods/space-groups/groups.js", f"{home}/mods/spaces-flat/groups.js")
shutil.copy(f"{home}/mods/space-groups/groups.js", f"{home}/mods/agent-queue/groups.js")

layout = f"{home}/layouts/main-flat.json"
d = json.load(open(layout))


def extras(node):
    """The queue under the spaces, and the usage bar in place of the shipped one."""
    if not isinstance(node, dict):
        return False
    changed = False
    content = node.get("content")
    if isinstance(content, dict) and content.get("mod") == "workspace-status":
        node["content"] = {"mod": "agent-usage", "props": {"role": "bar"}}
        changed = True
    kids = node.get("children", [])
    if any(isinstance(k, dict) and isinstance(k.get("content"), dict) and k["content"].get("mod") == "spaces-flat" for k in kids) \
            and not any(isinstance(k, dict) and isinstance(k.get("content"), dict) and k["content"].get("mod") == "agent-queue" for k in kids):
        kids.append({"id": "queue", "type": "block", "size": {"weight": 1}, "content": {"mod": "agent-queue"}})
        node["resizable"] = True
        changed = True
    return any([changed] + [extras(k) for k in node.get("children", [])])


def walk(node):
    if not isinstance(node, dict):
        return False
    changed = False
    content = node.get("content")
    if isinstance(content, dict) and content.get("mod") == "spaces":
        content["mod"] = "spaces-flat"
        changed = True
    kids = node.get("children", [])
    keep = [k for k in kids if not (isinstance(k, dict) and isinstance(k.get("content"), dict) and k["content"].get("mod") == "agents")]
    if len(keep) != len(kids):
        node["children"] = keep
        changed = True
    return any([changed] + [walk(k) for k in node.get("children", [])])


if not walk(d.get("root", d)):
    sys.exit(f"main-flat: no spaces or agents block found; edit {layout} by hand.")
if not extras(d.get("root", d)):
    sys.exit(f"main-flat: no status bar or spaces list found; edit {layout} by hand.")


def find(node, pred, parent=None):
    """(node, parent) of the first node that satisfies pred, or (None, None)."""
    if not isinstance(node, dict):
        return None, None
    if pred(node):
        return node, parent
    for k in node.get("children", []):
        r = find(k, pred, node)
        if r[0]:
            return r
    return None, None


def block_of(mod):
    return lambda n: isinstance(n.get("content"), dict) and n["content"].get("mod") == mod


def viewbar(root):
    """7. The view bar (viewbar mod, plan-review mod): a thin bar under the tabs, the tab area and
    the plan in one stack (main-stack: Agent | Plan), a second view column left of Files/Changes,
    and the hotkeys button beside the usage bar."""
    if find(root, lambda n: n.get("id") == "main-stack")[0]:
        return
    # The tab area becomes the stack's first child; the plan (plan-review) is its second.
    main, body = find(root, lambda n: isinstance(n.get("content"), dict) and n["content"].get("tab") == "active")
    if not main or not body or body.get("type") != "row":
        sys.exit(f"main-flat: no tab area in a row found; edit {layout} by hand.")
    stack = {"id": "main-stack", "type": "stack", "active": main["id"], "children": [
        main,
        {"id": "plan", "type": "block", "content": {"mod": "plan-review"}, "background": "background",
         "border": {"width": 1, "color": "border"}, "radius": 10},
    ]}
    kids = body["children"]
    kids[kids.index(main)] = stack
    # The second view: a column on the right edge, shown instead of Files/Changes (viewbar mod).
    panel, _ = find(body, lambda n: n.get("id") == "panel")
    side = {"id": "side", "type": "column", "hidden": True, "size": {"px": 400}, "min": 300, "max": 900, "children": [
        {"id": "side-view", "type": "block", "content": {"mod": "viewbar", "props": {"role": "side"}}}]}
    kids.insert(kids.index(panel) if panel else len(kids), side)
    # The bar itself, between the tabs and the work area.
    work, _ = find(root, lambda n: body in n.get("children", []))
    work["children"].insert(work["children"].index(body), {
        "id": "viewbar", "type": "block", "size": {"px": 36}, "content": {"mod": "viewbar", "props": {"role": "bar"}}})
    # The status bar: the usage bar, and the hotkeys button at its right end.
    status, parent = find(root, lambda n: isinstance(n.get("content"), dict) and n["content"].get("mod") == "agent-usage"
                          and n["content"].get("props", {}).get("role") == "bar")
    if not status or not parent:
        sys.exit(f"main-flat: no status bar found; edit {layout} by hand.")
    usage = {"id": "usage", "type": "block", "content": status["content"]}
    keys = {"id": "keys", "type": "block", "size": {"px": 44}, "content": {"mod": "viewbar", "props": {"role": "keys-button"}}}
    row = {"id": status["id"], "type": "row", "size": status.get("size", {"px": 28}), "resizable": False, "children": [usage, keys]}
    parent["children"][parent["children"].index(status)] = row


viewbar(d.get("root", d))
json.dump(d, open(layout, "w"), indent=2)
print("spaces-flat patched: no nesting, agents inside spaces; main-flat: no Agents list, queue, usage bar and view bar added.")
