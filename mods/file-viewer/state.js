// What a viewer shows, as plain data. Pure: `herdr-show` (node) and the mod both use it, and
// plain node tests it.
//
// One viewer per agent terminal. Its state lives in <appHome>/data/file-viewer/<terminal>.json:
//   { tabs: [{ path, from, to, note }], active: path | null, pane: viewer pane id | null, seq }
// `herdr-show` adds tabs and opens the pane; the viewer watches the file and closes tabs.

export const MAX_TABS = 12;
export const EMPTY = Object.freeze({ tabs: [], active: null, pane: null, seq: 0 });

/** The state file of one agent terminal. */
export const stateFile = (appHome, terminal) => `${appHome}/data/file-viewer/${terminal.replace(/[^\w.-]/g, "_")}.json`;

export function parseState(text) {
  try {
    const s = JSON.parse(text ?? "");
    if (!s || !Array.isArray(s.tabs)) return { ...EMPTY };
    return { tabs: s.tabs.filter((t) => t && typeof t.path === "string"), active: s.active ?? null, pane: s.pane ?? null, seq: Number(s.seq) || 0 };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * "src/a.ts", "src/a.ts:12", "src/a.ts:12-30", "src/a.ts:12:5" (column ignored), "src/a.ts#L12-L30"
 * → { path (absolute), from, to } (1-based lines, null when not given).
 */
export function parseSpec(spec, cwd) {
  let s = String(spec ?? "").trim();
  let from = null;
  let to = null;
  const hash = s.match(/#L(\d+)(?:-L?(\d+))?$/);
  const colon = s.match(/:(\d+)(?:(?:-|:)(\d+))?$/);
  const m = hash ?? colon;
  if (m) {
    s = s.slice(0, m.index);
    from = Number(m[1]);
    // "12:5" is line 12, column 5: not a range.
    to = m[2] && (hash || m[0].includes("-")) ? Number(m[2]) : null;
    if (to !== null && to < from) [from, to] = [to, from];
  }
  if (s.startsWith("file://")) s = decodeURIComponent(s.slice(7));
  const path = s.startsWith("/") ? s : `${cwd.replace(/\/+$/, "")}/${s.replace(/^\.\//, "")}`;
  return { path: normalize(path), from, to };
}

function normalize(path) {
  const out = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/** Shows a file: an open tab for it is updated and moves to the front, else a new tab. */
export function addTab(state, tab) {
  const rest = state.tabs.filter((t) => t.path !== tab.path);
  const tabs = [...rest, { path: tab.path, from: tab.from ?? null, to: tab.to ?? null, note: tab.note ?? null }].slice(-MAX_TABS);
  return { ...state, tabs, active: tab.path, seq: state.seq + 1 };
}

/** Closes a tab; the one before it (or after) becomes active. */
export function closeTab(state, path) {
  const i = state.tabs.findIndex((t) => t.path === path);
  if (i < 0) return state;
  const tabs = state.tabs.filter((t) => t.path !== path);
  const active = state.active !== path ? state.active : (tabs[i - 1] ?? tabs[i] ?? null)?.path ?? null;
  return { ...state, tabs, active, seq: state.seq + 1 };
}

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", yml: "yaml", jsonc: "json", svelte: "html", vue: "html", py: "python", rb: "ruby", rs: "rust", sh: "bash", zsh: "bash", md: "markdown" };

/** The code view's language for a file. */
export function languageOf(path) {
  const base = path.split("/").pop() ?? "";
  const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "txt";
  return LANG[ext] ?? ext;
}

export const isMarkdown = (path) => /\.(md|markdown|mdx)$/i.test(path);
