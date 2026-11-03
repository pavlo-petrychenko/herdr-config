// A space's right-click menu in the spaces-flat sidebar, with groups. Props:
//   { space: id }  move it to a group (or back to the rules), make a folder and move it there,
//                  then Rename, Close, and More… (Herdr's own space menu)
//   { group: name } one of your folders: rename it, or delete it (its spaces go back to the rules)
// Groups: groups.js. ↑↓ choose, Enter picks, Esc closes.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { props, run, theme, spaces, shared, setShared, closeOverlay, openOverlay, home, appHome, readTextFile } from "herdr";
import { CONFIG_FILE, SHARED_KEY, OTHER, parseConfig, parseManual, groupOf, move, addFolder, removeFolder, renameFolder } from "./groups.js";

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;

export default class SpaceGroups extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.spaceId = p.space ?? null;
    this.group = p.group ?? null;
    this.config = { groups: [] };
    this.at = 0;
    this.naming = null; // "new" | "rename" while the name field shows
    this.input = InputState.new({ placeholder: "Folder name" });
    this.input.on("submit", (_e, cx) => this.submitName(cx));
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      this.config = parseConfig(await readTextFile(`${appHome()}/${CONFIG_FILE}`).catch(() => null), home());
      cx.notify();
    });
  }

  manual() { return parseManual(shared(SHARED_KEY)); }
  save(m) { setShared(SHARED_KEY, m); }
  close() { closeOverlay(props()?.overlay); }

  // [label, icon, action, checked?]
  items() {
    const m = this.manual();
    if (this.group) return [["Rename folder", "square-pen", () => this.ask("rename")], ["Delete folder", "x", () => { this.save(removeFolder(m, this.group)); this.close(); }]];
    const space = spaces().find((s) => s.id === this.spaceId);
    if (!space) return [];
    const now = groupOf({ id: space.id, folder: space.folder }, this.config, m);
    const names = [...this.config.groups.map((g) => g.name), ...m.folders.filter((n) => !this.config.groups.some((g) => g.name === n))];
    return [
      ...names.map((n) => [n, "folder", () => { this.save(move(m, space.id, n)); this.close(); }, now.name === n]),
      ...(now.why === "moved" ? [["Back to the rules", "chevron-left", () => { this.save(move(m, space.id, null)); this.close(); }]] : []),
      ["New folder…", "folder-plus", () => this.ask("new")],
      null,
      ["Rename", "square-pen", () => { this.close(); run("space.rename", { id: space.id }); }],
      ["Close", "x", () => { this.close(); run("space.close", { id: space.id }); }],
      ["More…", "chevron-right", () => { this.close(); openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: space.id } } }); }],
    ];
  }

  ask(mode) {
    this.naming = mode;
    this.input.set_value(mode === "rename" ? this.group : "");
    this.input.focus();
  }

  submitName(_cx) {
    const name = this.input.value().trim();
    const m = this.manual();
    if (!name || name === OTHER) return;
    if (this.naming === "rename") this.save(renameFolder(m, this.group, name));
    else this.save(this.spaceId ? move(addFolder(m, name), this.spaceId, name) : addFolder(m, name));
    this.close();
  }

  key(e, cx) {
    const list = this.items().map((x, i) => (x ? i : -1)).filter((i) => i >= 0);
    if (e.key === "escape") { if (this.naming) { this.naming = null; this.handle.focus(); } else this.close(); }
    else if (this.naming) return;
    else if (e.key === "down" || e.key === "up") {
      const k = list.indexOf(this.at);
      this.at = list[(Math.max(0, k) + (e.key === "down" ? 1 : list.length - 1)) % list.length];
    } else if (e.key === "enter") this.items()[this.at]?.[2]();
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  render(_cx) {
    const t = theme();
    const items = this.items();
    if (items[this.at] === null) this.at += 1;
    return v_flex().id("space-groups").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().p(5).bg(t.popover).text_size(12.8)
      .when(!this.group && !this.naming, (el) => el.child(div().px(8).pt(3).pb(4).text_size(11).text_color(t.dim).child("Group")))
      .when(Boolean(this.naming), (el) => el.child(v_flex().p(4).gap(6)
        .child(div().text_size(11).text_color(t.dim).child(this.naming === "rename" ? "Rename folder" : "New folder (the space moves there)"))
        .child(h_flex().id("name").h(30).px(8).rounded(7).border_1().border_color(t.accent).bg(t.background)
          .child(Input.new(this.input).flex_1().h_full().text_color(t.foreground)))
        .child(div().text_size(11).text_color(t.dim).child("↵ save · Esc back"))))
      .when(!this.naming, (el) => el.children(items.map((it, i) => it === null
        ? div().id(`sep-${i}`).mx(7).my(4).h(1).bg(t.border)
        : h_flex().id(`gi-${i}`).h(30).px(8).gap(9).rounded(7).items_center().cursor_pointer()
          .when(i === this.at, (x) => x.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_mouse_move((_e, cx) => { if (this.at !== i) { this.at = i; cx.notify(); } })
          .on_click(() => it[2]())
          .child(svg(ICON(it[1])).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().truncate().text_color(t.foreground).child(it[0]))
          .when(Boolean(it[3]), (x) => x.child(svg(ICON("check")).size(13).flex_none().text_color(t.accent))))));
  }
}
