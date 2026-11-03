// Worktrees, per repo: find, open or create one. Opened with `mod.open:repo-worktree`
// (cmd-shift-n in keys.json), or as an overlay with props { space?, folder? }.
//
// It finds the repo of the focused terminal and looks it up in <appHome>/repo-worktree.json.
// The list shows the repo's checkouts (the typed text filters it): Enter on one goes to its
// space, or opens a new space there with the repo's agent. Text that names no checkout gives a
// "Create" row, which runs the repo's strategy (strategies/; a repo with no entry: "git").
// Tab marks checkouts; Enter then removes them in the background (remover.js). A space on
// another machine, or a folder outside git, gets Herdr's own New worktree dialog.
//
// Scriptable, for tests: `herdr-app do repo-worktree.set:name=foo`, `.down`, `.up`, `.submit`.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, spaces, panes, focused, exec, home, appHome, readTextFile, nextCommand } from "herdr";
import { CONFIG_FILE, parseConfig, entryFor } from "./config.js";
import { getStrategy } from "./strategies/index.js";
import { SNAPSHOT, parseSnapshot, filterWorktrees, exactMatch, spaceFor, ago } from "./worktrees.js";
import { removePlan } from "./remover.js";

const ICON = (name) => `mods/repo-worktree/${name}.svg`;
const tilde = (path, h) => (path && h && path.startsWith(h) ? `~${path.slice(h.length)}` : path ?? "");
const ROW = 40;
const MAX_ROWS = 8;

// Where a space is now: its first terminal's live folder, else where it was made.
// spaces() and panes() copy all of Herdr's state: read them once, pass `all` along.
function place(s, all = panes()) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

async function git(cwd, args) {
  const r = await exec("git", args, { cwd });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

// Speed: mods share one runtime, and every exec waits its turn there. So the popup
//   - shows what it read last time for this folder at once, then refreshes it (CACHE),
//   - reads git in one process (SNAPSHOT), with the config file read beside it,
//   - asks before a removal at once; the slow checks (git status) fill the rows in after.
// globalThis: Herdr loads the module again for every open, so module state does not last.
const CACHE = (globalThis.__repoWorktreeCache ??= new Map()); // folder → { snap, config }

// Per checkout, in one process: anything uncommitted, then any commit on no remote.
const CHECKS = 'cd "$1" || exit 1; git --no-optional-locks status --porcelain | head -c1; printf \'\\036\'; git rev-list -n1 HEAD --not --remotes';

export default class RepoWorktree extends View {
  init(_props, cx) {
    const p = props() ?? {};
    const f = focused();
    this.spaceId = p.space ?? f?.space ?? null;
    this.space = spaces().find((s) => s.id === this.spaceId) ?? null;
    this.folder = p.folder || f?.cwd || place(this.space) || null;
    this.home = home();
    this.state = "loading"; // loading | form | invalid
    this.errors = [];
    this.error = "";
    this.busy = false;
    this.inputs = [];
    this.focusedInput = -1;
    this.edited = {};
    this.list = [];
    this.at = 0; // the chosen row
    this.marked = new Set(); // paths of checkouts marked for removal
    this.confirm = null; // while asking: [{ c, dirty, unpushed, open }]
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      try { await this.load(cx); } catch (error) { this.state = "invalid"; this.errors = [String(error)]; }
      cx.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        this.command(String(await nextCommand()), cx);
        cx.notify();
      }
    });
  }

  async load(cx) {
    // Another machine, or no folder: Herdr's dialog handles both.
    if (this.space?.machine || !this.folder) return this.delegate();
    const hit = CACHE.get(this.folder);
    if (hit) this.apply(hit, cx);
    const [r, config] = await Promise.all([
      exec("/bin/sh", ["-c", SNAPSHOT, "sh", this.folder], { cwd: this.folder }),
      readTextFile(`${appHome()}/${CONFIG_FILE}`),
    ]);
    const snap = r.code === 0 ? parseSnapshot(r.stdout) : null;
    if (!snap) { CACHE.delete(this.folder); return this.delegate(); }
    CACHE.set(this.folder, { snap, config });
    this.apply({ snap, config }, cx);
  }

  // Show a snapshot: the first one builds the form; later ones only refresh the list.
  apply({ snap, config }, cx) {
    const { repo, list } = snap;
    this.list = list;
    for (const path of this.marked) if (!list.some((c) => c.path === path)) this.marked.delete(path);
    if (this.state === "form" && this.repo?.main === repo.main) return cx.notify();
    const entry = entryFor(parseConfig(config, this.home), repo.main);
    this.repo = repo;
    this.ctx = { "repo.main": repo.main, "repo.parent": repo.parent, "repo.name": repo.name, "repo.top": repo.top, home: this.home };
    // A broken entry (or file) says so, instead of quietly falling back to git.
    if (entry.errors) { this.state = "invalid"; this.errors = entry.errors.map((e) => (entry.key ? `${entry.key}: ${e}` : e)); return; }
    this.entry = entry;
    this.strategy = getStrategy(entry.strategy);
    const fields = this.strategy.fields(entry.options);
    if (!fields) return this.delegate();
    this.fields = fields;
    this.values = this.strategy.defaults(entry.options, Object.fromEntries(fields.map((f) => [f.name, ""])), {}, this.ctx);
    this.inputs = fields.map((field, i) => {
      const input = InputState.new({ value: this.values[field.name] ?? "", placeholder: i === 0 ? "find or create a worktree" : field.placeholder ?? (field.label ?? field.name).toLowerCase() });
      input.on("change", (_e, cx) => this.changed(field, input, cx));
      input.on("submit", (_e, cx) => this.activate(cx));
      input.on("focus", (_e, cx) => { this.focusedInput = i; cx.notify(); });
      input.on("blur", (_e, cx) => { if (this.focusedInput === i) this.focusedInput = -1; cx.notify(); });
      return input;
    });
    this.state = "form";
    cx.notify();
    this.inputs[0]?.focus();
    cx.timer.after(300, () => this.inputs[this.focusedInput >= 0 ? this.focusedInput : 0]?.focus());
  }

  command(c, cx) {
    const [verb, ...rest] = c.replace(/^repo-worktree\./, "").split(":");
    const arg = rest.join(":");
    if (verb === "submit") return this.activate(cx);
    if (verb === "cancel") return this.close();
    if (verb === "down" || verb === "up") return this.move(verb === "down" ? 1 : -1);
    if (verb === "mark") return this.toggle(this.rows()[this.at]);
    if (verb === "back") return this.back();
    if (verb !== "set" || this.state !== "form") return;
    const at = arg.indexOf("=");
    const i = this.fields.findIndex((f) => f.name === arg.slice(0, at));
    if (at < 0 || i < 0) { this.error = `Unknown field in "${c}".`; return; }
    this.inputs[i].set_value(arg.slice(at + 1));
    this.changed(this.fields[i], this.inputs[i], cx);
  }

  changed(field, input, cx) {
    if (this.syncing) return;
    const value = input.value();
    if (value === this.values[field.name]) return;
    this.edited[field.name] = value !== "";
    this.values[field.name] = value;
    // Fields below follow it until someone edits them.
    const next = this.strategy.defaults(this.entry.options, this.values, this.edited, this.ctx);
    this.syncing = true;
    this.fields.forEach((f, i) => {
      if (next[f.name] !== this.values[f.name]) { this.values[f.name] = next[f.name]; this.inputs[i].set_value(next[f.name]); }
    });
    this.syncing = false;
    this.error = "";
    this.at = 0;
    cx.notify();
  }

  // The plan for what is typed, or null while it is not complete.
  preview() {
    try {
      const plan = this.strategy.plan(this.entry.options, this.values, this.ctx);
      return plan.error ? null : plan;
    } catch { return null; }
  }

  // What the list shows: the matches, then a "create" row when the text names no checkout.
  // Create is last when anything matches: Enter then opens a checkout (instant, harmless)
  // rather than starting a long `make worktree` by mistake. Alone, it is the first row.
  rows() {
    if (this.state !== "form") return [];
    const text = this.values[this.fields[0].name] ?? "";
    if (this.memo?.text === text && this.memo.list === this.list) return this.memo.rows;
    const rows = this.buildRows(text);
    this.memo = { text, list: this.list, rows };
    return rows;
  }

  buildRows(text) {
    const plan = text.trim() ? this.preview() : null;
    const exact = exactMatch(this.list, text, plan?.space);
    const create = text.trim() && !exact ? [{ kind: "create", plan }] : [];
    const found = filterWorktrees(this.list, text);
    // An exact match goes first, so Enter opens it.
    if (exact) found.sort((a, b) => (b === exact) - (a === exact));
    return [...found.map((c) => ({ kind: "checkout", c })), ...create];
  }

  move(by) {
    const n = this.rows().length;
    if (n) this.at = (this.at + by + n) % n;
  }

  places() {
    if (this.placesAt && Date.now() - this.placesAt < 250) return this.placesMemo;
    const all = panes();
    this.placesMemo = spaces().filter((s) => !s.machine).map((s) => ({ id: s.id, folder: place(s, all), status: s.status }));
    this.placesAt = Date.now();
    return this.placesMemo;
  }

  close() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  delegate() {
    this.close();
    openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: this.spaceId ?? undefined, folder: this.folder ?? undefined, action: "new" } });
  }

  activate(cx) {
    if (this.busy || this.state !== "form") return;
    if (this.confirm) return this.remove(cx);
    if (this.marked.size) return this.ask(cx);
    const row = this.rows()[Math.min(this.at, this.rows().length - 1)];
    if (!row) { this.error = "Type a name to create a worktree."; return cx.notify(); }
    if (row.kind === "checkout") { this.open(row.c); return; }
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try { this.error = await this.create(); } catch (error) { this.error = String(error); }
      this.busy = false;
      if (!this.error) this.close();
      cx.notify();
    });
  }

  // Go to the checkout's space, or open one there with the repo's agent (like `wts`).
  open(c) {
    this.close();
    const s = spaceFor(c.path, this.list, this.places());
    if (s) return run("space.select", { id: s.id });
    const agent = this.entry.options.agent;
    run("space.new", { ...(c.main ? {} : { name: c.name }), folder: c.path, ...(agent?.length ? { argv: agent } : {}) });
  }

  async create() {
    for (const f of this.fields) {
      const v = this.values[f.name].trim();
      if (f.type !== "branch" || !v) continue;
      if (!(await git(this.repo.main, ["check-ref-format", "--branch", v])).ok) return `"${v}" is not a valid branch name.`;
    }
    const plan = this.strategy.plan(this.entry.options, this.values, this.ctx);
    if (plan.error) return plan.error;
    if (plan.kind === "delegate") { this.delegate(); return ""; }
    if (spaces().some((s) => s.name === plan.space)) return `A space called ${plan.space} is already open.`;
    const back = focused()?.space;
    run("space.new", { name: plan.space, folder: plan.folder, argv: plan.argv });
    // space.new shows the new space; in the background, go straight back.
    if (plan.background && back) run("space.select", { id: back });
    return "";
  }

  // A checkout row in or out of the removal; the main checkout never goes.
  toggle(row) {
    if (row?.kind !== "checkout" || row.c.main) return;
    if (this.marked.has(row.c.path)) this.marked.delete(row.c.path);
    else this.marked.add(row.c.path);
  }

  // Before removing: ask at once; what would be lost in each checkout fills in after.
  // Enter never waits for the checks.
  ask(cx) {
    const places = this.places();
    const confirm = this.list.filter((c) => this.marked.has(c.path)).map((c) => ({ c, checking: true, open: Boolean(spaceFor(c.path, this.list, places)) }));
    this.confirm = confirm;
    // This screen has no input. Keys go to the focused element, so an input that leaves the
    // tree takes them with it: the root must hold the focus for Enter to arrive.
    this.handle.focus();
    cx.notify();
    for (const row of confirm) {
      cx.spawn(async (cx) => {
        const r = await exec("/bin/sh", ["-c", CHECKS, "sh", row.c.path], { cwd: row.c.path }).catch(() => null);
        const [dirty, ahead] = String(r?.stdout ?? "").split("\x1e");
        Object.assign(row, { checking: false, failed: r?.code !== 0, dirty: Boolean(dirty), unpushed: Boolean(ahead?.trim()) });
        if (this.confirm === confirm) cx.notify();
      });
    }
  }

  // From the confirmation to the list: the input is back in the tree, so it takes the focus again.
  back() {
    this.confirm = null;
    this.inputs[0]?.focus();
  }

  // Close the checkouts' spaces now (their processes stop), then delete them in a background job.
  remove(cx) {
    const items = this.confirm.map((x) => x.c);
    const plan = removePlan(items, this.repo.main, this.entry.options.remove);
    if (plan.error) { this.error = plan.error; return cx.notify(); }
    const back = focused()?.space;
    // The next open shows the list without them, before its refresh.
    const hit = CACHE.get(this.folder);
    if (hit) hit.snap = { ...hit.snap, list: hit.snap.list.filter((c) => !items.some((x) => x.path === c.path)) };
    const inside = (folder, path) => folder === path || folder.startsWith(`${path}/`);
    const closing = this.places().filter((p) => p.folder && items.some((c) => inside(p.folder, c.path))).map((p) => p.id);
    for (const id of closing) run("space.close", { id, confirmed: true });
    this.close();
    run("space.new", { name: plan.space, folder: plan.folder, argv: plan.argv });
    if (back && !closing.includes(back)) run("space.select", { id: back });
  }

  key(e, cx) {
    if (this.confirm) {
      if (e.key === "escape") this.back();
      else if (e.key === "enter") this.remove(cx);
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
    if (e.key === "escape") { this.close(); return cx.stop_propagation(); }
    if (this.state === "invalid" && e.key === "enter") { this.delegate(); return cx.stop_propagation(); }
    if (this.state !== "form") return;
    if (e.key === "down" || e.key === "up") this.move(e.key === "down" ? 1 : -1);
    else if ((e.key === "tab" && this.inputs.length === 1) || (e.key === "d" && e.modifiers?.control)) {
      this.toggle(this.rows()[this.at]);
      if (!e.modifiers?.shift) this.move(1);
    } else if (e.key === "tab" && this.inputs.length > 1) {
      const n = this.inputs.length;
      const i = ((this.focusedInput < 0 ? 0 : this.focusedInput) + (e.modifiers?.shift ? n - 1 : 1)) % n;
      this.inputs[i].focus();
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  chip(t, text) {
    return div().flex_none().px(7).py(1).rounded(5).bg(t.raised).text_size(11).text_color(t.muted).child(text);
  }

  field(t, f, i, first) {
    const on = i === this.focusedInput;
    return h_flex()
      .id(`field-${f.name}`)
      .h(first ? 40 : 32)
      .flex_none()
      .px(12)
      .gap(10)
      .items_center()
      .rounded(first ? 10 : 8)
      .border_1()
      .border_color(on ? t.accent : t.border)
      .bg(t.background)
      .when(first, (el) => el.child(svg(ICON("git-branch")).size(15).flex_none().text_color(on ? t.accent : t.dim)))
      .when(!first, (el) => el.child(div().w(84).flex_none().truncate().text_size(11.5).text_color(t.dim).child(f.label ?? f.name)))
      .child(Input.new(this.inputs[i]).flex_1().h_full().text_size(first ? 14 : 12.5).text_color(t.foreground));
  }

  // A status mark like the sidebar's: a spinner while an agent works there, a dot when it waits.
  mark(t, status) {
    if (status === "working") return svg(ICON("spinner")).size(12).flex_none().text_color(t.working).spin(900);
    if (status === "blocked" || status === "done") return div().size(7).flex_none().rounded(4).bg(t[status]);
    return null;
  }

  row(t, r, i, places) {
    const on = i === this.at;
    const base = h_flex()
      .id(`row-${i}`)
      .h(ROW)
      .flex_none()
      .px(10)
      .gap(10)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_mouse_move((_e, cx) => { if (this.at !== i) { this.at = i; cx.notify(); } })
      .on_click((_e, cx) => { this.at = i; this.activate(cx); });
    if (r.kind === "create") {
      return base
        .child(svg(ICON("plus")).size(14).flex_none().text_color(t.accent))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_color(t.foreground).child(`Create ${r.plan?.space ?? this.values[this.fields[0].name].trim()}`))
          .child(div().truncate().text_size(11).text_color(t.dim).child(r.plan ? `${tilde(r.plan.path, this.home)}${r.plan.background ? "  ·  in the background" : ""}` : "Fill in the fields")))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(on ? "↵" : ""));
    }
    const c = r.c;
    const space = spaceFor(c.path, this.list, places);
    const status = space?.status ?? null;
    const sub = [c.branch && c.branch !== c.name.replace(`${this.repo.name}-`, "") ? c.branch : null, c.main ? "main checkout" : null].filter(Boolean).join("  ·  ");
    const marked = this.marked.has(c.path);
    const icon = marked ? "x" : c.main ? "folder" : "git-branch";
    return base
      .child(
        div().id(`mark-${i}`).flex_none().p(3).rounded(5)
          .when(!c.main, (el) => el.hover((s) => s.bg(t.raised)).on_click((_e, cx) => { cx.stop_propagation(); this.toggle(r); cx.notify(); }))
          .child(svg(ICON(icon)).size(14).text_color(marked ? t.blocked : space ? t.accent : t.dim)),
      )
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(marked ? t.blocked : t.foreground).when(Boolean(space), (d) => d.font_semibold()).child(c.name))
        .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(sub))))
      .children([this.mark(t, status)].filter(Boolean))
      .child(div().flex_none().text_size(11).text_color(space ? t.accent : t.dim).child(space ? "open" : ago(c.at)));
  }

  renderConfirm(root, t) {
    const n = this.confirm.length;
    const lost = this.entry.options.remove?.deleteBranch !== false;
    return root
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child(`Remove ${n} worktree${n === 1 ? "" : "s"}?`))
        .child(this.chip(t, this.repo.name)))
      .child(div().text_size(12).text_color(t.muted).child(`Their spaces close now. The folders${lost ? " and branches" : ""} are deleted in the background; Herdr tells you when it is done.`))
      .children(this.confirm.map(({ c, checking, dirty, unpushed, open }, i) => {
        const warn = [dirty ? "uncommitted changes" : null, unpushed && lost ? "commits on no remote" : null].filter(Boolean);
        return h_flex().id(`rm-${i}`).h(ROW).flex_none().px(10).gap(10).items_center().rounded(8).bg(t.background)
          .child(svg(ICON("x")).size(14).flex_none().text_color(t.blocked))
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().text_color(t.foreground).child(c.name))
            .child(div().truncate().text_size(11).text_color(warn.length ? t.blocked : t.dim).child(warn.length ? `${warn.join(" and ")}: lost` : `${c.branch ?? "detached"}${checking ? "  ·  checking…" : ""}`)))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(open ? "space closes" : ""));
      }))
      .child(h_flex().justify_end().gap(12).text_size(11.5).text_color(t.dim)
        .child(div().text_color(this.error ? t.blocked : t.dim).child(this.error))
        .child(div().text_color(t.muted).child("↵ remove  ·  esc cancel")));
  }

  render(_cx) {
    const t = theme();
    const root = v_flex()
      .id("repo-worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .w_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13);
    const head = (right) =>
      h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Worktrees"))
        .children(right)
        .child(div().text_size(11).text_color(t.dim).child("Esc"));
    if (this.state === "loading") return root.child(head([])).child(div().h(40).text_color(t.dim).child("…"));
    if (this.state === "invalid") {
      return root
        .child(head(this.repo ? [this.chip(t, this.repo.name)] : []))
        .child(div().text_color(t.blocked).child(`${tilde(`${appHome()}/${CONFIG_FILE}`, this.home)} has problems`))
        .children(this.errors.map((e, i) => div().id(`err-${i}`).text_size(12).text_color(t.muted).child(`• ${e}`)))
        .child(div().text_size(11).text_color(t.dim).child("↵ use Herdr's dialog"));
    }
    if (this.confirm) return this.renderConfirm(root, t);
    const rows = this.rows();
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const places = this.places();
    const count = this.list.length;
    return root
      .child(head([this.chip(t, this.repo.name)]))
      .children(this.fields.map((f, i) => this.field(t, f, i, i === 0)))
      .child(
        v_flex()
          .id("rows")
          .h(Math.max(1, Math.min(rows.length, MAX_ROWS)) * (ROW + 2))
          .flex_none()
          .gap(2)
          .overflow_y_scrollbar()
          .children(rows.map((r, i) => this.row(t, r, i, places)))
          .when(rows.length === 0, (el) => el.child(div().h(ROW).px(10).flex().items_center().text_color(t.dim).child(count ? "No match." : "…"))),
      )
      .child(
        h_flex().gap(12).items_center().text_size(11.5).text_color(t.dim)
          .child(div().flex_1().min_w(0).truncate().text_color(this.error ? t.blocked : t.dim).child(this.error || `${count} checkout${count === 1 ? "" : "s"}`))
          .when(this.fields.length > 1, (el) => el.child(div().flex_none().child("Tab next")))
          .child(div().flex_none().text_color(t.muted).child(
            this.busy ? "…" : this.marked.size ? `${this.marked.size} marked  ·  ↵ remove` : `↑↓ choose  ·  ${this.fields.length === 1 ? "Tab" : "ctrl-d"} mark  ·  ↵ open`,
          )),
      );
  }
}
