// The hotkeys map, pure (no Herdr imports): keys.json bindings -> groups of readable rows with
// key caps. Node tests load it.

const MOD = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧", fn: "fn", super: "◆", win: "⊞" };
const MOD_TEXT = { cmd: "Cmd", ctrl: "Ctrl", alt: "Alt", shift: "Shift", fn: "Fn", super: "Super", win: "Win" };
const KEY = { enter: "↩", escape: "Esc", backspace: "⌫", delete: "⌦", tab: "⇥", left: "←", right: "→", up: "↑", down: "↓",
  space: "Space", pageup: "PgUp", pagedown: "PgDn", home: "Home", end: "End" };

/** "cmd-shift-]" -> ["⌘", "⇧", "]"] (mac) or ["Ctrl", "Shift", "]"]. "cmd--" is cmd and "-". */
export function keyCaps(spec, mac = true) {
  let s = String(spec ?? "");
  const tail = s.endsWith("--") || s === "-" ? "-" : null;
  if (tail) s = s.slice(0, s === "-" ? 0 : -2);
  const parts = s.split("-").filter(Boolean);
  if (tail) parts.push(tail);
  return parts.map((p, i) => {
    const last = i === parts.length - 1;
    if (!last && MOD[p]) return mac ? MOD[p] : MOD_TEXT[p];
    if (KEY[p]) return KEY[p];
    if (/^f\d+$/.test(p)) return p.toUpperCase();
    return p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
  });
}

const SEND = { "\u001bb": "Word left", "\u001bf": "Word right", "\u0017": "Delete word", "\u0001": "Line start", "\u0005": "Line end", "\u0015": "Delete line" };
const NAMES = {
  "tab.new": "New tab", "tab.close": "Close tab", "tab.next": "Next tab", "tab.prev": "Previous tab", "tab.rename": "Rename tab", "tab.select": "Tab",
  "space.new": "New space", "space.next": "Next space", "space.prev": "Previous space", "space.rename": "Rename space", "space.select": "Space",
  "agent.next": "Next agent", "agent.prev": "Previous agent",
  "pane.close": "Close pane", "pane.zoom": "Zoom pane",
  "layout.switch": "Next layout", "app.palette": "Command palette", "app.settings": "Settings", "app.help": "Help",
  "app.quit": "Quit", "app.hide": "Hide Herdr", "app.hide_others": "Hide others", "app.zoom_in": "Zoom in", "app.zoom_out": "Zoom out", "app.zoom_reset": "Actual size",
  "terminal.copy": "Copy", "terminal.paste": "Paste", "terminal.paste_image": "Paste image", "terminal.search": "Find",
  "viewbar.flip": "Agent ⇄ plan", "viewbar.close": "Close pane", "viewbar.keys": "Keyboard shortcuts", "plan-review.flip": "Agent ⇄ plan", "plan-review.back": "Back to the agent",
};
const MOD_NAMES = { picker: "Go to anything", "repo-worktree": "New worktree", "agent-queue": "Agent queue", "viewbar": "Keyboard shortcuts" };
const SECTION_NAMES = { "plan-review": "the plan view", "agent-queue": "the agent queue", files: "Files", changes: "Changes" };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** What an action does, readable, and its group: { group, label, base, n }. */
export function describe(action, section = "global") {
  const a = String(action ?? "");
  const [name, arg] = a.includes(":") ? [a.slice(0, a.indexOf(":")), a.slice(a.indexOf(":") + 1)] : [a, ""];
  const head = name.split(".")[0];
  if (section === "terminal" || name === "send" || head === "terminal")
    return { group: "Terminal", label: name === "send" ? SEND[arg] ?? "Send keys" : name === "terminal" ? "To the program" : NAMES[name] ?? cap(name.split(".").pop().replace(/_/g, " ")) };
  if (section.startsWith("mod:")) return { group: `In ${SECTION_NAMES[section.slice(4)] ?? section.slice(4).replace(/-/g, " ")}`, label: NAMES[name] ?? cap(name.split(".").pop().replace(/[-_]/g, " ")) };
  if (/^\d+$/.test(arg) && (name === "tab.select" || name === "space.select")) return { group: head === "tab" ? "Tabs" : "Spaces", label: `${NAMES[name]} ${arg}`, base: name, n: Number(arg) };
  if (name === "mod.open") return { group: "Open", label: MOD_NAMES[arg] ?? cap(arg.replace(/-/g, " ")) };
  if (name === "viewbar.close") return { group: "Panes", label: NAMES[name] };
  if (name === "pane.split") return { group: "Panes", label: `Split ${arg || "right"}` };
  if (name === "pane.go" || name === "pane.swap") return { group: "Panes", label: `${name === "pane.go" ? "Focus" : "Swap"} pane ${arg}`, base: name, dir: arg };
  if (name === "layout.toggle") return { group: "Window", label: `Show/hide ${arg}` };
  const group = { tab: "Tabs", space: "Spaces", agent: "Agents & plans", pane: "Panes", layout: "Window", app: name.startsWith("app.zoom") ? "Window" : "App" }[head]
    ?? (a.includes(".") && !NAMES[name] ? "Mods" : name.endsWith(".flip") || name.endsWith(".back") ? "Agents & plans" : "App");
  return { group, label: NAMES[name] ?? (a.includes(".") ? `${cap(head.replace(/-/g, " "))}: ${name.split(".").slice(1).join(".").replace(/[-_]/g, " ")}` : cap(a)) };
}

// Rows in a group follow this (then the order keys() gives).
const ACTIONS = ["viewbar.flip", "viewbar.close", "plan-review.flip", "plan-review.back", "agent.next", "agent.prev",
  "tab.new", "tab.close", "tab.next", "tab.prev", "tab.select", "tab.rename",
  "space.new", "space.next", "space.prev", "space.select", "space.rename",
  "pane.split", "pane.go", "pane.swap", "pane.zoom", "pane.close", "mod.open",
  "app.palette", "app.settings", "app.help", "layout.toggle", "layout.switch", "app.zoom_in", "app.zoom_out", "app.zoom_reset",
  "terminal.copy", "terminal.paste", "terminal.paste_image", "send", "app.hide", "app.hide_others", "app.quit"];
const ARROWS = ["←", "→", "↑", "↓"];
const DIRS = ["left", "right", "up", "down"];
const ORDER = ["Agents & plans", "Tabs", "Spaces", "Panes", "Open", "Window", "App", "Terminal", "Mods"];

/**
 * keys(): [{ section, keys, action }] -> [{ title, rows: [{ label, keys: [caps[]] }] }].
 * Only sections that apply here (global, terminal, this layout's, mods'). Actions bound to more
 * than one key are one row; "Tab 1" … "Tab 9" on cmd-1 … cmd-9 become "Tab 1–9" on "⌘ 1–9".
 */
export function keyGroups(bindings, { layout = null, mac = true } = {}) {
  const ok = (s) => s === "global" || s === "terminal" || s.startsWith("mod:") || s === `layout:${layout}`;
  const groups = new Map();
  const rows = new Map(); // group + label -> row
  const runs = new Map(); // group + base + modifiers -> [{ n, caps }]
  for (const b of bindings ?? []) {
    if (!b || !ok(b.section) || !b.action) continue;
    const d = describe(b.action, b.section);
    const caps = keyCaps(b.keys, mac);
    const name = String(b.action).split(":")[0];
    d.rank = ACTIONS.indexOf(name) === -1 ? ACTIONS.length : ACTIONS.indexOf(name);
    d.rank += (d.dir ? DIRS.indexOf(d.dir) : 0) / 10 + (b.action.endsWith(":down") && name === "pane.split" ? 0.05 : 0);
    if (d.base) {
      const k = `${d.group}\u0000${d.base}\u0000${caps.slice(0, -1).join("+")}`;
      if (!runs.has(k)) runs.set(k, { group: d.group, base: d.base, mods: caps.slice(0, -1), items: [] });
      runs.get(k).items.push({ n: d.n, dir: d.dir, caps, label: d.label, key: caps[caps.length - 1], rank: d.rank });
      continue;
    }
    const k = `${d.group}\u0000${d.label}`;
    if (!rows.has(k)) rows.set(k, { group: d.group, label: d.label, keys: [], rank: d.rank });
    const r = rows.get(k);
    if (!r.keys.some((x) => x.join(" ") === caps.join(" "))) r.keys.push(caps);
  }
  for (const r of runs.values()) {
    if (r.items[0].dir) {
      // Focus / swap pane on the four arrows with the same modifiers: one row.
      const items = r.items.sort((a, b) => DIRS.indexOf(a.dir) - DIRS.indexOf(b.dir));
      if (items.length > 2 && items.every((x) => ARROWS.includes(x.key))) {
        const label = r.base === "pane.go" ? "Focus pane" : "Swap pane";
        rows.set(`${r.group}\u0000${label}`, { group: r.group, label, keys: [[...r.mods, items.map((x) => x.key).join("")]], rank: items[0].rank });
      } else for (const x of items) rows.set(`${r.group}\u0000${x.label}`, { group: r.group, label: x.label, keys: [x.caps], rank: x.rank });
      continue;
    }
    const items = r.items.sort((a, b) => a.n - b.n);
    const digits = items.every((x) => String(x.n) === x.key);
    const contiguous = items.every((x, i) => i === 0 || x.n === items[i - 1].n + 1);
    if (items.length > 2 && digits && contiguous) {
      const name = NAMES[r.base];
      rows.set(`${r.group}\u0000${name}`, { group: r.group, label: `${name} ${items[0].n}–${items.at(-1).n}`, keys: [[...r.mods, `${items[0].n}–${items.at(-1).n}`]], rank: items[0].rank });
    } else for (const x of items) rows.set(`${r.group}\u0000${x.label}`, { group: r.group, label: x.label, keys: [x.caps], rank: x.rank });
  }
  for (const r of [...rows.values()].map((r, i) => ({ ...r, i })).sort((a, b) => a.rank - b.rank || a.i - b.i)) {
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push({ label: r.label, keys: r.keys });
  }
  const rank = (g) => { const i = ORDER.indexOf(g); return i === -1 ? (g.startsWith("In ") ? ORDER.length - 1.5 : ORDER.length) : i; };
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])).map(([title, rows]) => ({ title, rows }));
}
