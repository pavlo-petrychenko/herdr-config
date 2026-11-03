// The agent queue: every agent in every space, by what it needs from you (queue.js).
//   Queue    waits for you, top = next: approve, answer, blocked, review, done; then who
//            waited longest
//   Working  at work, or waiting on CI / a deploy / a job
//   Quiet    nothing asked
// In a layout block it is the sidebar version (under the spaces): click a row to go there.
// As a popup (`mod.open:agent-queue`): ↑↓ choose, Enter or 1–9 go, Esc closes.
// What agents declared comes from <appHome>/data/agent-status/<terminal>.json
// (~/.claude/hooks/herdr-status.mjs writes them).
// The sidebar copy also keeps the Mac awake while any agent is in Working (queue.js keepsAwake).

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, terminals, theme, run, props, closeOverlay, appHome, exec, readTextFile, watchFolder } from "herdr";
import { buildQueue, since, stamp, parseDeclared, keepsAwake } from "./queue.js";

// Shared by every copy (sidebar, popup) and kept across reloads.
const CHANGED = (globalThis.__agentQueueChanged ??= new Map()); // status change times
const DECLARED = (globalThis.__agentQueueDeclared ??= new Map()); // terminal key → declared status
const queue = () => buildQueue(agents(), terminals(), stamp(CHANGED, agents()), DECLARED);

const DIR = () => `${appHome()}/data/agent-status`;
const DUMP = 'mkdir -p "$1" && cd "$1" && for f in *.json; do [ -e "$f" ] && printf "%s\\t%s\\n" "$f" "$(tr -d "\\n" < "$f")"; done; true';

const ROW = 52;
const LABEL = { approve: "Approve", answer: "Answer", blocked: "Blocked", review: "Review", done: "Done", waiting: "Waiting" };

export default class AgentQueue extends View {
  init(_props, cx) {
    this.at = 0;
    this.popup = Boolean(props()?.overlay);
    this.handle = cx.focus_handle();
    if (this.popup) this.handle.focus();
    // What agents declared: all of it once, then each file as it changes.
    cx.spawn(async (cx) => {
      const r = await exec("/bin/sh", ["-c", DUMP, "sh", DIR()]).catch(() => null);
      DECLARED.clear();
      for (const [k, v] of parseDeclared(r?.stdout)) DECLARED.set(k, v);
      cx.notify();
      for (;;) {
        const changed = await watchFolder(DIR()).catch(() => null);
        if (!changed) { await new Promise((done) => cx.timer.after(10000, done)); continue; }
        for (const path of changed) {
          const name = path.split("/").pop();
          if (!name.endsWith(".json")) continue;
          const text = await readTextFile(path).catch(() => null);
          let v = null;
          try { v = text ? JSON.parse(text) : null; } catch {}
          if (v) DECLARED.set(name.slice(0, -5), v); else DECLARED.delete(name.slice(0, -5));
        }
        cx.notify();
      }
    });
    // Keep the Mac awake while an agent works. exec has a 30 s limit, so short runs, one after
    // the other; each ends by itself, so nothing stays behind if Herdr dies. The display still sleeps.
    if (!this.popup) cx.spawn(async (cx) => {
      for (;;) {
        if (keepsAwake(queue())) {
          const r = await exec("/usr/bin/caffeinate", ["-ims", "-t", "25"]).catch(() => null);
          if (r?.code === 0) continue;
        }
        await new Promise((done) => cx.timer.after(10000, done));
      }
    });
    // The times tick; the lists themselves are live.
    cx.spawn(async (cx) => {
      for (;;) {
        await new Promise((done) => cx.timer.after(15000, done));
        cx.notify();
      }
    });
  }

  rows() {
    return queue().flatMap((g) => g.items);
  }

  go(item) {
    if (!item) return;
    if (this.popup) closeOverlay(props()?.overlay);
    run("agent.focus", { terminal: item.address });
  }

  key(e, cx) {
    const rows = this.rows();
    if (e.key === "escape") closeOverlay(props()?.overlay);
    else if (e.key === "down" || e.key === "up") this.at = rows.length ? (this.at + (e.key === "down" ? 1 : rows.length - 1)) % rows.length : 0;
    else if (e.key === "enter") this.go(rows[this.at]);
    else if (/^[1-9]$/.test(e.key) && !e.modifiers?.platform) this.go(rows[Number(e.key) - 1]);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  color(t, kind) {
    return { approve: t.blocked, answer: t.ansi3, blocked: t.ansi1, review: t.accent, done: t.ansi2, waiting: t.dim }[kind] ?? t.dim;
  }

  mark(t, item) {
    if (item.section === "working" && item.kind !== "waiting") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
    if (item.section === "quiet") return div().size(8).flex_none().rounded(4).border_1().border_color(t.dim);
    return div().size(8).flex_none().rounded(4).bg(this.color(t, item.kind));
  }

  logo(t, program) {
    if (!program?.icon) return div().size(14).flex_none();
    return program.tint ? svg(program.icon).size(14).flex_none().text_color(t.foreground) : image(program.icon).w(14).h(14).flex_none();
  }

  chip(t, kind) {
    if (!kind) return null;
    return div().flex_none().text_size(10.5).font_semibold().text_color(this.color(t, kind)).child(LABEL[kind].toUpperCase());
  }

  // The popup's row.
  row(t, item, i) {
    const on = i === this.at;
    const asks = item.section === "queue";
    return h_flex().id(`agent-${item.address}`).h(ROW).flex_none().px(10).gap(10).items_center().rounded(8).cursor_pointer()
      .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_mouse_move((_e, cx) => { if (this.at !== i) { this.at = i; cx.notify(); } })
      .on_click(() => this.go(item))
      .child(h_flex().w(14).flex_none().justify_center().child(this.mark(t, item)))
      .child(this.logo(t, item.program))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(div().min_w(0).truncate().text_color(t.foreground).font_semibold().child(item.task))
          .child(div().flex_none().px(6).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child(item.space))
          .when(item.helpers > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`+${item.helpers} helper${item.helpers === 1 ? "" : "s"}`))))
        .child(h_flex().gap(6).min_w(0).text_size(11.5)
          .children([this.chip(t, item.kind)].filter(Boolean))
          .child(div().min_w(0).truncate().text_color(asks ? t.foreground : t.muted).child(item.why || " "))))
      .child(v_flex().flex_none().items_end().gap(2)
        .child(div().text_size(11).text_color(t.dim).child(since(item.since)))
        .child(div().text_size(10.5).text_color(t.dim).child(i < 9 ? String(i + 1) : "")));
  }

  // The sidebar's row: two lines.
  slim(t, item, n) {
    const asks = item.section === "queue";
    return v_flex().id(`q-${item.address}`).flex_none().px(8).py(5).gap(2).rounded(6).cursor_pointer()
      .when(item.focused, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click(() => this.go(item))
      .child(h_flex().gap(7).items_center()
        .child(h_flex().w(11).flex_none().justify_center().child(this.mark(t, item)))
        .child(this.logo(t, item.program))
        .child(div().flex_1().min_w(0).truncate().text_color(item.section === "quiet" ? t.muted : t.foreground).when(asks, (el) => el.font_semibold()).child(item.task))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(asks ? `#${n}` : since(item.since))))
      .child(h_flex().pl(39).gap(5).min_w(0).text_size(11)
        .children([this.chip(t, item.kind)].filter(Boolean))
        .child(div().min_w(0).truncate().text_color(asks ? t.muted : t.dim).child([item.why, item.space].filter(Boolean).join(" · "))));
  }

  head(t, s) {
    const hot = s.key === "queue" && s.items.some((i) => ["approve", "answer", "blocked"].includes(i.kind));
    return div().px(8).pb(1).text_size(10.5).font_semibold().text_color(hot ? t.blocked : t.dim).child(`${s.title.toUpperCase()}  ${s.items.length}`);
  }

  sidebar(t) {
    const sections = queue();
    const waiting = sections.find((s) => s.key === "queue")?.items.length ?? 0;
    return v_flex().id("agent-queue").size_full().pt(6).px(8).gap(8).text_size(12).border_t(1).border_color(t.border)
      .child(h_flex().px(8).h(24).items_center().text_size(11.5).text_color(t.muted)
        .child(div().flex_1().child("Agents"))
        .child(div().text_color(waiting ? t.foreground : t.dim).child(waiting ? `${waiting} waiting for you` : "nothing for you")))
      .child(v_flex().id("queue-list").flex_1().min_h(0).gap(8).overflow_y_scrollbar()
        .when(!sections.length, (el) => el.child(div().px(8).text_size(11.5).text_color(t.dim).child("No agents running.")))
        .children(sections.map((s) => v_flex().gap(1)
          .child(this.head(t, s))
          .children(s.items.map((item, n) => this.slim(t, item, n + 1))))));
  }

  render(_cx) {
    const t = theme();
    if (!this.popup) return this.sidebar(t);
    const sections = queue();
    const total = sections.reduce((n, s) => n + s.items.length, 0);
    if (this.at >= total) this.at = Math.max(0, total - 1);
    let i = 0;
    return v_flex().id("agent-queue").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().p(14).gap(10).bg(t.popover).text_size(12.5)
      .child(h_flex().gap(14).items_center()
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Agents"))
        .child(div().flex_1().text_size(11).text_color(t.muted).child(sections.map((s) => `${s.items.length} ${s.title.toLowerCase()}`).join(" · ")))
        .child(div().text_size(11).text_color(t.dim).child("↑↓ · ↵ or 1–9 go · Esc")))
      .child(v_flex().id("queue").h(470).flex_none().gap(10).overflow_y_scrollbar()
        .when(total === 0, (el) => el.child(div().p(10).text_color(t.dim).child("No agents running.")))
        .children(sections.map((s) => v_flex().gap(2)
          .child(this.head(t, s))
          .children(s.items.map((item) => this.row(t, item, i++))))));
  }
}
