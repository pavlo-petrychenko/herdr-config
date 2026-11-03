// A read-only file viewer beside an agent. Agents open it with `herdr-show <file[:from[-to]]>`
// (~/.local/bin/herdr-show), which splits this pane to the right of the agent's terminal and
// writes what to show into the agent's state file (state.js). One viewer per agent, with file
// tabs; a second file becomes a tab. Esc or ✕ closes the viewer; a tab's ✕ closes the tab.
//
// Views of a file:
//   lines  a cited range: every line, the range marked and scrolled into view (no colors)
//   code   the whole file, highlighted (Herdr's code view cannot scroll to a line)
//   md     markdown, rendered
// The header button switches between the range or rendered view and the code.
// Props: { terminal, state } (the agent's terminal id, its state file).
// Commands (keys.json, or `herdr-app do file-viewer.<cmd>`; every viewer on screen gets them):
//   close, tab-close, next, prev, toggle.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { props, run, theme, settings, home, exec, readTextFile, writeTextFile, watchFolder, nextCommand } from "herdr";
import { parseState, closeTab, languageOf, isMarkdown } from "./state.js";

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const ROW = 18;
// "Open in Zed": its CLI, by full path (a mod's PATH may not have /usr/local/bin). `file:line`
// opens at that line, in the Zed window that already has the folder, if one does.
const ZED = "/Applications/Zed.app/Contents/MacOS/cli";
const dirOf = (path) => path.slice(0, path.lastIndexOf("/")) || "/";
const nameOf = (path) => path.split("/").pop();

export default class FileViewer extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.terminal = p.terminal;
    this.file = p.state;
    this.home = home();
    this.raw = null; // the state file's text as last read: the expected value of the next write
    this.state = parseState(null);
    this.files = new Map(); // path → { text, lines, code, error }
    this.mode = new Map(); // path → "code" when switched to the code view
    this.watched = new Set();
    this.scroll = VirtualListScrollHandle.new();
    this.handle = cx.focus_handle();
    if (!this.file) { this.error = "Open with herdr-show."; return; }
    cx.spawn(async (cx) => {
      for (;;) {
        this.command(String(await nextCommand()).replace(/^file-viewer\./, ""), cx);
        cx.notify();
      }
    });
    cx.spawn(async (cx) => {
      await this.reload(cx);
      for (;;) {
        const changed = await watchFolder(dirOf(this.file));
        if (changed.includes(this.file)) await this.reload(cx);
      }
    });
  }

  async reload(cx) {
    const raw = await readTextFile(this.file);
    if (raw === this.raw) return;
    const before = this.state.active;
    const seq = this.state.seq;
    this.raw = raw;
    this.state = parseState(raw);
    // herdr-show wrote: the active tab may be new, or the same file at a new range.
    if (this.state.active && (this.state.active !== before || this.state.seq !== seq)) {
      this.mode.delete(this.state.active);
      await this.load(this.state.active, cx);
      this.reveal();
    }
    cx.notify();
  }

  async load(path, cx) {
    this.files.get(path)?.code?.release();
    const text = await readTextFile(path).catch(() => null);
    const entry = { text, lines: [], code: null, error: null };
    if (text === null) entry.error = "The file is missing, or larger than 1 MiB.";
    else if (text.includes("\0")) entry.error = "A binary file: nothing to show.";
    else {
      entry.lines = text.split("\n");
      // The code view's state: made here, never during a redraw (Herdr refuses that).
      const t = theme();
      entry.code = EditorState.new({
        language: languageOf(path), readonly: true, value: text, font_family: settings().font_family, font_size: 12,
        syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
      });
    }
    this.files.set(path, entry);
    this.watch(dirOf(path), cx);
  }

  // Reload a shown file when it changes on disk.
  watch(dir, cx) {
    if (this.watched.has(dir)) return;
    this.watched.add(dir);
    cx.spawn(async (cx) => {
      for (;;) {
        const changed = new Set(await watchFolder(dir));
        const shown = this.state.tabs.filter((t) => changed.has(t.path) && this.files.has(t.path));
        for (const t of shown) await this.load(t.path, cx);
        if (shown.length) cx.notify();
      }
    });
  }

  tab() {
    return this.state.tabs.find((t) => t.path === this.state.active) ?? null;
  }

  view(tab) {
    if (this.mode.get(tab.path) === "code") return "code";
    if (tab.from) return "lines";
    return isMarkdown(tab.path) ? "md" : "code";
  }

  reveal() {
    const tab = this.tab();
    if (tab?.from) this.scroll.scroll_to_item(Math.max(0, tab.from - 4), "top");
  }

  // The viewer writes only to close tabs; a write that lost a race reads again and retries.
  async save(change, cx) {
    for (let i = 0; i < 3; i++) {
      const next = change(this.state);
      try {
        const text = JSON.stringify(next, null, 2);
        await writeTextFile(this.file, text, this.raw);
        this.raw = text;
        this.state = next;
        cx.notify();
        return next;
      } catch {
        this.raw = await readTextFile(this.file);
        this.state = parseState(this.raw);
      }
    }
    return this.state;
  }

  closeTab(path, cx) {
    cx.spawn(async (cx) => {
      const next = await this.save((s) => closeTab(s, path), cx);
      this.files.get(path)?.code?.release();
      this.files.delete(path);
      if (!next.tabs.length) return this.closeViewer(cx);
      if (!this.files.has(next.active)) await this.load(next.active, cx);
      this.reveal();
      cx.notify();
    });
  }

  select(path, cx) {
    cx.spawn(async (cx) => {
      await this.save((s) => ({ ...s, active: path }), cx);
      if (!this.files.has(path)) await this.load(path, cx);
      this.reveal();
      cx.notify();
    });
  }

  closeViewer(cx) {
    const pane = this.state.pane;
    cx.spawn(async (cx) => {
      await this.save((s) => ({ ...s, tabs: [], active: null, pane: null }), cx);
      if (pane) run("pane.close", { pane });
    });
  }

  toggle(cx) {
    const tab = this.tab();
    if (!tab) return;
    if (this.mode.get(tab.path) === "code") this.mode.delete(tab.path);
    else this.mode.set(tab.path, "code");
    this.reveal();
    cx.notify();
  }

  command(c, cx) {
    const tab = this.tab();
    const tabs = this.state.tabs;
    const at = tabs.indexOf(tab);
    if (c === "close") return this.closeViewer(cx);
    if (c === "toggle") return this.toggle(cx);
    if (!tab) return;
    if (c === "tab-close") return this.closeTab(tab.path, cx);
    if ((c === "next" || c === "prev") && tabs.length > 1) this.select(tabs[(at + (c === "next" ? 1 : tabs.length - 1)) % tabs.length].path, cx);
  }

  key(e, cx) {
    if (e.key !== "escape") return;
    cx.stop_propagation();
    this.closeViewer(cx);
  }

  code(entry) {
    return Editor.new(entry.code).flex_1().min_h(0);
  }

  lines(tab, entry, t) {
    const width = String(entry.lines.length).length;
    const to = tab.to ?? tab.from;
    return div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
      .child(v_virtual_list("lines", entry.lines.length, ROW, (i) => String(i), (range) => {
        const out = [];
        for (let i = range.start; i < range.end; i++) {
          const n = i + 1;
          const on = n >= tab.from && n <= to;
          out.push(h_flex().h(ROW).w_full().items_center().when(on, (el) => el.bg(t.selected))
            .child(div().w(3).h_full().flex_none().when(on, (el) => el.bg(t.accent)))
            .child(div().w(width * 8 + 16).flex_none().pr(10).text_right().text_color(on ? t.foreground : t.dim).child(String(n)))
            .child(div().flex_1().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(entry.lines[i] || " ")));
        }
        return out;
      }).track_scroll(this.scroll).size_full())
      .child(Scrollbar.vertical("lines").viewport_from_layout().absolute().inset_0());
  }

  body(tab, t) {
    const entry = this.files.get(tab.path);
    if (!entry) return div().p(12).text_color(t.dim).child("Loading…");
    if (entry.error) return div().p(12).text_color(t.blocked).child(entry.error);
    const view = this.view(tab);
    if (view === "lines") return this.lines(tab, entry, t);
    if (view === "md") return div().id("md").flex_1().min_h(0).px(16).py(8).overflow_y_scrollbar().child(TextView.markdown("md", entry.text).selectable(true));
    return this.code(entry);
  }

  render(_cx) {
    const t = theme();
    const root = v_flex().id("file-viewer").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.handle.focus())
      .size_full().bg(t.background).text_size(12).text_color(t.foreground);
    if (this.error) return root.child(div().p(12).text_color(t.dim).child(this.error));
    const tab = this.tab();
    const tabs = h_flex().id("tabs").flex_none().h(32).pl(4).pr(4).gap(2).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().id("tab-row").flex_1().min_w(0).gap(2).items_center().overflow_x_scrollbar()
        .children(this.state.tabs.map((x, i) => {
          const on = x.path === this.state.active;
          return h_flex().id(`tab-${i}`).flex_none().h(24).pl(8).pr(4).gap(6).items_center().rounded(6).cursor_pointer()
            .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
            .on_click((_e, cx) => this.select(x.path, cx))
            .child(div().max_w(180).truncate().text_color(on ? t.foreground : t.muted).child(nameOf(x.path)))
            .child(h_flex().id(`tab-x-${i}`).size(16).flex_none().items_center().justify_center().rounded(4).hover((s) => s.bg(t.raised))
              .on_click((_e, cx) => { cx.stop_propagation(); this.closeTab(x.path, cx); })
              .child(svg(ICON("x")).size(11).flex_none().text_color(t.muted)));
        })))
      .when(Boolean(tab && (tab.from || isMarkdown(tab.path))), (el) => el.child(
        div().id("toggle").flex_none().px(8).h(22).flex().items_center().rounded(5).cursor_pointer().text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.toggle(cx))
          .child(this.view(tab) === "code" ? (tab.from ? "Range" : "Rendered") : "Code")))
      .when(Boolean(tab), (el) => el.child(
        div().id("external").flex_none().px(8).h(22).flex().items_center().rounded(5).cursor_pointer().text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover))
          .on_click(() => { exec(ZED, [tab.from ? `${tab.path}:${tab.from}` : tab.path]); })
          .child("Zed ↗")))
      .child(h_flex().id("close").size(24).flex_none().items_center().justify_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.closeViewer(cx))
        .child(svg(ICON("x")).size(14).flex_none().text_color(t.foreground)));
    if (!tab) return root.child(tabs).child(div().p(12).text_color(t.dim).child("Nothing to show."));
    const path = tab.path.startsWith(this.home) ? `~${tab.path.slice(this.home.length)}` : tab.path;
    const range = tab.from ? (tab.to && tab.to !== tab.from ? `lines ${tab.from}–${tab.to}` : `line ${tab.from}`) : "";
    return root
      .child(tabs)
      .child(v_flex().flex_none().px(12).py(6).gap(2).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).text_size(11)
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(path))
          .when(Boolean(range), (el) => el.child(div().flex_none().text_color(t.accent).child(range))))
        .when(Boolean(tab.note), (el) => el.child(div().text_size(12).text_color(t.foreground).child(tab.note))))
      .child(this.body(tab, t));
  }
}
