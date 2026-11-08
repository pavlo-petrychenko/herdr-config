// spaces-flat: how a space and its agents look (written by spaces-flat-patch.py; edit it there).
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
