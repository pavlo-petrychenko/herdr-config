// Agent usage as plain data. Pure: plain node tests it.
//
// Claude Code: its status-line script (~/.claude/statusline-herdr.sh) writes the plan's limits
//   to <appHome>/data/agent-usage/claude.json on every reply:
//   { at (ms), five_hour: { used_percentage, resets_at (s) }, seven_day: { ... } }
// OpenCode (Go plan): the limits come from OpenCode's server (GO_USAGE_URLS, not in its
//   public docs), with the Go key OpenCode saved (GO_KEY_SQL, auth.json as a fallback).
//   Today's and the week's cost and tokens come from its database (OPENCODE_SQL).

export const OPENCODE_DB = "/.local/share/opencode/opencode.db"; // under home()

/** The Go plan's usage, first URL first. */
export const GO_USAGE_URLS = ["https://opencode.ai/inference/go/v1/usage", "https://opencode.ai/zen/go/v1/usage"];
/** The saved Go key: the active row first. */
export const GO_KEY_SQL = "select json_extract(value,'$.key') from credential where integration_id='opencode-go' order by coalesce(active,0) desc, time_updated desc limit 1;";

const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const first = (o, keys) => keys.map((k) => o?.[k]).find((v) => v !== undefined && v !== null);

/**
 * The usage answer → [{ key, label, used, resets }] for 5 hours, week and month. Each window
 * gives a percentage, or used and limit; its reset as a time (ISO, s or ms) or seconds to go.
 */
export function parseGoUsage(body, nowMs = Date.now()) {
  const u = body?.usage ?? body;
  if (!u || typeof u !== "object") return [];
  return [
    ["rolling", "5 hours", u.rolling ?? u.five_hour],
    ["weekly", "Week", u.weekly ?? u.week],
    ["monthly", "Month", u.monthly ?? u.month],
  ].flatMap(([key, label, w]) => {
    if (!w || typeof w !== "object") return [];
    let used = num(first(w, ["percent", "usagePercent", "usage_percent", "used_percentage"]));
    if (used === null) {
      const a = num(first(w, ["usedMicroCents", "used"]));
      const b = num(first(w, ["limitMicroCents", "limit"]));
      if (a !== null && b > 0) used = (a / b) * 100;
    }
    if (used === null) return [];
    const at = first(w, ["resetsAt", "resetAt", "resets_at", "reset_at"]);
    const inSec = num(first(w, ["resetInSec", "reset_in_sec", "resetsInSec"]));
    let resets = null;
    if (at !== undefined) resets = typeof at === "number" ? (at < 1e12 ? at * 1000 : at) : Date.parse(at) || null;
    else if (inSec !== null) resets = nowMs + inSec * 1000;
    return [{ key, label, used: Math.max(0, Math.min(100, used)), resets }];
  });
}

/** A failed answer → one short line for the person. */
export function goProblem(status, body) {
  const code = body?.error?.code ?? body?.error?.type ?? "";
  if (code === "api_key_expired") return "The saved Go key has expired. Make a new key in OpenCode Console, then run opencode auth login.";
  if (status === 401 || status === 403) return "OpenCode does not accept the saved Go key. Run opencode auth login.";
  return `OpenCode answered ${status || "nothing"}${body?.error?.message ? `: ${String(body.error.message).slice(0, 80)}` : ""}.`;
}

/** One row per period: "day" (since local midnight), "week" (last 7 days). */
export const OPENCODE_SQL = (dayStartMs, weekStartMs) => `
select 'day', count(distinct session_id), coalesce(sum(json_extract(data,'$.cost')),0), coalesce(sum(json_extract(data,'$.tokens.total')),0)
  from message where time_created >= ${dayStartMs}
union all
select 'week', count(distinct session_id), coalesce(sum(json_extract(data,'$.cost')),0), coalesce(sum(json_extract(data,'$.tokens.total')),0)
  from message where time_created >= ${weekStartMs};`;

/** sqlite3 output (`|`-separated) → { day: { sessions, cost, tokens }, week: {...} }. */
export function parseOpencode(stdout) {
  const out = {};
  for (const line of String(stdout ?? "").trim().split("\n")) {
    const [period, sessions, cost, tokens] = line.split("|");
    if (period === "day" || period === "week") out[period] = { sessions: Number(sessions) || 0, cost: Number(cost) || 0, tokens: Number(tokens) || 0 };
  }
  return out.day && out.week ? out : null;
}

/** claude.json text → { at, windows: [{ key, label, used, resets }] }, dropping windows that have reset. */
export function parseClaude(text, nowMs = Date.now()) {
  let d;
  try { d = JSON.parse(text ?? ""); } catch { return null; }
  if (!d || typeof d !== "object") return null;
  const windows = [
    ["five_hour", "Session · 5 h"],
    ["seven_day", "Week"],
  ].flatMap(([key, label]) => {
    const w = d[key];
    if (!w || typeof w.used_percentage !== "number") return [];
    const resets = Number(w.resets_at) * 1000 || null;
    // Past its reset the window starts again at 0.
    if (resets && resets <= nowMs) return [{ key, label, used: 0, resets: null }];
    return [{ key, label, used: Math.max(0, Math.min(100, w.used_percentage)), resets }];
  });
  return { at: Number(d.at) || null, windows };
}

/** The level a percentage shows as: ok < 60 ≤ warn < 85 ≤ hot. */
export const level = (pct) => (pct >= 85 ? "hot" : pct >= 60 ? "warn" : "ok");

/** "in 2 h 10 m", "in 45 m", "Tue 14:00" (more than a day away). */
export function resetsIn(ms, nowMs = Date.now()) {
  if (!ms) return "";
  const m = Math.max(0, Math.round((ms - nowMs) / 60000));
  if (m < 60) return `in ${m} m`;
  if (m < 24 * 60) return `in ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ""}`;
  const d = new Date(ms);
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "just now", "4 m ago", "3 h ago", "2 d ago". */
export function ago(ms, nowMs = Date.now()) {
  if (!ms) return "never";
  const m = Math.round((nowMs - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} m ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

/** 340000 → "340k", 6100000 → "6.1M". */
export const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export const money = (n) => `$${n.toFixed(n >= 10 ? 1 : 2)}`;
