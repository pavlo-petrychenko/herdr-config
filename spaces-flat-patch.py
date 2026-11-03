#!/usr/bin/env python3
"""Turns a fresh copy of Herdr's `spaces` mod into `spaces-flat`, and `main` into `main-flat`.

Run by spaces-flat-sync.sh after it re-copies them. Every change is an exact text swap: when
Herdr changed the text, it stops and names the swap, so nothing is patched half way.

  1. No nesting: every space is its own row, worktrees too.
  2. Agents inside spaces: under each space row, one row per agent in it (status, what it is
     doing, since when) with the agent's logo. Click: go to that agent.
  3. No "repo · branch" text after a space's name, and no git checks at all.
  5. Groups: spaces under group headers (Work, Personal, your own folders; space-groups mod,
     rules in space-groups.json). Right-click a space: its group menu (space-groups).
  4. The layout: the sidebar shows spaces-flat with the agent queue (agent-queue) under it, the
     separate Agents list is gone, and the bottom bar is agent-usage (the shipped bar plus usage).
"""
import json
import sys

home, = sys.argv[1:] or [__import__("os").path.expanduser("~/.config/herdr-app")]
mod = f"{home}/mods/spaces-flat/main.js"
s = open(mod).read()


def swap(old, new, what):
    global s
    if s.count(old) != 1:
        sys.exit(f"spaces-flat: Herdr changed the code for '{what}'; patch {mod} by hand.")
    s = s.replace(old, new)


swap('import { View, div, svg } from "gpui-kit";', 'import { View, div, svg, image } from "gpui-kit";', "gpui imports")
swap('import { spaces, machines, panes, run,', 'import { agents, terminals, spaces, machines, panes, run,', "imports")
swap("    const nested = (r) => r.g?.linked && mains.has(r.g.repo);\n",
     "    // spaces-flat: every space is its own row, worktrees too.\n    const nested = () => false;\n", "nesting")
swap("const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));",
     "const draw = (r) => (collapsed ? this.compact(r, t) : [this.row(r, t), ...agentRows(r.w, t)]);", "space rows")
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
swap(".child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1()),", ".child(div().flex_1()),", "git tail")
swap(".child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))",
     ".child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(w.name))", "space name width")
swap("mine.map(draw)", "mine.flatMap(draw)", "machine rows")
swap("export default class", r'''// spaces-flat: the agents in a space, as rows under it.
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
function agentRows(w, t) {
  const mine = agents().filter((a) => a.space === w.id);
  if (!mine.length) return [];
  const when = statusTimes();
  return mine.map((a) => {
    const prog = a.program?.name ?? "";
    const own = clean(a.title);
    // What it is doing: the agent's own title (Claude Code titles the terminal with its task),
    // else a tab someone named, else the program.
    const label = own && own !== prog && !/^[~/]/.test(own) ? own : !/^\d+$/.test(a.tab_name ?? "") && a.tab_name ? a.tab_name : prog;
    const mark = a.status === "working"
      ? svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)
      : div().size(7).flex_none().rounded(4).when(a.status === "idle", (el) => el.border_1().border_color(t.dim)).when(a.status !== "idle", (el) => el.bg(t[a.status] ?? t.dim));
    return h_flex()
      .id(`agent-${a.address}`)
      .h(24)
      .flex_none()
      .pl(36)
      .pr(8)
      .gap(8)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .when(a.focused, (el) => el.bg(t.hover))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("agent.focus", { terminal: a.address }))
      .child(h_flex().w(11).flex_none().justify_center().child(mark))
      // The agent's logo from Herdr's program table (Claude Code, OpenCode, Codex, ...).
      .children(a.program?.icon ? [a.program.tint ? svg(a.program.icon).size(14).flex_none().text_color(t.foreground) : image(a.program.icon).w(14).h(14).flex_none()] : [])
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(a.status === "idle" ? t.muted : t.foreground).child(label))
      .child(div().flex_none().text_size(11).text_color(a.status === "blocked" ? t.blocked : t.dim).child(a.status === "blocked" ? "needs you" : since(when.get(a.address))));
  });
}

export default class''', "agent rows")
# Groups (see the space-groups mod; groups.js is copied here: a mod imports only its own files).
swap('watchFolder, window, layout } from "herdr";',
     'watchFolder, window, layout, home, appHome, readTextFile } from "herdr";\n'
     'import { CONFIG_FILE as GROUPS_FILE, SHARED_KEY as GROUPS_KEY, parseConfig as parseGroups, parseManual, assign, prune } from "./groups.js";',
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
    cx.timer.every(10000, (cx) => { cx.spawn(readRules); });""", "groups init")
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
open(mod, "w").write(s)
import shutil
shutil.copy(f"{home}/mods/space-groups/groups.js", f"{home}/mods/spaces-flat/groups.js")

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
json.dump(d, open(layout, "w"), indent=2)
print("spaces-flat patched: no nesting, agents inside spaces; main-flat: no Agents list, queue and usage bar added.")
