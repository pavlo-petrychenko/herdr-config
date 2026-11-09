// The status bar with agent usage, and its popup. One mod, two roles (props().role):
//   bar    the bottom bar of main-flat (in place of the shipped workspace-status): machine,
//          branch, agents, then the focused agent's logo and how much of its limit is used.
//          Click it: the popup.
//   panel  the popup: every agent's usage. Claude Code: the 5-hour and weekly limits.
//          OpenCode (Go plan): the 5-hour, weekly and monthly limits from OpenCode's server,
//          then today's and the week's cost and tokens.
// Data: usage.js.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, agents, focused, theme, run, window, props, home, appHome, exec, readTextFile, watchFolder, openOverlay, closeOverlay } from "herdr";
import { OPENCODE_DB, OPENCODE_SQL, GO_USAGE_URLS, GO_KEY_SQL, parseOpencode, parseGoUsage, goProblem, parseClaude, level, resetsIn, ago, tokens, money } from "./usage.js";

const LOGO = { claude: "icons/claude.svg", opencode: "icons/opencode.svg" };
const NAME = { claude: "Claude Code", opencode: "OpenCode" };
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;

// What the bar and the popup show. Module state lasts only as long as one copy, so each copy
// reads for itself; the reads are small.
async function readClaude() {
  return parseClaude(await readTextFile(`${appHome()}/data/agent-usage/claude.json`).catch(() => null));
}
async function readOpencode() {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const r = await exec("sqlite3", ["-readonly", `${home()}${OPENCODE_DB}`, OPENCODE_SQL(day.getTime(), Date.now() - 7 * 86400000)]).catch(() => null);
  return r?.code === 0 ? parseOpencode(r.stdout) : null;
}
// The Go plan's limits: { at, windows, problem }. Shared by every copy, at most one call a minute.
const GO = (globalThis.__agentUsageGo ??= { at: 0, windows: [], problem: null });
async function goKey() {
  const r = await exec("sqlite3", ["-readonly", `${home()}${OPENCODE_DB}`, GO_KEY_SQL]).catch(() => null);
  const key = r?.code === 0 ? r.stdout.trim() : "";
  if (key) return key;
  try { return JSON.parse(await readTextFile(`${home()}/.local/share/opencode/auth.json`))?.["opencode-go"]?.key ?? ""; } catch { return ""; }
}
async function readGo() {
  if (Date.now() - GO.at < 60000) return GO;
  const key = await goKey();
  let problem = key ? null : "No Go key is saved. Run opencode auth login.";
  for (const url of key ? GO_USAGE_URLS : []) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
      const body = await res.json().catch(() => null);
      if (res.ok) { const windows = parseGoUsage(body); if (windows.length) { Object.assign(GO, { at: Date.now(), windows, problem: null }); return GO; } problem = "OpenCode answered in an unknown shape."; }
      else problem = goProblem(res.status, body);
      if (body?.error?.code === "api_key_expired") break;
    } catch { problem = "OpenCode could not be reached."; }
  }
  return Object.assign(GO, { at: Date.now(), windows: [], problem });
}
const sleep = (cx, ms) => new Promise((done) => cx.timer.after(ms, done));

export default class AgentUsage extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "panel";
    this.claude = null;
    this.opencode = null;
    this.go = GO;
    this.handle = cx.focus_handle();
    // Claude: on every write of its file (each reply), and every 30 s so resets show.
    // One watch at a time: a watch cannot be cancelled, so the next loop waits on the same one
    // until it fires (a new watch per loop leaked one host task every 30 s until the window's
    // 1024 limit broke every mod).
    cx.spawn(async (cx) => {
      let watch = null;
      for (;;) {
        this.claude = await readClaude();
        cx.notify();
        watch ??= watchFolder(`${appHome()}/data/agent-usage`).catch(() => sleep(cx, 30000)).then(() => { watch = null; });
        await Promise.race([watch, sleep(cx, 30000)]);
      }
    });
    // OpenCode: its database once a minute, the Go limits every 5 minutes (the bar only while
    // an OpenCode agent is in front).
    cx.spawn(async (cx) => {
      for (let n = 0; ; n += 1) {
        if (this.role === "panel" || this.program() === "opencode") {
          this.opencode = await readOpencode();
          if (n % 5 === 0) this.go = await readGo();
          cx.notify();
        }
        await sleep(cx, 60000);
      }
    });
    if (this.role === "panel") this.handle.focus();
  }

  // The agent the bar speaks for: the focused one, else the one that changed last.
  program() {
    const list = agents().filter((a) => LOGO[a.program?.key]);
    const f = focused();
    const a = list.find((x) => x.address === f?.agent || x.focused) ?? [...list].sort((x, y) => y.seq - x.seq)[0];
    return a?.program?.key ?? "claude";
  }

  logo(key, size) {
    return key === "opencode" ? svg(LOGO[key]).size(size).flex_none().text_color(theme().foreground) : image(LOGO[key]).w(size).h(size).flex_none();
  }

  color(t, pct) {
    return { ok: t.accent, warn: t.ansi3, hot: t.ansi1 }[level(pct)];
  }

  meter(t, pct, w, h) {
    return div().w(w).h(h).flex_none().rounded(h / 2).bg(t.raised).child(div().h_full().w(Math.max(pct > 0 ? h : 0, (w * pct) / 100)).rounded(h / 2).bg(this.color(t, pct)));
  }

  // The bar's usage item: logo, meter, number.
  chip(t) {
    const key = this.program();
    const w = this.claude?.windows?.[0];
    const g = this.go?.windows?.[0];
    const text = key === "claude" ? (w ? `${Math.round(w.used)}%` : "–") : g ? `${Math.round(g.used)}%` : this.opencode ? `${money(this.opencode.day.cost)} today` : "–";
    return h_flex().id("usage").h(20).px(6).gap(6).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => openOverlay({ mod: "agent-usage", kind: "popup", width: 360, height: 372, props: { role: "panel" } }))
      .child(this.logo(key, 13))
      .when(key === "claude" && Boolean(w), (el) => el.child(this.meter(t, w.used, 28, 4)))
      .when(key === "opencode" && Boolean(g), (el) => el.child(this.meter(t, g.used, 28, 4)))
      .child(div().text_color((key === "claude" ? w : g) && level((key === "claude" ? w : g).used) !== "ok" ? this.color(t, (key === "claude" ? w : g).used) : t.muted).child(text));
  }

  bar(t) {
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(ICON(icon)).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(this.chip(t))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(`${window()?.platform === "macos" ? "⌘" : "Ctrl"} Shift P  commands`));
  }

  // One agent's section: logo, name, a note on the right, then its rows.
  section(t, key, note, rows) {
    return v_flex().gap(8)
      .child(h_flex().gap(8).items_center()
        .child(this.logo(key, 15))
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(NAME[key]))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(note)))
      .children(rows);
  }

  claudeRows(t) {
    const c = this.claude;
    if (!c?.windows?.length) return [div().text_size(11.5).text_color(t.dim).child("No numbers yet: they come with Claude's next reply.")];
    return this.limitRows(t, c.windows);
  }

  // A limit per row: name, bar, percent; when it resets below.
  limitRows(t, windows) {
    return windows.map((w) => v_flex().gap(3)
      .child(h_flex().gap(10).items_center()
        .child(div().w(54).flex_none().text_color(t.muted).child({ five_hour: "5 hours", seven_day: "Week" }[w.key] ?? w.label))
        .child(div().flex_1().h(6).rounded(3).bg(t.raised)
          .child(div().h_full().rounded(3).bg(this.color(t, w.used)).w(`${Math.max(w.used > 0 ? 3 : 0, w.used)}%`)))
        .child(div().w(36).flex_none().text_right().font_semibold().text_color(level(w.used) === "ok" ? t.foreground : this.color(t, w.used)).child(`${Math.round(w.used)}%`)))
      .child(div().pl(64).text_size(11).text_color(t.dim).child(w.resets ? `resets ${resetsIn(w.resets)}` : "reset")));
  }

  opencodeRows(t) {
    const o = this.opencode;
    const cell = (title, p) => h_flex().flex_1().gap(6).items_baseline()
      .child(div().text_color(t.muted).child(title))
      .child(div().font_semibold().text_color(t.foreground).child(p ? money(p.cost) : "–"))
      .child(div().text_size(11).text_color(t.dim).child(p ? `${tokens(p.tokens)} tokens` : ""));
    const go = this.go;
    return [
      ...(go?.windows?.length ? this.limitRows(t, go.windows) : []),
      ...(go?.problem ? [h_flex().gap(10).items_start().text_size(11.5)
        .child(div().flex_1().min_w(0).whitespace_normal().text_color(t.ansi1).child(go.problem))
        .child(div().id("oc-link").flex_none().text_color(t.accent).cursor_pointer().on_click(() => { exec("open", ["https://opencode.ai/auth"]); }).child("Console ↗"))] : []),
      ...(!go?.windows?.length && !go?.problem ? [div().text_size(11.5).text_color(t.dim).child("Reading the Go plan limits…")] : []),
      h_flex().gap(12).child(cell("Today", o?.day)).child(cell("7 days", o?.week)),
    ];
  }

  panel(t) {
    const key = this.program();
    const rule = () => div().h(1).flex_none().bg(t.border);
    return v_flex().id("usage-panel").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); closeOverlay(props().overlay); } })
      .size_full().px(14).py(12).gap(12).bg(t.popover).text_size(12)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(13).font_semibold().text_color(t.foreground).child("Usage"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(this.section(t, "claude", `${key === "claude" ? "in front · " : ""}all sessions · ${ago(this.claude?.at)}`, this.claudeRows(t)))
      .child(rule())
      .child(this.section(t, "opencode", `${key === "opencode" ? "in front · " : ""}Go plan${this.go?.windows?.length ? ` · ${ago(this.go.at)}` : ""}`, this.opencodeRows(t)));
  }

  render(_cx) {
    const t = theme();
    return this.role === "bar" ? this.bar(t) : this.panel(t);
  }
}
