// Which plan belongs to which agent: the agent-plan-review pointer files. Pure (no Herdr imports),
// so node tests load it.
//
// agent-plan-review (`agent-plan-review herdr enable`) writes one pointer file per agent terminal,
// <app home>/data/plan-review/<terminal>.json, on every submit, reply, resolve and decision:
//   { reviewId, projectKey, version, status, title, cwd, updatedAt, server? }
// A terminal's pointer always names its newest review.
//
// A mod imports only its own files, so mods/agent-queue/pointers.js is a copy of this file.
// viewbar's tests fail when the two differ. Edit this one, then copy it over the other.

export const POINTER_DIR = "data/plan-review";

/** What a plan's status says, and the theme colour for it. */
export const STATES = {
  pending: { label: "waiting for review", short: "Plan", color: "ansi3" },
  approved: { label: "approved", short: "Approved", color: "ansi2" },
  rejected: { label: "changes requested", short: "Changes", color: "ansi1" },
};

const TERMINAL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A pointer file's text -> the pointer, or null when it is not one. */
export function parsePointer(text) {
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== "object") return null;
  if (typeof v.reviewId !== "string" || !v.reviewId || typeof v.projectKey !== "string" || !v.projectKey) return null;
  const version = Number(v.version);
  if (!Number.isInteger(version) || version < 1) return null;
  return {
    reviewId: v.reviewId,
    projectKey: v.projectKey,
    version,
    status: STATES[v.status] ? v.status : "pending",
    title: typeof v.title === "string" ? v.title : "Plan",
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
  };
}

/** The terminal a pointer file is for ("…/data/plan-review/t3.json" -> "t3"), or null. */
export function terminalOfFile(path) {
  const m = /\/([^/]+)\.json$/.exec(String(path));
  return m && TERMINAL_RE.test(m[1]) ? m[1] : null;
}

/** Whether a changed path (from watchFolder) may change the pointers. */
export function touchesPointers(path, dir) {
  if (path === dir || path === `${dir}/`) return true;
  if (!String(path).startsWith(`${dir}/`)) return false;
  const rest = path.slice(dir.length + 1);
  return !rest.includes("/") && rest.endsWith(".json");
}

/**
 * The plan the plan view shows for the focused place: the focused terminal's pointer, else the
 * pointer of another terminal in the focused tab (pane order), exactly as the plan-review mod
 * picks it. `pointers`: Map(terminal -> pointer). Returns { terminal, pointer } or null.
 */
export function planFor(pointers, focused, panes) {
  if (!focused) return null;
  const own = focused.terminal && pointers.get(focused.terminal);
  if (own) return { terminal: focused.terminal, pointer: own };
  for (const p of panes ?? []) {
    if (p.tab !== focused.tab || !p.terminal) continue;
    const e = pointers.get(p.terminal);
    if (e) return { terminal: p.terminal, pointer: e };
  }
  return null;
}

/**
 * The plan of one agent: its own pointer, else that of another terminal in its tab.
 * Used where no terminal is focused (the agent queue's rows). Returns { terminal, pointer } or null.
 */
export function planOfAgent(pointers, agent, panes) {
  if (!agent) return null;
  return planFor(pointers, { terminal: agent.address, tab: agent.tab }, panes);
}
