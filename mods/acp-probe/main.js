// ACP probe: measures three Herdr mod capabilities (transport, rendering, commands) before an ACP chat view.
// Not a product. Never opened by a layout or key: open it by hand with
//   herdr-app do pane.split --direction right --mod acp-probe     (test instance only)
// Drive it with `herdr-app do acp-probe.<cmd>`:  info, tcp, ws, poll, quiet, rpc, stream[:opts], fps, focus, clear.
// stream opts (comma list): msgs=500, chunk=50, flush=100, secs=30, split=150, scroll=bottom|item|none
// Results go to <appHome>/data/acp-probe/results.json.

import { View, div, list } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, VirtualListScrollHandle, TextView, Textarea, TextareaState, v_virtual_list } from "gpui-base";
import { show_fps_monitor, hide_fps_monitor } from "gpui-fps";
import { appHome, theme, readTextFile, nextCommand } from "herdr";
import { connect } from "net";
import { WebSocket } from "websocket";
import { Buffer } from "buffer";
import * as fs from "fs/promises";

const now = () => Date.now();
const stat = (xs) => {
  if (!xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], mean: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] };
};

// A deterministic markdown stream: headings, paragraphs, lists, code fences, a table.
function makeStream(chars) {
  const blocks = [];
  let k = 0;
  while (blocks.join("").length < chars) {
    k++;
    blocks.push(`### Step ${k}: reading the module\n\n`);
    blocks.push(`I looked at **file ${k}.ts** and found that \`handle${k}()\` calls the *session* store twice, so the second call is redundant. This is a longer sentence to make the paragraph wrap across the pane width and show how line breaking behaves while text grows.\n\n`);
    blocks.push(`- first point about item ${k}\n- second point with \`inline code\`\n- third point with a [link](https://example.com/${k})\n\n`);
    blocks.push("```ts\nexport function handle" + k + "(input: string): number {\n  const parts = input.split(',');\n  return parts.length * " + k + ";\n}\n```\n\n");
    if (k % 3 === 0) blocks.push(`| key | value |\n|---|---|\n| a${k} | ${k * 7} |\n| b${k} | ${k * 11} |\n\n`);
  }
  return blocks.join("");
}
function preload(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) out.push({ role: "user", text: `Question ${i / 2}: explain how the cache invalidation works in module ${i}?` });
    else out.push({ role: "assistant", text: makeStream(150 + ((i * 97) % 1400)).slice(0, 150 + ((i * 97) % 1400)) + `\n\n(end of message ${i})` });
  }
  return out;
}

export default class AcpProbe extends View {
  init(_props, cx) {
    this.messages = [{ role: "assistant", text: "ACP probe ready. Drive with `herdr-app do acp-probe.<cmd>`." }];
    this.status = "idle";
    this.results = {};
    this.renders = { count: 0, durs: [], gaps: [], last: 0 };
    this.scroll = VirtualListScrollHandle.new();
    this.ta = TextareaState.new({ placeholder: "Type here. Enter / Shift+Enter?", rows: 2 });
    this.ta.set_auto_grow(2, 6);
    this.submits = [];
    this.ta.on("submit", (e, cx2) => {
      this.submits.push({ shift: e?.shift ?? null, secondary: e?.secondary ?? null, value: this.ta.value(), t: now() });
      this.messages.push({ role: "user", text: `submit event ${JSON.stringify(e)} value=${JSON.stringify(this.ta.value())}` });
      this.save();
      cx2.notify();
    });
    this.changes = 0;
    this.ta.on("change", (e) => { this.changes++; this.lastChange = { shift: e?.shift ?? null, len: this.ta.value().length }; });
    readTextFile(`${appHome()}/data/acp-probe/results.json`).then((raw) => { if (raw) this.results = { ...JSON.parse(raw).results, ...this.results }; }).catch(() => {});
    this.heights = new Map();
    this.dirty = false;
    cx.timer.every(60, (c) => { if (this.dirty) { this.dirty = false; c.notify(); if (this.view === "vmeasure") this.scroll.scroll_to_bottom(); } });
    this.follow = true;
    this.scrollMode = "bottom";
    this.view = "list";
    cx.spawn(async (cx) => {
      for (;;) {
        const raw = String(await nextCommand());
        const cmd = raw.replace(/^acp-probe\./, "");
        try { this.run(cmd, cx); } catch (e) { this.status = "ERR " + cmd + ": " + e; this.errors = [...(this.errors ?? []), this.status]; }
        cx.notify();
      }
    });
  }

  async save() {
    try {
      const dir = `${appHome()}/data/acp-probe`;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(`${dir}/results.json`, JSON.stringify({ results: this.results, submits: this.submits, changes: this.changes, lastChange: this.lastChange }, null, 1));
    } catch (e) {
      this.status = "save failed: " + e;
    }
  }

  setStatus(cx, s) { this.status = s; cx.notify(); }

  run(cmd, cx) {
    const [name, arg] = cmd.split(":");
    const opts = Object.fromEntries(String(arg ?? "").split(",").filter(Boolean).map((kv) => kv.split("=")));
    this.lastCmd = cmd;
    if (name === "info") cx.spawn((c) => this.info(c));
    else if (name === "tcp") cx.spawn((c) => this.tcp(c, Number(opts.secs ?? 10)));
    else if (name === "tcpbig") cx.spawn((c) => this.tcpbig(c, Number(arg ?? 1000000)));
    else if (name === "tcpbad") cx.spawn((c) => this.tcpbad(c));
    else if (name === "ws") cx.spawn((c) => this.ws(c, Number(opts.secs ?? 10)));
    else if (name === "poll") cx.spawn((c) => this.poll(c, Number(opts.secs ?? 20)));
    else if (name === "quiet") cx.spawn((c) => this.quiet(c));
    else if (name === "rpc") cx.spawn((c) => this.rpc(c));
    else if (name === "stream") cx.spawn((c) => this.stream(c, opts));
    else if (name === "fps") { show_fps_monitor({ anchor: "top_right", frame_budget: 16.7 }); this.status = "fps shown"; }
    else if (name === "fpsoff") { this.status = "fps hidden " + hide_fps_monitor(); }
    else if (name === "focus") this.ta.focus();
    else if (name === "clear") { this.messages = []; this.status = "cleared"; }
    else if (name === "scrollbottom") this.scroll.scroll_to_bottom();
    else if (name === "view") this.view = arg;
    else if (name === "fill") this.messages = preload(Number(arg ?? 500));
    else this.status = "unknown cmd " + cmd;
  }

  async ports() {
    return JSON.parse(await readTextFile(`${appHome()}/data/acp-probe/ports.json`));
  }

  async info(cx) {
    const r = {};
    for (const n of ["TextDecoder", "TextEncoder", "performance", "queueMicrotask", "structuredClone", "AbortController", "URL", "Promise", "setTimeout", "WebSocket", "EventSource", "ReadableStream", "Blob"]) {
      r[n] = typeof globalThis[n];
    }
    r.fetchType = typeof fetch;
    r.dateNow = now();
    this.results.info = r;
    try { const p = await this.ports(); r.ports = p; } catch (e) { r.ports = "ERR " + e; }
    await this.save();
    this.setStatus(cx, "info done");
  }

  // Shared reader loop for tcp: returns stats.
  async tcp(cx, secs) {
    const res = { kind: "tcp", secs };
    this.results.tcp = res;
    try {
      const { tcp } = await this.ports();
      const t0 = now();
      const sock = await connect("127.0.0.1", tcp);
      res.connectMs = now() - t0;
      const lat = [], rtt = [], linesPerRead = [], bytesPerRead = [], gaps = [];
      let buf = "", lastRead = now(), reads = 0, bytes = 0, lines = 0, wrote = 0, writeErr = null;
      const end = now() + secs * 1000;
      // writer task: one ping per 250 ms on the same socket, concurrent with the reader
      let stop = false;
      cx.spawn(async (c) => {
        let id = 0;
        while (!stop) {
          try { await sock.write(JSON.stringify({ id: id++, t: now() }) + "\n"); wrote++; } catch (e) { writeErr = String(e); break; }
          await c.sleep(250);
        }
      });
      while (now() < end) {
        const chunk = await sock.read(65536);
        if (chunk === null) { res.eof = true; break; }
        const t = now();
        reads++; bytes += chunk.length; bytesPerRead.push(chunk.length); gaps.push(t - lastRead); lastRead = t;
        buf += Buffer.from(chunk).toString("utf8");
        let n = 0, i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1); n++; lines++;
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.kind === "tick") lat.push(t - o.t);
          else if (o.kind === "echo") rtt.push(t - o.clientT);
        }
        linesPerRead.push(n);
        if (reads % 20 === 0) this.setStatus(cx, `tcp reads=${reads} lines=${lines}`);
      }
      stop = true;
      sock.close();
      Object.assign(res, { reads, bytes, lines, wrote, writeErr, tickLatencyMs: stat(lat), echoRttMs: stat(rtt), linesPerRead: stat(linesPerRead), bytesPerRead: stat(bytesPerRead), readGapMs: stat(gaps) });
      res.ok = true;
    } catch (e) {
      res.ok = false; res.error = String(e);
    }
    await this.save();
    this.setStatus(cx, "tcp done ok=" + res.ok);
  }

  async tcpbig(cx, size) {
    const res = { kind: "tcpbig", size };
    this.results.tcpbig = res;
    try {
      const { tcp } = await this.ports();
      const sock = await connect("127.0.0.1", tcp);
      const t0 = now();
      await sock.write(JSON.stringify({ big: size }) + "\n");
      let buf = "", reads = 0, bytes = 0, maxChunk = 0;
      for (;;) {
        const chunk = await sock.read(65536);
        if (chunk === null) { res.eof = true; break; }
        reads++; bytes += chunk.length; maxChunk = Math.max(maxChunk, chunk.length);
        buf += Buffer.from(chunk).toString("utf8");
        const i = buf.indexOf('"kind":"big"');
        if (i >= 0 && buf.indexOf("\n", i) >= 0) { res.gotBig = true; break; }
      }
      Object.assign(res, { ms: now() - t0, reads, bytes, maxChunk, ok: true });
      sock.close();
    } catch (e) { res.ok = false; res.error = String(e); }
    await this.save();
    this.setStatus(cx, "tcpbig done");
  }

  async tcpbad(cx) {
    const res = { kind: "tcpbad" };
    this.results.tcpbad = res;
    try { await connect("127.0.0.1", 1); res.ok = true; } catch (e) { res.error = String(e); }
    await this.save();
    this.setStatus(cx, "tcpbad done");
  }

  async ws(cx, secs) {
    const res = { kind: "ws", secs };
    this.results.ws = res;
    try {
      const { ws } = await this.ports();
      const t0 = now();
      const sock = await WebSocket.connect(`ws://127.0.0.1:${ws}/`);
      res.connectMs = now() - t0;
      const lat = [], rtt = [], gaps = [];
      let msgs = 0, wrote = 0, writeErr = null, lastRead = now(), types = {};
      let stop = false;
      cx.spawn(async (c) => {
        let id = 0;
        while (!stop) {
          try { await sock.write(JSON.stringify({ id: id++, t: now() })); wrote++; } catch (e) { writeErr = String(e); break; }
          await c.sleep(250);
        }
      });
      const end = now() + secs * 1000;
      while (now() < end) {
        const m = await sock.read();
        const t = now();
        msgs++; gaps.push(t - lastRead); lastRead = t;
        const ty = typeof m === "string" ? "string" : "bytes"; types[ty] = (types[ty] ?? 0) + 1;
        let o; try { o = JSON.parse(typeof m === "string" ? m : Buffer.from(m).toString("utf8")); } catch { continue; }
        if (o.kind === "tick") lat.push(t - o.t);
        else if (o.kind === "echo") rtt.push(t - o.clientT);
        if (msgs % 20 === 0) this.setStatus(cx, `ws msgs=${msgs}`);
      }
      stop = true;
      await sock.close();
      Object.assign(res, { msgs, wrote, writeErr, types, tickLatencyMs: stat(lat), echoRttMs: stat(rtt), readGapMs: stat(gaps), ok: true });
    } catch (e) {
      res.ok = false; res.error = String(e);
    }
    await this.save();
    this.setStatus(cx, "ws done ok=" + res.ok);
  }

  async poll(cx, secs) {
    const res = { kind: "poll", secs, responses: [] };
    this.results.poll = res;
    try {
      const { http } = await this.ports();
      let since = 0;
      const end = now() + secs * 1000;
      const lat = [], held = [], perResp = [];
      let empty = 0;
      while (now() < end) {
        const t0 = now();
        const r = await fetch(`http://127.0.0.1:${http}/events?since=${since}`);
        const t = now();
        const j = await r.json();
        held.push(t - t0);
        perResp.push(j.events.length);
        if (!j.events.length) empty++;
        for (const e of j.events) lat.push(t - e.t);
        if (j.events.length) since = j.next;
        if (res.responses.length < 25) res.responses.push({ status: r.status, ms: t - t0, n: j.events.length, heldServer: j.heldMs, oldestAgeMs: j.events.length ? t - j.events[0].t : null, newestAgeMs: j.events.length ? t - j.events[j.events.length - 1].t : null });
        this.setStatus(cx, `poll since=${since}`);
      }
      Object.assign(res, { requests: held.length, empty, requestMs: stat(held), eventsPerResponse: stat(perResp), eventAgeMs: stat(lat), totalEvents: since, ok: true });
    } catch (e) {
      res.ok = false; res.error = String(e);
    }
    await this.save();
    this.setStatus(cx, "poll done ok=" + res.ok);
  }

  async quiet(cx) {
    const res = { kind: "quiet25" };
    this.results.quiet = res;
    try {
      const { http } = await this.ports();
      const t0 = now();
      this.setStatus(cx, "quiet long-poll: waiting up to 25 s");
      const r = await fetch(`http://127.0.0.1:${http}/events?since=0&quiet=1`);
      const j = await r.json();
      Object.assign(res, { status: r.status, elapsedMs: now() - t0, serverHeldMs: j.heldMs, events: j.events.length, ok: true });
    } catch (e) {
      res.ok = false; res.error = String(e); res.elapsedMs = null;
    }
    await this.save();
    this.setStatus(cx, "quiet done ok=" + res.ok);
  }

  async rpc(cx) {
    const res = { kind: "post-rpc" };
    this.results.rpc = res;
    try {
      const { http } = await this.ports();
      const rtt = [];
      for (let i = 0; i < 40; i++) {
        const t0 = now();
        const r = await fetch(`http://127.0.0.1:${http}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ i, pad: "y".repeat(200) }) });
        await r.json();
        rtt.push(now() - t0);
      }
      res.rttMs = stat(rtt); res.ok = true;
    } catch (e) { res.ok = false; res.error = String(e); }
    await this.save();
    this.setStatus(cx, "rpc done ok=" + res.ok);
  }

  async stream(cx, o) {
    const cfg = { msgs: Number(o.msgs ?? 0), chunk: Number(o.chunk ?? 50), flush: Number(o.flush ?? 100), secs: Number(o.secs ?? 30), split: Number(o.split ?? 150), scroll: o.scroll ?? "bottom", size: Number(o.size ?? 40) };
    if (o.view) this.view = o.view;
    const tag = `stream_${this.view}_${cfg.msgs}msgs_flush${cfg.flush}_${cfg.scroll}`;
    const res = { kind: "stream", cfg };
    this.results[tag] = res;
    this.scrollMode = cfg.scroll;
    this.renders = { count: 0, durs: [], gaps: [], last: 0 };
    this.messages = preload(cfg.msgs);
    this.messages.push({ role: "user", text: "Stream test please." });
    this.messages.push({ role: "assistant", text: "" });
    cx.notify();
    await cx.sleep(1500); // let the preloaded list lay out once
    res.preloadRenderCount = this.renders.count;
    this.renders = { count: 0, durs: [], gaps: [], last: 0 };
    const text = makeStream(Math.ceil((cfg.secs * 1000) / cfg.chunk) * cfg.size + 4000);
    let pending = "", idx = 0, off = 0, genTicks = 0, flushes = 0, lastGen = now(), lastFlush = now();
    const genGaps = [], flushGaps = [], flushDur = [];
    const t0 = now();
    const gen = cx.timer.every(cfg.chunk, () => {
      const t = now(); genGaps.push(t - lastGen); lastGen = t;
      const piece = text.slice(off, off + cfg.size); off += cfg.size; genTicks++;
      pending += piece + (genTicks % 10 === 0 ? ` ⟨${genTicks}⟩ ` : "");
      if (cfg.split && genTicks % cfg.split === 0) { this.messages.push({ role: "assistant", text: "" }); }
    });
    const fl = cx.timer.every(cfg.flush, (c) => {
      const t = now(); flushGaps.push(t - lastFlush); lastFlush = t;
      if (!pending) return;
      const m = this.messages[this.messages.length - 1];
      m.text += pending; pending = ""; flushes++;
      this.genShown = genTicks;
      c.notify();
      if (cfg.scroll === "bottom" || this.view === "vmeasure") this.scroll.scroll_to_bottom();
      else if (cfg.scroll === "item") this.scroll.scroll_to_item(this.messages.length - 1, "top");
      flushDur.push(now() - t);
    });
    this.setStatus(cx, `streaming ${tag}`);
    await cx.sleep(cfg.secs * 1000);
    gen.cancel?.(); fl.cancel?.();
    const wall = now() - t0;
    // final flush so the screen shows the end
    const m = this.messages[this.messages.length - 1];
    m.text += pending + "\n\n**END-OF-STREAM**";
    this.genShown = genTicks;
    cx.notify();
    if (cfg.scroll === "bottom") this.scroll.scroll_to_bottom();
    Object.assign(res, {
      wallMs: wall, genTicks, expectedTicks: Math.round(wall / cfg.chunk), genGapMs: stat(genGaps), flushes, flushGapMs: stat(flushGaps),
      renderCount: this.renders.count, renderFnMs: stat(this.renders.durs), renderGapMs: stat(this.renders.gaps),
      view: this.view, messages: this.messages.length, lastMsgChars: m.text.length, totalChars: this.messages.reduce((a, b) => a + b.text.length, 0), ok: true,
    });
    await this.save();
    this.setStatus(cx, `stream done ${tag}`);
  }

  size(i) {
    const m = this.messages[i];
    const h = this.heights.get(i);
    return h && h.w === this.width ? h.h : this.est(m);
  }

  est(m) {
    const cols = Math.max(20, Math.floor((this.width ?? 600) / 7.2));
    const lines = m.text.split("\n").reduce((a, l) => a + Math.max(1, Math.ceil(l.length / cols)), 0);
    return 28 + lines * 19;
  }

  row(index, t) {
    const m = this.messages[index];
    const user = m.role === "user";
    return v_flex().w_full().px(12).py(6).gap(2)
      .child(div().text_size(10).text_color(user ? t.accent : t.dim).child(`${m.role} #${index}`))
      .child(user
        ? div().text_size(13).text_color(t.foreground).child(m.text)
        : TextView.markdown(`md-${index}`, m.text || "…").text_size(13).text_color(t.foreground));
  }

  render(_cx) {
    const t0 = now();
    const t = theme();
    const r = this.renders;
    r.count++;
    if (r.last) r.gaps.push(t0 - r.last);
    r.last = t0;
    const root = v_flex().id("probe").on_size_change((sz, cx2) => { this.width = sz.width; }).size_full().bg(t.background).text_color(t.foreground).text_size(12);
    const header = div().flex_none().px(12).py(4).bg(t.chrome).text_size(11).text_color(t.muted)
      .child(`${this.status} | msgs=${this.messages.length} renders=${r.count} gen=${this.genShown ?? 0} view=${this.view} scroll=${this.scrollMode} meas=${this.measuring ?? 0} h=${this.heights.size} submits=${this.submits.length} chg=${this.changes}`);
    const n = this.messages.length;
    let body;
    if (this.view === "reverse") {
      const idx = Array.from({ length: n }, (_, i) => n - 1 - i);
      body = div().flex_1().min_h(0).relative()
        .child(v_flex().id("msgs").size_full().overflow_y_scroll().flex_col_reverse().children(idx.map((i) => this.row(i, t))))
        .child(Scrollbar.vertical("msgs").absolute().inset_0());
    } else if (this.view === "vlist") {
      const sizes = this.messages.map((m) => this.est(m));
      body = div().flex_1().min_h(0).relative()
        .child(v_virtual_list("msgs", n, sizes, (i) => `m${i}`, (range) => { const o = []; for (let i = range.start; i < range.end; i++) o.push(this.row(i, t).h(sizes[i]).overflow_hidden()); return o; }).track_scroll(this.scroll).size_full())
        .child(Scrollbar.vertical("msgs").absolute().inset_0());
    } else if (this.view === "vmeasure") {
      const sizes = this.messages.map((_, i) => this.size(i));
      const need = [];
      for (let i = n - 1; i >= 0 && need.length < 40; i--) {
        const h = this.heights.get(i);
        if (!h || h.w !== this.width || i === n - 1) need.push(i);
      }
      const w = this.width ?? 600;
      const meas = div().absolute().top(0).left(0).w(w).invisible()
        .children(need.map((i) => { const len = this.messages[i].text.length; return this.row(i, t).id(`meas-${i}`).on_size_change((sz) => { const o = this.heights.get(i); if (!o || o.h !== sz.height || o.w !== w) { this.heights.set(i, { h: sz.height, len, w }); this.dirty = true; } }); }));
      body = div().flex_1().min_h(0).relative()
        .child(v_virtual_list("msgs", n, sizes, (i) => `m${i}`, (range) => { const o = []; for (let i = range.start; i < range.end; i++) o.push(this.row(i, t).h(sizes[i]).overflow_hidden()); return o; }).track_scroll(this.scroll).size_full())
        .child(Scrollbar.vertical("msgs").absolute().inset_0())
        .child(meas);
      this.measuring = need.length;
    } else if (this.view === "plain") {
      body = div().flex_1().min_h(0).relative()
        .child(v_flex().id("msgs").size_full().overflow_y_scroll().children(this.messages.map((_, i) => this.row(i, t))))
        .child(Scrollbar.vertical("msgs").absolute().inset_0());
    } else {
      body = div().flex_1().min_h(0).relative()
        .child(list("msgs", n, (i) => `m${i}`, (i) => this.row(i, t)).size_full())
        .child(Scrollbar.vertical("msgs").absolute().inset_0());
    }
    const composer = div().flex_none().p(8).border_t(1).border_color(t.border).child(Textarea.new(this.ta));
    const out = root.child(header).child(body).child(composer);
    r.durs.push(now() - t0);
    return out;
  }
}
