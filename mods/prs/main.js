// Pull requests: the PRs of the agent in the focused tab, with their stacks drawn, and a preview
// (description, checks, files, a file's diff).
//
// Data: `herdr-prs refresh <terminal>` writes <app home>/data/prs/<terminal>.json (extras/prs/FORMAT.md);
// this view runs it and reads the file. The preview's parts come from `herdr-prs detail`. The binary is
// `herdr-prs` on Herdr's PATH, or "cli" in mods/prs/config.json ({ "cli": "/abs/path/to/herdr-prs" }).
//
// Where: the view bar's second view (layout column "side"): its stack "side-stack" shows this mod as
// "side-prs". Close: the X, or `viewbar.prs` again.
//
// Refresh (model.js refreshPlan): only while shown. At once with discover when the view gets a terminal,
// then every 45 s (15 s while a shown PR has running checks), discover every 5 minutes. One `herdr-prs`
// refresh at a time, and one detail call at a time. After each refresh: shared "prs.updated" { terminal, at }.
//
// List: layout A, the rail read from the base: the base branch, the bottom PR, each next PR above it.
// Below 720 px the preview takes the column (Esc goes back); from 720 px it sits beside the list.
//
// Keys (when it has the keyboard): up/down or j/k move, Enter preview, Esc back, o open in the browser,
// c copy the URL, r refresh now, d show/hide done PRs, s next scope, 1/2/3 the preview's tabs, w wide/narrow.
// Commands (`herdr-app do prs.<name>`): focus, up, down, preview, back, open, copy, refresh, close,
// toggle-done, scope-worktree|agent, filter-<maker key>|filter-all, select-<n>, tab-overview|checks|files,
// file-<i> (the i-th file's diff), wide, narrow, collapse-<n> / expand-<n> (the stack holding PR #n).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { theme, settings, appHome, readTextFile, nextCommand, run, setShared, shared, notify, exec, focused, agents } from "herdr";
import * as M from "./model.js";
import { parseDiff, untab } from "./diff.js";

const MOD = "mods/prs";
const ICON = (n) => `${MOD}/icons/${n}.svg`;
const WIDE = 720; // from this width the preview sits beside the list
const LIST_W = 392;
const NARROW_PX = 400; // the side column's widths for `w`
const WIDE_PX = 900;
const UI_KEY = "prs.ui";
const UPDATED = "prs.updated"; // shared: { terminal, at } after each refresh
const EXEC_MS = 28000; // Herdr stops an exec at 30 s
const SHOWN_FOR = 6500; // rendered within this long ago = shown
const RETRY_MS = 20000; // a failed detail is asked for again after this

const sleep = (cx, ms) => new Promise((ok) => cx.timer.after(ms, ok));
const LAST = {}; // tab -> the agent terminal last focused there

// Colors by meaning, from the theme (light and dark name the same ones).
function palette(t) {
  return {
    state: { open: t.ansi2, draft: t.muted, merged: t.ansi5, closed: t.ansi1 },
    check: { pass: t.ansi2, fail: t.ansi1, pending: t.ansi3, none: t.dim, skip: t.dim },
    review: { approved: t.ansi2, changes: t.ansi1, required: t.ansi3, none: t.dim },
    rail: t.input ?? t.border,
    card: t.surface ?? t.background,
  };
}
const STATE_ICON = { open: "pr", draft: "pr-draft", merged: "pr-merged", closed: "pr-closed" };
const STATE_LABEL = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };
const CHECK_ICON = { pass: "check-pass", fail: "check-fail", pending: "check-pending", none: "check-none", skip: "check-skip" };
const CHECK_WORD = { pass: "Checks pass", fail: "Checks fail", pending: "Checks running", none: "No checks" };
const REVIEW_ICON = { approved: "review-approved", changes: "review-changes", required: "review-required", none: "review-required" };
const REVIEW_WORD = { approved: "Approved", changes: "Changes requested", required: "Review required", none: "No review" };
const CREATOR_ICON = { worktree: "folder-git", agent: "bot", subagent: "subagent", workflow: "workflow", person: "user" };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmtSecs = (s) => (s == null ? "" : s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
const firstLines = (s, n = 2) => String(s ?? "").trim().split("\n").slice(0, n).join(" ").slice(0, 300);

export default class Prs extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.w = 400;
    const ui = this.readUi();
    this.saved = ui.scope === "worktree" ? "worktree" : "agent"; // the user's last click on a scope
    this.scope = "agent"; // until the data says whether Worktree has anything (M.pickScope)
    this.scopePending = true;
    this.showDone = Boolean(ui.showDone);
    this.cli = "herdr-prs";
    this.filter = null;
    this.sel = null; // a PR id: "owner/repo#12"
    this.preview = false; // narrow: the preview has the column
    this.tab = "overview";
    this.file = null; // a path: its diff shows in the files tab
    this.collapsed = new Set();
    this.expanded = new Set();
    this.memo = null;
    this.keysWanted = false;
    // the agent and its data
    this.agent = null;
    this.terminal = null;
    this.data = null;
    this.raw = null;
    this.byId = new Map();
    this.dataError = null; // the file is unreadable
    this.refreshError = null; // the refresh command failed
    this.loaded = false; // the file was looked up for this terminal
    // the refresh loop
    this.refreshing = false;
    this.lastEnd = null;
    this.lastDiscover = null;
    this.force = false;
    this.opened = true;
    this.lastRender = 0;
    this.ticks = 0;
    // the preview's parts
    this.details = new Map(); // key -> { status: "loading" | "ok" | "err", value, error, at }
    this.detailBusy = false;

    cx.spawn(async (cx) => { await this.readConfig(); this.follow(cx); });
    // One timer loop for everything periodic: the agent in the focused tab, the refresh decision, the footer's clock.
    cx.spawn(async (cx) => {
      for (;;) {
        await sleep(cx, 1000);
        try { this.tick(cx); } catch (e) { this.dataError = String(e?.message ?? e); }
      }
    });
    // The keyboard: asked for by `prs.focus` (the view bar sends it when it shows this). The element may
    // not be in the window yet in the frame it first shows, so focus() is retried.
    cx.spawn(async (cx) => {
      for (;;) {
        if (!this.keysWanted) await new Promise((ok) => { this.keysWaker = ok; });
        for (let i = 0; this.keysWanted && i < 25; i++) {
          await sleep(cx, 40);
          try { this.handle.focus(); await sleep(cx, 20); if (this.handle.is_focused()) break; } catch { break; }
        }
        this.keysWanted = false;
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand()).replace(/^prs\./, "");
        this.command(c, cx);
        cx.notify();
      }
    });
  }

  readUi() {
    try { return JSON.parse(localStorage.getItem(UI_KEY) ?? "{}") ?? {}; } catch { return {}; }
  }
  saveUi() {
    try { localStorage.setItem(UI_KEY, JSON.stringify({ scope: this.saved, showDone: this.showDone })); } catch {}
  }

  wantKeys() {
    this.keysWanted = true;
    this.keysWaker?.();
    this.keysWaker = null;
  }

  async readConfig() {
    try {
      const raw = await readTextFile(`${appHome()}/${MOD}/config.json`);
      const cli = raw ? JSON.parse(raw)?.cli : null;
      if (typeof cli === "string" && cli.trim()) this.cli = cli.trim();
    } catch {}
  }

  // ---- the agent, the refresh loop --------------------------------------------------------------------

  // The agent of the focused tab (the view bar picks it the same way).
  follow(cx) {
    const f = focused();
    const list = agents();
    if (f?.terminal && list.some((a) => a.address === f.terminal && a.tab === f.tab)) LAST[f.tab] = f.terminal;
    const a = M.pickAgent(list, f, LAST);
    this.agent = a;
    const terminal = a?.address ?? null;
    if (terminal === this.terminal) return;
    this.terminal = terminal;
    this.data = null;
    this.raw = null;
    this.byId = new Map();
    this.dataError = null;
    this.refreshError = null;
    this.loaded = false;
    this.lastEnd = null;
    this.lastDiscover = null;
    this.force = true; // discover when the view opens for a terminal
    this.scope = "agent";
    this.scopePending = true; // the first data of this terminal picks the scope
    this.sel = null;
    this.file = null;
    this.preview = false;
    this.memo = null;
    this.filter = null;
    this.collapsed = new Set();
    this.expanded = new Set();
    if (terminal) this.readFile(cx, terminal);
    cx.notify();
  }

  tick(cx) {
    this.ticks++;
    this.follow(cx);
    const now = Date.now();
    const shown = now - this.lastRender < SHOWN_FOR;
    // A hidden view is not drawn, so it can only learn that it shows from a draw: ask for one now and then.
    if (shown || this.ticks % 3 === 0) cx.notify();
    if (!shown || !this.terminal || this.refreshing) return;
    const plan = M.refreshPlan({ now, shown, lastEnd: this.lastEnd, lastDiscover: this.lastDiscover, pending: M.anyPending(this.shownPrs()),
      force: this.force, opened: this.opened });
    if (plan.run) this.refresh(cx, plan.discover);
  }

  // The PRs the list shows now (for the "checks are running" decision).
  shownPrs() {
    return M.rowOrder(this.items()).map((id) => this.byId.get(id)).filter(Boolean);
  }

  async readFile(cx, terminal) {
    let raw = null, error = null;
    try { raw = await readTextFile(`${appHome()}/data/prs/${terminal}.json`); } catch (e) { error = `Could not read the data file: ${String(e?.message ?? e)}`; }
    if (terminal !== this.terminal) return; // the agent changed while reading
    this.loaded = true;
    if (raw != null && raw === this.raw) { cx.notify(); return; }
    if (raw == null) {
      this.raw = null;
      this.data = null;
      this.dataError = error;
      cx.notify();
      return;
    }
    const parsed = M.parseData(raw);
    this.raw = raw;
    if (parsed.error) { this.dataError = parsed.error; cx.notify(); return; }
    this.dataError = null;
    this.data = parsed.data;
    this.byId = new Map(parsed.data.prs.map((p) => [M.idOf(p), p]));
    this.memo = null;
    if (this.scopePending) { this.scopePending = false; this.scope = M.pickScope(parsed.data.prs, this.saved); this.filter = null; }
    if (this.filter && !M.creators(this.data.prs, this.scope, { showDone: this.showDone }).some((c) => c.key === this.filter)) this.filter = null;
    const order = this.order();
    this.select(order.includes(this.sel) ? this.sel : order[0] ?? null, cx);
    cx.notify();
  }

  refresh(cx, discover) {
    const terminal = this.terminal;
    this.refreshing = true;
    this.force = false;
    this.opened = false;
    cx.spawn(async (cx) => {
      let error = null;
      try {
        const r = await this.run(["refresh", terminal, ...(discover ? ["--discover"] : [])]);
        if (r.code === 127) error = `herdr-prs was not found. Install it, or set "cli" in ${MOD}/config.json.`;
        else if (r.code !== 0) error = firstLines(r.stderr) || `herdr-prs refresh exited with ${r.code}`;
      } catch (e) {
        error = `herdr-prs could not run: ${String(e?.message ?? e)}`;
      }
      this.refreshing = false;
      const done = Date.now();
      if (terminal === this.terminal) {
        this.lastEnd = done;
        if (discover && !error) this.lastDiscover = done;
        this.refreshError = error;
        if (!error) {
          await this.readFile(cx, terminal);
          const at = this.data?.at;
          if (at && terminal === this.terminal) {
            const cur = shared(UPDATED);
            if (cur?.terminal !== terminal || cur?.at !== at) setShared(UPDATED, { terminal, at });
          }
          this.pumpDetail(cx);
        }
      }
      cx.notify();
    });
  }

  // `herdr-prs <args>` with this app's home, so the command writes where this view reads.
  run(args, timeout = EXEC_MS) {
    return exec("/usr/bin/env", [`HERDR_APP_HOME=${appHome()}`, this.cli, ...args], { timeout });
  }

  askRefresh() {
    this.force = true;
    for (const [k, v] of this.details) if (v.status === "err") this.details.delete(k);
  }

  // ---- the preview's parts: one `herdr-prs detail` at a time ---------------------------------------------

  pr(id) { return this.byId.get(id) ?? null; }

  // The cache key: what the PR was when asked. A new head, a new update or new check counts need a new answer.
  detailKey(p, part) {
    const c = part === "checks" ? `${p.checks?.state}:${p.checks?.pass}:${p.checks?.fail}:${p.checks?.pending}` : "";
    return [M.idOf(p), part, p.headOid, p.updatedAt, c].join("|");
  }

  part(p, part) { return p ? this.details.get(this.detailKey(p, part)) ?? null : null; }
  partValue(p, part) { const e = this.part(p, part); return e?.status === "ok" ? e.value : null; }

  wantedParts() {
    const order = this.tab === "checks" ? ["checks", "body", "files"] : this.tab === "files" ? ["files", "body", "checks"] : ["body", "checks", "files"];
    return this.file ? ["diff", ...order] : order;
  }

  pumpDetail(cx) {
    if (this.detailBusy) return;
    const p = this.pr(this.sel);
    if (!p || !this.terminal) return;
    const part = this.wantedParts().find((x) => {
      const e = this.part(p, x);
      return !e || (e.status === "err" && Date.now() - e.at > RETRY_MS && x === this.wantedParts()[0]);
    });
    if (!part) return;
    const key = this.detailKey(p, part);
    this.detailBusy = true;
    this.details.set(key, { status: "loading", at: Date.now() });
    cx.spawn(async (cx) => {
      let entry;
      try {
        const r = await this.run(["detail", p.repo, String(p.number), part]);
        if (r.code === 127) entry = { status: "err", error: `herdr-prs was not found. Install it, or set "cli" in ${MOD}/config.json.` };
        else if (r.code !== 0) entry = { status: "err", error: firstLines(r.stderr) || `herdr-prs detail exited with ${r.code}` };
        else {
          const j = JSON.parse(r.stdout);
          entry = j?.error ? { status: "err", error: String(j.error) } : { status: "ok", value: part === "diff" ? { ...j, files: parseDiff(j.diff) } : j };
        }
      } catch (e) {
        entry = { status: "err", error: `Could not load: ${String(e?.message ?? e)}` };
      }
      entry.at = Date.now();
      // Kept under its own key even if the selection moved on: it is right for that PR and shows only for it.
      this.details.set(key, entry);
      if (this.details.size > 300) for (const k of [...this.details.keys()].slice(0, 100)) this.details.delete(k);
      this.detailBusy = false;
      this.pumpDetail(cx); // the latest selection next
      cx.notify();
    });
  }

  // ---- the list --------------------------------------------------------------------------------------

  // With nothing open in this scope, the done PRs are all there is: show them instead of an empty list
  // (an agent whose PRs are all merged). `autoDone` then hides the "Show done" toggle.
  groups() {
    const opts = { scope: this.scope, filter: this.filter, expanded: this.expanded };
    const g = M.groups(this.data.prs, { ...opts, showDone: this.showDone });
    this.autoDone = !this.showDone && g.live.length === 0 && g.doneCount > 0;
    return this.autoDone ? M.groups(this.data.prs, { ...opts, showDone: true }) : g;
  }

  items() {
    if (!this.data) return [];
    const key = [this.scope, this.filter, this.showDone, [...this.collapsed].join(), [...this.expanded].join()].join("|");
    if (this.memo?.key === key) return this.memo.items;
    const g = this.groups();
    const items = M.listItems(g, { collapsed: this.collapsed });
    this.memo = { key, items, order: M.rowOrder(items), doneCount: g.doneCount };
    return items;
  }
  order() { this.items(); return this.memo?.order ?? []; }
  doneCount() { this.items(); return this.memo?.doneCount ?? 0; }

  select(id, cx, { reveal = true } = {}) {
    if (id !== this.sel) this.file = null;
    this.sel = id;
    if (id == null) return;
    this.pumpDetail(cx);
    if (reveal) {
      const at = this.items().findIndex((it) => it.kind === "row" && it.id === id);
      if (at >= 0) { try { this.scroll.scroll_to_item(at, "center"); } catch {} }
    }
  }

  move(d, cx) { this.select(M.step(this.order(), this.sel, d), cx); }

  fixSelection(cx, opts) {
    const o = this.order();
    if (!o.includes(this.sel)) this.select(o[0] ?? null, cx, opts);
  }

  setScope(s, cx) {
    if (!M.SCOPES.some((x) => x.key === s) || !this.data) return;
    this.scope = s;
    this.saved = s;
    this.scopePending = false; // an explicit choice stays
    this.filter = null;
    this.memo = null;
    this.saveUi();
    this.fixSelection(cx);
  }

  setFilter(key, cx) {
    this.filter = key;
    this.memo = null;
    this.fixSelection(cx);
  }

  toggleDone(cx) {
    this.showDone = !this.showDone;
    this.memo = null;
    this.saveUi();
    if (this.data) this.fixSelection(cx);
  }

  groupOfNumber(n) {
    return this.data?.prs.find((p) => p.number === n)?.stack?.id ? `stack:${this.data.prs.find((p) => p.number === n).stack.id}` : null;
  }

  toggleStack(id, cx) {
    if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id);
    this.memo = null;
    this.fixSelection(cx, { reveal: false });
  }

  openUrl(cx) {
    const p = this.pr(this.sel);
    if (p?.url) cx.open_url(p.url);
  }
  copyUrl(cx) {
    const p = this.pr(this.sel);
    if (!p?.url) return;
    cx.write_to_clipboard(p.url);
    notify({ title: "Copied", body: p.url, level: "success", timeout: 2000 });
  }

  resize(wide) { run("layout.resize", { id: "side", px: wide ? WIDE_PX : NARROW_PX }); }

  close() { run("viewbar.prs"); }

  command(c, cx) {
    let m;
    if (c === "focus") this.wantKeys();
    else if (c === "up") this.move(-1, cx);
    else if (c === "down") this.move(1, cx);
    else if (c === "preview") this.preview = true;
    else if (c === "back") this.back();
    else if (c === "open") this.openUrl(cx);
    else if (c === "copy") this.copyUrl(cx);
    else if (c === "refresh") this.askRefresh();
    else if (c === "close") this.close();
    else if (c === "toggle-done") this.toggleDone(cx);
    else if ((m = /^scope-(\w+)$/.exec(c))) this.setScope(m[1], cx);
    else if (c === "filter-all") this.setFilter(null, cx);
    else if ((m = /^filter-(.+)$/.exec(c))) this.setFilter(m[1], cx);
    else if ((m = /^select-(\d+)$/.exec(c))) { const p = this.data?.prs.find((x) => x.number === Number(m[1])); if (p) this.select(M.idOf(p), cx); }
    else if ((m = /^tab-(overview|checks|files)$/.exec(c))) { this.tab = m[1]; this.file = null; this.pumpDetail(cx); }
    else if ((m = /^file-(\d+)$/.exec(c))) this.openFile(Number(m[1]), cx);
    else if (c === "wide") this.resize(true);
    else if (c === "narrow") this.resize(false);
    else if ((m = /^collapse-(\d+)$/.exec(c))) { const g = this.groupOfNumber(Number(m[1])); if (g) { this.collapsed.add(g); this.memo = null; } }
    else if ((m = /^expand-(\d+)$/.exec(c))) { const g = this.groupOfNumber(Number(m[1])); if (g) { this.collapsed.delete(g); this.expanded.add(g); this.memo = null; } }
  }

  back() {
    if (this.file) this.file = null;
    else if (this.preview) this.preview = false;
  }

  openFile(i, cx) {
    const f = this.partValue(this.pr(this.sel), "files")?.files?.[i];
    if (!f) return;
    this.tab = "files";
    this.file = f.path;
    this.preview = true;
    this.pumpDetail(cx);
  }

  key(e, cx) {
    const k = e.key;
    const mod = e.modifiers ?? {};
    if (mod.platform || mod.control || mod.alt) return;
    const wide = this.w >= WIDE;
    if (k === "down" || k === "j") this.move(1, cx);
    else if (k === "up" || k === "k") this.move(-1, cx);
    else if (k === "enter" || (k === "right" && !wide && !this.preview)) this.preview = true;
    else if (k === "escape" || (k === "left" && (this.file || (!wide && this.preview)))) { if (!this.file && !this.preview) return; this.back(); }
    else if (k === "o") this.openUrl(cx);
    else if (k === "c") this.copyUrl(cx);
    else if (k === "r") this.askRefresh();
    else if (k === "d") this.toggleDone(cx);
    else if (k === "s") { const i = M.SCOPES.findIndex((s) => s.key === this.scope); this.setScope(M.SCOPES[(i + 1) % M.SCOPES.length].key, cx); }
    else if (k === "1" || k === "2" || k === "3") { this.tab = ["overview", "checks", "files"][Number(k) - 1]; this.file = null; this.pumpDetail(cx); }
    else if (k === "w") this.resize(this.w < WIDE);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  clickItem(key, cx) {
    this.handle.focus();
    const it = this.items().find((x) => x.key === key);
    if (it?.kind === "row") {
      this.select(it.id, cx, { reveal: false });
      if (this.w < WIDE) this.preview = true;
    } else if (it?.kind === "head") this.toggleStack(it.group.id, cx);
    else if (it?.kind === "more") { this.expanded.add(it.group.id); this.memo = null; }
    cx.notify();
  }

  // ---- small pieces -----------------------------------------------------------------------------------

  icon(name, size, color) { return svg(ICON(name)).size(size).flex_none().text_color(color); }

  btn(t, id, icon, tip, click, { on = false, label = null, primary = false, kbd = null } = {}) {
    return h_flex().id(id).h(26).px(label ? 9 : 0).when(!label, (el) => el.w(26)).gap(6).flex_none().items_center().justify_center().rounded(7).cursor_pointer()
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.9)))
      .when(!primary && on, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(!primary && !on, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.handle.focus(); click(cx); cx.notify(); })
      .child(svg(ICON(icon)).size(14).flex_none())
      .children(label ? [div().flex_none().text_size(12).font_semibold().child(label)] : [])
      .children(kbd ? [div().flex_none().px(4).h(16).flex().items_center().rounded(4).text_size(10).font_family(this.mono)
        .when(primary, (el) => el.bg("#00000022")).when(!primary, (el) => el.border_1().border_color(t.border)).child(kbd)] : []);
  }

  creatorChip(t, c, { full = true } = {}) {
    const color = c.kind === "worktree" ? t.accent : c.kind === "person" ? t.dim : t.muted;
    return h_flex().flex_none().min_w(0).gap(4).items_center()
      .child(this.icon(CREATOR_ICON[c.kind], 11, color))
      .when(full, (el) => el.child(div().min_w(0).max_w(150).truncate().text_size(10.5).text_color(color).child(c.label)));
  }

  stat(t, add, del) {
    return h_flex().flex_none().gap(4).font_family(this.mono).text_size(10.5)
      .child(div().text_color(add ? t.ansi2 : t.dim).child(`+${add ?? 0}`))
      .child(div().text_color(del ? t.ansi1 : t.dim).child(`−${del ?? 0}`));
  }

  // The status icons of a row: checks, review, conflicts. Merged and closed PRs have none: they are done.
  marks(t, c, p) {
    if (!M.isLive(p)) return h_flex().flex_none();
    const checks = M.checksOf(p);
    const review = M.reviewOf(p);
    return h_flex().flex_none().gap(5).items_center()
      .child(this.icon(CHECK_ICON[checks], 12, c.check[checks]))
      .child(this.icon(REVIEW_ICON[review], 12, c.review[review]))
      .when(M.mergeOf(p).key === "conflicts", (el) => el.child(this.icon("alert", 12, t.ansi1)));
  }

  // ---- the list's items (virtual rows: no handlers; the list's on_item_click takes the clicks) -----

  section(t, it) {
    return h_flex().h(it.h).w_full().px(14).pb(5).items_end().gap(6)
      .child(div().text_size(10.5).font_semibold().text_color(t.dim).child(it.label.toUpperCase()))
      .child(div().text_size(10.5).text_color(t.dim).child(String(it.n)));
  }

  headStats(t, c, g) {
    const s = M.stackStats(g);
    const part = (icon, n, color) => h_flex().flex_none().gap(3).items_center().child(this.icon(icon, 12, color)).child(div().text_size(11).text_color(color).child(String(n)));
    return h_flex().flex_none().gap(8).items_center()
      .when(s.conflicts > 0, (el) => el.child(part("alert", s.conflicts, t.ansi1)))
      .when(s.fail > 0, (el) => el.child(part("check-fail", s.fail, c.check.fail)))
      .when(s.pending > 0, (el) => el.child(part("check-pending", s.pending, c.check.pending)))
      .when(s.fail === 0 && s.pending === 0 && s.pass > 0, (el) => el.child(part("check-pass", s.pass, c.check.pass)))
      .when(s.merged > 0, (el) => el.child(part("pr-merged", s.merged, c.state.merged)));
  }

  head(t, c, it) {
    const g = it.group;
    return h_flex().h(it.h).w_full().px(6).items_center()
      .child(h_flex().h(30).w_full().px(8).gap(7).items_center().rounded(6).bg(t.raised)
        .child(this.icon(it.shut ? "chevron-right" : "chevron-down", 12, t.dim))
        .child(this.icon("layers", 13, t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(g.name))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(plural(g.size, "PR")))
        .child(this.headStats(t, c, g)));
  }

  // The rail: a line through the row and the PR's state icon on it.
  rail(t, c, it, p) {
    const st = M.stateOf(p);
    const top = 15; // the first text line's middle
    return div().w(22).h(it.h).flex_none().relative()
      .child(div().absolute().left(10).top(0).w(2).h(it.last ? top : it.h).bg(c.rail))
      .child(div().absolute().left(2).top(top - 9).size(18).rounded(9).bg(t.background).flex().items_center().justify_center()
        .child(this.icon(STATE_ICON[st], 14, c.state[st])));
  }

  row(t, c, it) {
    const p = it.p;
    const on = it.id === this.sel;
    const st = M.stateOf(p);
    const title = M.splitTitle(p.title);
    const who = M.creatorOf(p);
    const faded = st === "merged" || st === "closed" || !it.inScope;
    const lead = it.single
      ? div().w(22).h(it.h).flex_none().flex().justify_center().pt(8).child(this.icon(STATE_ICON[st], 14, c.state[st]))
      : this.rail(t, c, it, p);
    return h_flex().h(it.h).w_full().px(6).items_start()
      .child(h_flex().h(it.h).w_full().pl(it.single ? 4 : 6 + it.depth * 16).pr(10).items_start().gap(6).rounded(6)
        .when(on, (el) => el.bg(t.selected))
        .child(lead)
        .child(v_flex().flex_1().min_w(0).pt(6).gap(2).when(faded && !on, (el) => el.opacity(0.55))
          .child(h_flex().h(18).gap(6).items_center().min_w(0)
            .child(div().flex_none().font_family(this.mono).text_size(11).text_color(t.muted).child(`#${p.number}`))
            .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).when(st === "closed", (el) => el.line_through()).child(title.text))
            .child(div().flex_none().text_size(10.5).text_color(t.dim).child(M.age(p.mergedAt ?? p.closedAt ?? p.updatedAt))))
          .child(h_flex().h(16).gap(8).items_center().min_w(0)
            .when(!it.single, (el) => el.child(div().flex_none().w(20).text_size(10).font_family(this.mono).text_color(t.dim).child(String(it.pos))))
            .child(this.marks(t, c, p))
            .child(this.stat(t, p.additions, p.deletions))
            .child(div().flex_1())
            .child(this.creatorChip(t, who)))));
  }

  base(t, c, it) {
    const g = it.group;
    return h_flex().h(it.h).w_full().px(6).items_center()
      .child(h_flex().h(it.h).w_full().pl(6).gap(6).items_center()
        .child(div().w(22).h(it.h).flex_none().relative()
          .child(div().absolute().left(10).top(12).w(2).h(it.h - 12).bg(c.rail))
          .child(div().absolute().left(6).top(7).size(10).rounded(5).border_2().border_color(c.rail).bg(t.background)))
        .child(this.icon("branch", 11, t.dim))
        .child(div().min_w(0).truncate().font_family(this.mono).text_size(11).text_color(t.muted).child(g.base))
        .child(div().flex_none().text_size(10.5).text_color(g.foreignBase ? t.ansi3 : t.dim).child(g.foreignBase ? "base · not a PR" : "base")));
  }

  more(t, c, it) {
    return h_flex().h(it.h).w_full().px(6).items_center()
      .child(h_flex().h(it.h).w_full().pl(6).gap(6).items_center()
        .child(div().w(22).h(it.h).flex_none().relative().child(div().absolute().left(10).top(0).w(2).h(it.h).bg(c.rail).opacity(0.5)))
        .child(this.icon("chevron-down", 12, t.dim))
        .child(div().text_size(11.5).text_color(t.muted).child(`${it.n} more in this stack`)));
  }

  item(t, c, it) {
    switch (it.kind) {
      case "section": return this.section(t, it);
      case "head": return this.head(t, c, it);
      case "base": return this.base(t, c, it);
      case "row": return this.row(t, c, it);
      case "more": return this.more(t, c, it);
      default: return div().h(it.h);
    }
  }

  list(t, c) {
    const items = this.items();
    // A vertical virtual list takes its width from a measured row: give the rows a real width.
    const W = Math.max(200, (this.w >= WIDE ? LIST_W : this.w) - 2);
    if (!items.length) return this.emptyList(t);
    return div().id("prs-list-box").flex_1().min_h(0).relative()
      .child(v_virtual_list("prs-list", items.length, items.map((i) => i.h), (i) => items[i].key, (range) => {
        const out = [];
        for (let i = range.start; i < range.end; i++) {
          try { out.push(div().w(W).h(items[i].h).flex_none().child(this.item(t, c, items[i]))); } catch (e) { out.push(div().h(items[i].h).text_size(10).text_color(t.ansi1).child(String(e?.message ?? e))); }
        }
        return out;
      }).track_scroll(this.scroll).absolute().inset_0().on_item_click((key, cx) => this.clickItem(key, cx)))
      .child(Scrollbar.vertical("prs-list").viewport_from_layout().absolute().inset_0());
  }

  // What the list says when it has nothing: no PRs at all, none in this scope, or only done ones.
  emptyList(t) {
    const done = this.doneCount();
    const none = this.data.prs.length === 0;
    const wt = this.scope === "worktree";
    const title = wt ? M.worktreeEmptyText(this.data.worktree) : none ? "No PRs yet for this agent" : "No open PRs";
    const hint = none && !wt ? "They show here once the agent opens one." : done > 0 ? `${plural(done, "done PR")} hidden.` : wt ? "The Agent scope has the agent's other work." : "";
    return v_flex().flex_1().items_center().justify_center().gap(6).p(20)
      .child(this.icon("pr", 22, t.dim))
      .child(div().text_size(12.5).text_color(t.muted).child(title))
      .children(hint ? [div().text_size(11.5).text_color(t.dim).text_center().child(hint)] : []);
  }

  // ---- header, scope, filter, notices, footer -----------------------------------------------------------------

  header(t, wide) {
    const a = this.agent;
    const label = a ? a.title || a.tab_name || "" : "";
    return h_flex().h(40).flex_none().pl(12).pr(6).gap(8).items_center().border_b(1).border_color(t.border)
      .child(this.icon("pr", 15, t.muted))
      .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child("Pull requests"))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(label))
      .children(this.terminal ? [this.btn(t, "prs-refresh", "refresh", this.refreshing ? "Refreshing…" : "Refresh now (r)", () => this.askRefresh(), { on: this.refreshing })] : [])
      .child(this.btn(t, "prs-wide", wide ? "minimize" : "maximize", wide ? "Narrow (w)" : "Wide: list and preview side by side (w)", () => this.resize(!wide)))
      .child(this.btn(t, "prs-close", "x", "Close", () => this.close()));
  }

  seg(t, id, icon, label, on, tip, click, extra = null) {
    return h_flex().id(`seg-${id}`).h(24).px(label ? 8 : 6).gap(5).items_center().justify_center().rounded(6).cursor_pointer()
      .when(Boolean(label), (el) => el.flex_1().min_w(0))
      .border_1().border_color(on ? t.border : "#00000000")
      .when(on, (el) => el.bg(t.background).text_color(t.foreground))
      .when(!on, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
      .tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.handle.focus(); click(cx); cx.notify(); })
      .child(svg(ICON(icon)).size(13).flex_none())
      .children(label ? [div().min_w(0).truncate().text_size(12).child(label)] : [])
      .children(extra ? [extra] : []);
  }

  scopes(t) {
    const n = M.scopeCounts(this.data.prs);
    return h_flex().flex_none().px(10).pt(10).pb(8)
      .child(h_flex().flex_1().h(30).p(2).gap(2).items_center().rounded(8).bg(t.raised)
        .children(M.SCOPES.map((s) => this.seg(t, `scope-${s.key}`, s.icon, s.label, this.scope === s.key, `${s.tip} (s)`, (cx) => this.setScope(s.key, cx),
          div().flex_none().text_size(11).text_color(this.scope === s.key ? t.muted : t.dim).child(String(n[s.key]))))));
  }

  // Who made what, in the Agent scope: chips that filter the list.
  filters(t) {
    if (this.scope !== "agent") return null;
    const list = M.creators(this.data.prs, "agent", { showDone: this.showDone });
    if (list.length < 2) return null;
    const chip = (key, icon, label, n, on, tip) => h_flex().id(`filter-${key}`).h(22).px(8).gap(5).flex_none().items_center().rounded(11).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.border).when(on, (el) => el.bg(t.accent + "1f"))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .tooltip(tip)
      .on_click((_e, cx) => { this.handle.focus(); this.setFilter(on || key === "all" ? null : key, cx); cx.notify(); })
      .children(icon ? [this.icon(icon, 11, on ? t.accent : t.muted)] : [])
      .child(div().text_size(11).text_color(on ? t.foreground : t.muted).child(label))
      .children(n != null ? [div().text_size(10.5).text_color(t.dim).child(String(n))] : []);
    // overflow_x_scrollbar() wraps the row in a scroll area that would take the column's free space:
    // a fixed-height box keeps it to one line.
    return div().h(30).flex_none().px(10).pb(8)
      .child(div().id("prs-filters").size_full().overflow_x_scrollbar()
        .child(h_flex().gap(5).items_center()
          .child(chip("all", null, "Everyone", null, this.filter == null, "Every PR of this agent's work"))
          .children(list.map((x) => chip(x.key, CREATOR_ICON[x.kind], x.kind === "agent" ? "agent" : x.label, x.n, this.filter === x.key, x.tip ?? x.label)))));
  }

  // The first error of the file (with how many more), a failed refresh, and "showing last known data".
  notices(t) {
    const d = this.data;
    const e = M.errorLine(d.errors);
    const bars = [];
    const bar = (id, color, icon, text, tip) => h_flex().id(id).flex_none().mx(10).mb(8).px(9).py(6).gap(7).items_start().rounded(6).bg(t.raised)
      .tooltip(tip ?? text)
      .child(div().mt(1).child(this.icon(icon, 12, color)))
      .child(div().flex_1().min_w(0).text_size(11).line_height("15px").text_color(t.muted).child(text));
    if (this.refreshError) bars.push(bar("prs-note-refresh", t.ansi1, "alert", this.refreshError));
    if (e && !this.noPrsBecauseOfError()) bars.push(bar("prs-note-error", e.kind === "gh" || e.kind === "internal" ? t.ansi1 : t.ansi3, "alert", e.more ? `${e.text} (+${e.more} more)` : e.text));
    if (d.stale) bars.push(bar("prs-note-stale", t.dim, "history", "Showing last known data.", "GitHub could not be reached; these PRs come from the last good refresh."));
    return bars;
  }

  // gh not signed in, offline, ...: with nothing to show, the error is the whole answer.
  noPrsBecauseOfError() {
    const e = this.data?.errors?.[0];
    return Boolean(e) && this.data.prs.length === 0 && (e.kind === "gh" || e.kind === "internal");
  }

  footer(t, wide) {
    const hint = (k, label) => h_flex().flex_none().gap(4).items_center()
      .child(div().px(4).h(15).flex().items_center().rounded(3).border_1().border_color(t.border).font_family(this.mono).text_size(9.5).text_color(t.muted).child(k))
      .child(div().text_size(10.5).text_color(t.dim).child(label));
    const n = this.doneCount();
    const status = this.refreshing ? "Refreshing…" : this.data ? M.updatedLabel(this.data.at) : "";
    return h_flex().h(28).flex_none().px(8).gap(8).items_center().border_t(1).border_color(t.border).overflow_hidden()
      .children(this.data && !this.autoDone && (n > 0 || this.showDone) ? [h_flex().id("prs-done").h(20).px(6).gap(5).flex_none().items_center().rounded(5).cursor_pointer()
        .text_color(this.showDone ? t.foreground : t.muted).when(this.showDone, (el) => el.bg(t.selected)).when(!this.showDone, (el) => el.hover((s) => s.bg(t.hover)))
        .tooltip(this.showDone ? "Hide merged and closed PRs (d)" : "Show merged and closed PRs (d)")
        .on_click((_e, cx) => { this.handle.focus(); this.toggleDone(cx); cx.notify(); })
        .child(svg(ICON("eye")).size(12).flex_none())
        .child(div().text_size(11).child(`${this.showDone ? "Hide" : "Show"} done (${n})`))] : [])
      .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).text_right().child(status))
      .children(wide ? [hint("↑↓", "move"), hint("1-3", "tabs"), hint("o", "open"), hint("r", "refresh")] : [hint("↵", "preview"), hint("r", "refresh")]);
  }

  // ---- preview -------------------------------------------------------------------------------------------

  // One part still loading or failed: a short line in the body's place (null when it is there).
  partNotice(t, p, part, what) {
    const e = this.part(p, part);
    if (e?.status === "ok") return null;
    if (e?.status === "err") {
      return v_flex().flex_1().items_center().justify_center().gap(8).px(20)
        .child(this.icon("alert", 18, t.ansi1))
        .child(div().text_size(12).text_color(t.ansi1).text_center().child(`Could not load ${what}.`))
        .child(div().max_w(420).text_size(11).text_color(t.dim).text_center().child(e.error))
        .child(this.btn(t, "prs-retry", "refresh", "Try again", (cx) => { this.details.delete(this.detailKey(p, part)); this.pumpDetail(cx); }, { label: "Try again" }));
    }
    return v_flex().flex_1().items_center().justify_center().child(div().text_size(12).text_color(t.dim).child("Loading…"));
  }

  preview_(t, c, wide) {
    const p = this.pr(this.sel);
    if (!p) return v_flex().flex_1().items_center().justify_center().child(div().text_size(12).text_color(t.dim).child("Pick a PR"));
    const st = M.stateOf(p);
    const sc = c.state[st];
    const title = M.splitTitle(p.title);
    const who = M.creatorOf(p);
    const top = h_flex().h(40).flex_none().px(wide ? 14 : 8).gap(8).items_center().border_b(1).border_color(t.border)
      .when(!wide, (el) => el.child(h_flex().id("prs-back").h(26).pl(4).pr(8).gap(2).flex_none().items_center().rounded(7).cursor_pointer()
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Back to the list (Esc)")
        .on_click((_e, cx) => { this.handle.focus(); this.preview = false; this.file = null; cx.notify(); })
        .child(svg(ICON("chevron-left")).size(14)).child(div().text_size(12).child("PRs"))))
      .child(h_flex().flex_none().h(22).px(8).gap(5).items_center().rounded(11).bg(sc + "22")
        .child(this.icon(STATE_ICON[st], 13, sc)).child(div().text_size(11.5).font_semibold().text_color(sc).child(STATE_LABEL[st])))
      .child(div().flex_none().font_family(this.mono).text_size(12).text_color(t.muted).child(`#${p.number}`))
      .child(div().flex_1())
      .child(this.btn(t, "prs-copy", "copy", "Copy the URL (c)", (cx) => this.copyUrl(cx)))
      .child(this.btn(t, "prs-open", "external", "Open in the browser (o)", (cx) => this.openUrl(cx), { label: "Open", primary: true, kbd: "o" }));

    const lineOf = (icon, ...kids) => h_flex().gap(6).items_center().min_w(0).child(this.icon(icon, 12, t.dim)).children(kids);
    const down = p.parent != null ? this.pr(`${p.repo}#${p.parent}`) : null;
    const head = v_flex().flex_none().px(14).pt(12).pb(10).gap(7)
      .child(div().text_size(15).font_semibold().line_height("21px").text_color(t.foreground).child(title.text))
      .child(h_flex().gap(6).items_center().min_w(0).text_size(11).text_color(t.dim)
        .when(Boolean(title.area), (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(4).bg(t.raised).text_color(t.muted).child(title.area)))
        .when(Boolean(title.ticket), (el) => el.child(div().flex_none().font_family(this.mono).child(title.ticket)))
        .child(div().flex_1())
        .child(this.stat(t, p.additions, p.deletions))
        .child(div().flex_none().child(plural(p.changedFiles ?? 0, "file"))))
      .child(lineOf("branch",
        div().min_w(0).flex_shrink(1).truncate().font_family(this.mono).text_size(11).text_color(t.muted).child(p.head),
        div().flex_none().text_size(11).text_color(t.dim).child("→"),
        down
          ? h_flex().id("prs-base-pr").flex_none().h(18).px(6).gap(4).items_center().rounded(4).bg(t.raised).cursor_pointer().hover((s) => s.bg(t.hover))
            .tooltip(`Sits on #${down.number}: ${down.head}`)
            .on_click((_e, cx) => { this.handle.focus(); this.select(M.idOf(down), cx); cx.notify(); })
            .child(this.icon(STATE_ICON[M.stateOf(down)], 11, c.state[M.stateOf(down)]))
            .child(div().font_family(this.mono).text_size(11).text_color(t.foreground).child(`#${down.number}`))
          : div().flex_none().max_w(160).truncate().font_family(this.mono).text_size(11).text_color(t.muted).child(p.base)))
      .child(h_flex().gap(6).items_center().min_w(0).text_size(11).text_color(t.dim)
        .child(this.icon("user", 12, t.dim))
        .child(div().flex_none().text_color(t.muted).child(p.author ?? ""))
        .child(div().flex_1().min_w(0).truncate().child(st === "merged" ? `· merged ${M.age(p.mergedAt)} ago` : st === "closed" ? `· closed ${M.age(p.closedAt)} ago` : `· opened ${M.age(p.createdAt)} ago · updated ${M.age(p.updatedAt)}`))
        .child(this.creatorChip(t, who)));

    // A file's diff takes the whole preview: the title, the stack and the tiles step aside.
    const diff = this.tab === "files" && Boolean(this.file) && this.partValue(p, "files") != null;
    return v_flex().flex_1().min_w(0).min_h(0)
      .child(top)
      .when(!diff, (el) => el.child(head)
        .children([this.stackStrip(t, c, p)].filter(Boolean))
        .child(this.tiles(t, c, p))
        .child(this.tabs(t, p)))
      .child(this.tabBody(t, c, p));
  }

  // Where the PR is in its stack: the chain as dots, bottom on the left; click one to go there.
  stackStrip(t, c, p) {
    const chain = M.stackOf(this.data.prs.filter((x) => this.showDone || x.state !== "closed" || x === p), p);
    if (chain.length < 2) return null;
    const pos = chain.find((x) => x.p === p)?.pos ?? 1;
    const name = M.stackName(chain.map((x) => x.p));
    const dots = chain.flatMap((x, i) => {
      const q = x.p;
      const on = q === p;
      const col = q.state === "merged" ? c.state.merged : q.state === "closed" ? c.state.closed : c.check[M.checksOf(q)];
      const dot = h_flex().id(`dot-${q.number}`).size(16).flex_none().items_center().justify_center().rounded(8).cursor_pointer()
        .when(on, (el) => el.border_2().border_color(t.foreground))
        .tooltip(`${x.pos}. #${q.number} ${M.splitTitle(q.title).text}`)
        .on_click((_e, cx) => { this.handle.focus(); this.select(M.idOf(q), cx); cx.notify(); })
        .child(div().size(on ? 8 : 9).rounded(5).bg(col));
      return i ? [div().w(6).h(2).flex_none().bg(c.rail), dot] : [dot];
    });
    return h_flex().flex_none().mx(14).mb(10).px(10).py(7).gap(10).items_center().rounded(8).bg(t.raised)
      .child(this.icon("layers", 13, t.muted))
      .child(v_flex().flex_none().gap(0)
        .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child(`${pos} of ${chain.length}`))
        .child(div().max_w(110).truncate().text_size(10.5).text_color(t.dim).child(name)))
      .child(div().flex_1().min_w(0).h(20)
        .child(div().id("prs-dots").size_full().overflow_x_scrollbar()
          .child(h_flex().items_center().py(1).children(dots))));
  }

  // Checks, review, merge: three tiles. The icon and word follow GitHub's state; the number comes from the check list.
  tiles(t, c, p) {
    const n = this.partValue(p, "checks")?.counts ?? null;
    const checks = M.checksOf(p);
    const checkText = !n ? CHECK_WORD[checks]
      : checks === "fail" ? `${n.fail || "Some"} failed` : checks === "pending" ? `${n.pending || "Some"} running` : checks === "pass" ? `${n.pass} passed` : "None";
    const review = M.reviewOf(p);
    const by = (this.partValue(p, "body")?.reviewers ?? []).filter((r) => r.state === "APPROVED").map((r) => r.login).filter(Boolean);
    const merge = M.mergeOf(p);
    const mergeColor = { conflicts: t.ansi1, blocked: t.ansi3, behind: t.ansi3, unstable: t.ansi3, clean: t.ansi2, merged: c.state.merged, closed: c.state.closed }[merge.key] ?? t.muted;
    const mergeIcon = merge.key === "conflicts" ? "alert" : merge.key === "merged" ? "pr-merged" : merge.key === "closed" ? "pr-closed" : merge.key === "clean" ? "check-pass" : merge.key === "draft" ? "pr-draft" : "check-none";
    const tile = (id, icon, color, label, value, tip, click) => h_flex().id(id).flex_1().min_w(0).h(44).px(9).gap(8).items_center().rounded(8).border_1().border_color(t.border)
      .when(Boolean(click), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.handle.focus(); click(cx); cx.notify(); }))
      .tooltip(tip)
      .child(this.icon(icon, 16, color))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(10.5).text_color(t.dim).child(label))
        .child(div().truncate().text_size(12).font_semibold().text_color(color === t.dim ? t.muted : color).child(value)));
    return h_flex().flex_none().px(14).pb(10).gap(6)
      .child(tile("tile-checks", CHECK_ICON[checks], c.check[checks], "Checks", checkText, n ? `${n.pass} passed · ${n.fail} failed · ${n.pending} running · ${n.skip} skipped` : CHECK_WORD[checks], (cx) => { this.tab = "checks"; this.file = null; this.pumpDetail(cx); }))
      .child(tile("tile-review", REVIEW_ICON[review], c.review[review], "Review", REVIEW_WORD[review], by.length ? `Approved by ${by.join(", ")}` : REVIEW_WORD[review], null))
      .child(tile("tile-merge", mergeIcon, mergeColor, "Merge", merge.short, merge.label, null));
  }

  tabs(t, p) {
    const counts = this.partValue(p, "checks")?.counts;
    const checks = counts ? counts.pass + counts.fail + counts.pending : null;
    const files = this.partValue(p, "files")?.total ?? p.changedFiles ?? null;
    const reviews = this.partValue(p, "body")?.reviewers?.length ?? 0;
    const tab = (key, icon, label, n, k) => {
      const on = this.tab === key;
      return h_flex().id(`tab-${key}`).h(34).px(8).gap(6).flex_none().items_center().cursor_pointer().relative()
        .text_color(on ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
        .tooltip(`${label} (${k})`)
        .on_click((_e, cx) => { this.handle.focus(); this.tab = key; this.file = null; this.pumpDetail(cx); cx.notify(); })
        .child(svg(ICON(icon)).size(13).flex_none())
        .child(div().text_size(12).when(on, (el) => el.font_semibold()).child(label))
        .children(n != null ? [div().px(5).h(16).flex().items_center().rounded(8).bg(t.raised).text_size(10).text_color(t.muted).child(String(n))] : [])
        .when(on, (el) => el.child(div().absolute().left(6).right(6).bottom(0).h(2).rounded(1).bg(t.accent)));
    };
    return h_flex().flex_none().px(8).gap(2).items_center().border_b(1).border_color(t.border)
      .child(tab("overview", "text", "Overview", reviews || null, "1"))
      .child(tab("checks", "list-checks", "Checks", checks, "2"))
      .child(tab("files", "file", "Files", files, "3"));
  }

  tabBody(t, c, p) {
    if (this.tab === "checks") return this.checksBody(t, c, p);
    if (this.tab === "files") return this.file ? this.diffBody(t, c, p) : this.filesBody(t, c, p);
    return this.overviewBody(t, c, p);
  }

  overviewBody(t, c, p) {
    const note = this.partNotice(t, p, "body", "the description");
    if (note) return note;
    const d = this.partValue(p, "body");
    const body = M.cleanBody(d.body);
    const reviews = (d.reviewers ?? []).filter((r) => r.login);
    const requested = d.requested ?? [];
    const avatar = (login) => div().size(20).flex_none().rounded(10).bg(t.raised).flex().items_center().justify_center()
      .text_size(10).font_semibold().text_color(t.muted).child((login[0] ?? "?").toUpperCase());
    const rs = { APPROVED: ["review-approved", c.review.approved, "approved"], CHANGES_REQUESTED: ["review-changes", c.review.changes, "asked for changes"], COMMENTED: ["message", t.muted, "commented"], DISMISSED: ["check-skip", t.dim, "dismissed"] };
    return div().id(`prs-overview-${M.idOf(p)}`).flex_1().min_h(0).overflow_y_scrollbar()
      .child(v_flex().px(16).py(12).gap(14)
        .child(body ? TextView.markdown(`prs-md-${M.idOf(p)}`, body).selectable(true).text_size(13).on_link_click((url, cx) => cx.open_url(url))
          : div().text_size(12.5).italic().text_color(t.dim).child("No description."))
        .when(reviews.length + requested.length > 0, (el) => el.child(v_flex().gap(6).pt(10).border_t(1).border_color(t.border)
          .child(div().text_size(10.5).font_semibold().text_color(t.dim).child("REVIEWS"))
          .children(reviews.map((r) => {
            const [icon, color, verb] = rs[r.state] ?? ["message", t.muted, r.state?.toLowerCase() ?? ""];
            return h_flex().h(26).gap(8).items_center()
              .child(avatar(r.login))
              .child(div().flex_none().text_size(12).text_color(t.foreground).child(r.login))
              .child(this.icon(icon, 12, color))
              .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(verb));
          }))
          .children(requested.length ? [h_flex().h(24).gap(8).items_center()
            .child(this.icon("review-required", 13, t.muted))
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(`Review requested from ${requested.join(", ")}`))] : [])
          .child(div().h(4)))));
  }

  checksBody(t, c, p) {
    const note = this.partNotice(t, p, "checks", "the checks");
    if (note) return note;
    const d = this.partValue(p, "checks");
    const list = d.checks ?? [];
    const n = d.counts ?? { pass: 0, fail: 0, pending: 0, skip: 0 };
    if (!list.length) return v_flex().flex_1().items_center().justify_center().child(div().text_size(12).text_color(t.dim).child(n.skip ? `No checks ran (${n.skip} skipped).` : "No checks ran."));
    const rows = [];
    const label = { fail: "Failed", pending: "Running", pass: "Passed" };
    for (const k of ["fail", "pending", "pass"]) {
      const of = list.filter((x) => x.result === k);
      if (!of.length) continue;
      rows.push({ key: `h-${k}`, head: k, n: of.length, h: 30 });
      for (const [i, x] of of.entries()) rows.push({ key: `c-${k}-${i}`, check: x, h: 28 });
    }
    if (n.skip) rows.push({ key: "h-skip", skipped: n.skip, h: 30 });
    const id = `prs-checks-${M.idOf(p)}`;
    return div().flex_1().min_h(0).relative()
      .child(v_virtual_list(id, rows.length, rows.map((r) => r.h), (i) => rows[i].key, (range) => {
        const out = [];
        for (let i = range.start; i < range.end; i++) {
          const r = rows[i];
          if (r.head) {
            out.push(h_flex().h(r.h).w_full().px(16).pt(8).gap(6).items_center()
              .child(this.icon(CHECK_ICON[r.head], 12, c.check[r.head]))
              .child(div().text_size(10.5).font_semibold().text_color(t.dim).child(`${label[r.head].toUpperCase()}  ${r.n}`)));
            continue;
          }
          if (r.skipped) {
            out.push(h_flex().h(r.h).w_full().px(16).pt(8).gap(6).items_center()
              .child(this.icon("check-skip", 12, t.dim))
              .child(div().text_size(10.5).font_semibold().text_color(t.dim).child(`SKIPPED  ${r.skipped}`)));
            continue;
          }
          const x = r.check;
          out.push(h_flex().h(r.h).w_full().px(16).gap(8).items_center()
            .child(this.icon(CHECK_ICON[x.result], 13, c.check[x.result]))
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(x.name))
            .child(div().flex_none().max_w(130).truncate().text_size(11).text_color(t.dim).child(x.workflow ?? ""))
            .child(div().flex_none().w(34).text_right().font_family(this.mono).text_size(10.5).text_color(t.dim).child(fmtSecs(x.seconds))));
        }
        return out;
      }).size_full().on_item_click((key, cx) => {
        const r = rows.find((x) => x.key === key);
        if (r?.check?.url) cx.open_url(r.check.url);
      }))
      .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0());
  }

  filesBody(t, c, p) {
    const note = this.partNotice(t, p, "files", "the files");
    if (note) return note;
    const d = this.partValue(p, "files");
    const files = d.files ?? [];
    if (!files.length) return v_flex().flex_1().items_center().justify_center().child(div().text_size(12).text_color(t.dim).child("No files."));
    const id = `prs-files-${M.idOf(p)}`;
    // Five blocks, as on GitHub: green for the added share, red for the deleted one.
    const bar = (f) => {
      const total = f.additions + f.deletions;
      const add = total ? Math.round((5 * f.additions) / total) : 0;
      const del = total ? 5 - add : 0;
      return h_flex().flex_none().gap(1).children([0, 1, 2, 3, 4].map((i) => div().w(5).h(8).rounded(1)
        .bg(i < add ? t.ansi2 : i < add + del ? t.ansi1 : t.raised)));
    };
    return v_flex().flex_1().min_h(0)
      .when(d.truncated, (el) => el.child(h_flex().flex_none().mx(12).mt(10).px(10).py(6).gap(6).items_center().rounded(6).bg(t.raised)
        .child(this.icon("file", 12, t.dim)).child(div().text_size(11).text_color(t.dim).child(`The first ${files.length} files only (GitHub lists at most 3000).`))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list(id, files.length, 30, (i) => `f-${i}`, (range) => {
          const out = [];
          for (let i = range.start; i < range.end; i++) {
            const f = files[i];
            const { dir, name } = M.splitPath(f.path);
            const icon = f.status === "added" ? "file-plus" : f.status === "removed" ? "file-minus" : "file";
            const color = f.status === "added" ? t.ansi2 : f.status === "removed" ? t.ansi1 : t.muted;
            out.push(h_flex().h(30).w_full().px(14).gap(8).items_center()
              .child(this.icon(icon, 13, color))
              .child(h_flex().flex_1().min_w(0).items_center()
                .child(div().flex_shrink(1).min_w(0).truncate().text_size(11.5).text_color(t.dim).child(dir))
                .child(div().flex_none().max_w(220).truncate().text_size(12).text_color(t.foreground).when(f.status === "removed", (el) => el.line_through()).child(name)))
              .child(this.stat(t, f.additions, f.deletions))
              .child(bar(f))
              .child(this.icon("chevron-right", 12, t.dim)));
          }
          return out;
        }).size_full().on_item_click((key, cx) => {
          this.handle.focus();
          const f = files[Number(key.slice(2))];
          if (f) { this.file = f.path; this.pumpDetail(cx); cx.notify(); }
        }))
        .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0()));
  }

  diffBody(t, c, p) {
    const meta = (this.partValue(p, "files")?.files ?? []).find((x) => x.path === this.file);
    const { dir, name } = M.splitPath(this.file);
    const head = h_flex().h(34).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border).bg(t.raised)
      .child(h_flex().id("prs-diff-back").h(24).pl(2).pr(6).gap(2).flex_none().items_center().rounded(6).cursor_pointer()
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Back to the files (Esc)")
        .on_click((_e, cx) => { this.handle.focus(); this.file = null; cx.notify(); })
        .child(svg(ICON("chevron-left")).size(13)).child(div().text_size(11.5).child("Files")))
      .child(div().flex_shrink(1).min_w(0).truncate().text_size(11.5).text_color(t.dim).child(dir))
      .child(div().flex_none().max_w(200).truncate().text_size(12).font_semibold().text_color(t.foreground).child(name))
      .child(div().flex_1())
      .children(meta ? [this.stat(t, meta.additions, meta.deletions)] : []);
    const say = (text, color = t.dim) => v_flex().flex_1().child(head).child(div().p(16).text_size(12).text_color(color).child(text));
    const e = this.part(p, "diff");
    if (!e || e.status === "loading") return say("Loading the diff…");
    if (e.status === "err") return say(`Could not load the diff: ${e.error}`, t.ansi1);
    const f = e.value.files.find((x) => x.path === this.file);
    if (!f) return say(e.value.truncated ? "This file is past the part of the diff that was loaded (the first 900 KB)." : "This file is not in the diff.");
    if (f.binary || !f.lines.length) return say(f.binary ? "A binary file." : "No lines changed (a rename or a mode change).");
    const lines = f.lines;
    const wn = Math.max(2, String(Math.max(...lines.map((l) => Math.max(l.old ?? 0, l.new ?? 0)))).length);
    const id = `prs-diff-${M.idOf(p)}-${this.file}`;
    const ROW = 19;
    return v_flex().flex_1().min_h(0)
      .child(head)
      .child(div().flex_1().min_h(0).relative().font_family(this.mono).text_size(11.5)
        .child(v_virtual_list(id, lines.length, ROW, (i) => String(i), (range) => {
          const out = [];
          for (let i = range.start; i < range.end; i++) {
            const l = lines[i];
            if (l.kind === "hunk") {
              out.push(h_flex().h(ROW).w_full().px(8).items_center().bg(t.accent + "14")
                .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(`@@ ${l.context || ""}`.trim())));
              continue;
            }
            const add = l.kind === "add", del = l.kind === "del";
            out.push(h_flex().h(ROW).w_full().items_center().when(add, (el) => el.bg(t.ansi2 + "1c")).when(del, (el) => el.bg(t.ansi1 + "1c"))
              .child(div().w(wn * 7.5 + 10).flex_none().pr(5).text_right().text_size(10.5).text_color(t.dim).child(l.old == null ? "" : String(l.old)))
              .child(div().w(wn * 7.5 + 10).flex_none().pr(5).text_right().text_size(10.5).text_color(t.dim).child(l.new == null ? "" : String(l.new)))
              .child(div().w(14).flex_none().text_color(add ? t.ansi2 : del ? t.ansi1 : t.dim).child(add ? "+" : del ? "−" : ""))
              .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(untab(l.text) || " ")));
          }
          return out;
        }).size_full())
        .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0()));
  }

  // ---- the whole view -------------------------------------------------------------------------------------

  // A message that fills the view: loading, not an agent, a failure.
  say(t, icon, title, text, color = t.muted) {
    return v_flex().flex_1().items_center().justify_center().gap(8).p(24)
      .child(this.icon(icon, 22, color === t.muted ? t.dim : color))
      .child(div().text_size(12.5).text_color(color).text_center().child(title))
      .children(text ? [div().max_w(380).text_size(11.5).line_height("16px").text_color(t.dim).text_center().child(text)] : []);
  }

  render(_cx) {
    const now = Date.now();
    if (now - this.lastRender > SHOWN_FOR) this.opened = true; // it was not drawn for a while: the view just opened
    this.lastRender = now;
    const t = theme();
    const c = palette(t);
    this.mono = settings().font_family ?? "JetBrains Mono";
    const wide = this.w >= WIDE;
    const root = v_flex().id("prs").size_full().min_h(0).bg(t.background).rounded(10).border_1().border_color(t.border).overflow_hidden()
      .text_color(t.foreground).track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.handle.focus())
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.w) > 1) { this.w = size.width; cx.notify(); } });
    if (!this.terminal) return root.child(this.header(t, wide)).child(this.say(t, "bot", "Not an agent", "Focus a tab with an agent to see its pull requests."));
    if (!this.data) {
      const msg = this.dataError ?? this.refreshError;
      if (msg) return root.child(this.header(t, wide)).child(this.say(t, "alert", "No PR data", msg, t.ansi1));
      return root.child(this.header(t, wide)).child(this.say(t, "pr", this.loaded ? "Looking for pull requests…" : "Loading…", this.loaded ? "The first look can take a few seconds." : ""));
    }
    if (this.noPrsBecauseOfError()) {
      const e = M.errorLine(this.data.errors);
      return root.child(this.header(t, wide)).child(this.say(t, "alert", "Could not get the pull requests", e.text, t.ansi1)).child(this.footer(t, wide));
    }
    const listCol = v_flex().min_h(0).when(wide, (el) => el.w(LIST_W).flex_none().border_r(1).border_color(t.border)).when(!wide, (el) => el.flex_1())
      .child(this.scopes(t))
      .children([this.filters(t)].filter(Boolean))
      .children(this.notices(t))
      .child(this.list(t, c));
    const body = wide
      ? h_flex().flex_1().min_h(0).items_stretch().child(listCol.h_full()).child(this.preview_(t, c, true).h_full())
      : this.preview && this.sel != null ? v_flex().flex_1().min_h(0).child(this.preview_(t, c, false)) : listCol;
    return root.child(this.header(t, wide)).child(body).child(this.footer(t, wide));
  }
}
