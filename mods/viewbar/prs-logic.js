// The PRs provider's decisions, pure (no Herdr imports): node tests load it.
//   what the data file says (parseData), the button and badge from it (prsBadge), and when the
//   background refresh runs (decideRefresh). The provider itself is prs.js.

export const FOCUS_FLOOR_MS = 60_000; // a terminal gets focus: refresh, but not more than once per minute
export const STAY_MS = 5 * 60_000; // while it stays focused: refresh this often
export const DISCOVER_MS = 5 * 60_000; // --discover when the last one was longer ago than this

/**
 * What the bar needs from a data file (extras/prs/FORMAT.md): { count, problems, at }, or null for a
 * missing, empty, invalid or other-version file.
 */
export function parseData(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let d;
  try { d = JSON.parse(raw); } catch { return null; }
  if (!d || typeof d !== "object" || d.version !== 1) return null;
  const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return { count: num(d.count), problems: num(d.problems), at: typeof d.at === "string" ? d.at : null };
}

/**
 * The button for an agent's data: null (no button) when there is no data or no PR; else
 * { tip } and, only when some PR has failing checks or conflicts, a red badge with their number.
 */
export function prsBadge(data) {
  if (!data || !(data.count > 0)) return null;
  const problems = data.problems > 0 ? data.problems : 0;
  const tip = `Pull requests · ${data.count} open${problems ? ` · ${problems} need attention` : ""}`;
  return problems ? { badge: { text: String(problems), tone: "ansi1" }, tip } : { tip };
}

/**
 * Whether to run `herdr-prs refresh` for the focused agent now.
 *   terminal      the agent's terminal, or null
 *   now           ms
 *   last          { start, discover } of the previous run for this terminal, or undefined
 *                 (start: when it began; discover: when a run with --discover last succeeded, or null)
 *   focusChanged  this terminal just became the focused agent
 * Returns { discover } to run, or null. Focus change: at once, but at most once per minute per
 * terminal. Staying focused: every 5 minutes.
 */
export function decideRefresh({ terminal, now, last, focusChanged }) {
  if (!terminal) return null;
  const since = last ? now - last.start : Infinity;
  if (since < (focusChanged ? FOCUS_FLOOR_MS : STAY_MS)) return null;
  const discover = !last?.discover || now - last.discover > DISCOVER_MS;
  return { discover };
}
