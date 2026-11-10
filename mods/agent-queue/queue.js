// The agent queue as plain data. Pure: plain node tests it.
//
// Three sections:
//   Queue    agents that wait for the person, top = next to handle: by kind (KINDS order),
//            then who waited longest. Kinds:
//              approve  a permission prompt is on screen (Claude's own report says so)
//              answer   a question: Claude's question tool, or the agent said so
//              blocked  can't go on because of something outside the chat
//              review   finished work to check
//              done     finished, nothing needed: only until the person looks (Herdr's
//                       "done" turns "idle" then), after that it is Quiet
//   Working  agents at work, and agents waiting on CI, a deploy or a job (kind waiting)
//   Quiet    the rest: idle with nothing asked
//
// Sources, strongest first:
//   1. Herdr's live report (terminals()[].report.msg): a permission prompt or a question on
//      screen always wins; "working" means Working, except while the agent blocks on
//      plan_review_check (declared source "plan-review"): that is review.
//   2. What the agent declared when its turn ended (declared: Map key → { kind, text, at,
//      source }), from `herdr-status` or the Stop hook's small model; forgotten when the person
//      replies (~/.claude/hooks/herdr-status.mjs).
//   3. Without either: Herdr's "done" (finished, not looked at) is review.

import { groupOf } from "./groups.js";
import { STATES } from "./pointers.js";

export const KINDS = ["approve", "answer", "blocked", "review", "done"];
export const SECTIONS = [
  { key: "queue", title: "Queue" },
  { key: "working", title: "Working" },
  { key: "quiet", title: "Quiet" },
];

const clean = (s) => String(s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+/g, " ").trim();

/** The first sentence of a report, at most `max` characters. */
export function sentence(text, max = 140) {
  const s = clean(text);
  if (!s) return "";
  const end = s.search(/(?<=[.!?])\s/);
  const one = end > 0 ? s.slice(0, end) : s;
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** The file name a terminal's declared status has (herdr-status.mjs). */
export const statusKey = (address) => String(address).replace(/[^\w.-]/g, "_");

/** What one agent needs: { section, kind, why, since }. */
export function classify(native, msg, declared, changedAt) {
  const m = String(msg ?? "");
  if (native === "blocked" && /permission/i.test(m)) return { section: "queue", kind: "approve", why: m.replace(/^Claude needs your permission to use\s*/i, ""), since: changedAt };
  if (native === "blocked" && /question/i.test(m)) return { section: "queue", kind: "answer", why: declared?.kind === "answer" ? declared.text : m, since: declared?.at ?? changedAt };
  // A blocking plan_review_check looks like work to Herdr, but the agent waits for the person.
  if (declared?.source === "plan-review") return { section: "queue", kind: "review", why: declared.text, since: declared.at };
  if (native === "working") return { section: "working", kind: null, why: m, since: changedAt };
  if (declared &&(KINDS.includes(declared.kind) || declared.kind === "waiting")) {
    if (declared.kind === "waiting") return { section: "working", kind: "waiting", why: declared.text, since: declared.at };
    if (declared.kind === "done" && native !== "done") return { section: "quiet", kind: "done", why: declared.text, since: declared.at };
    return { section: "queue", kind: declared.kind, why: declared.text, since: declared.at };
  }
  if (native === "done" || native === "blocked") return { section: "queue", kind: "review", why: m, since: changedAt };
  return { section: "quiet", kind: null, why: m, since: changedAt };
}

/**
 * agents, terminals, changed (stamp), declared → [{ key, title, items }], empty sections left out.
 * Queue: kind order, then longest wait first (an unknown wait goes last in its kind).
 * Working and Quiet: newest change first.
 */
export function buildQueue(agents, terminals, changed = new Map(), declared = new Map()) {
  const byAddress = new Map((terminals ?? []).map((t) => [t.address, t]));
  const helpers = new Map();
  for (const t of terminals ?? []) if (t.parent && t.state !== "finished") helpers.set(t.parent, (helpers.get(t.parent) ?? 0) + 1);
  const items = (agents ?? []).map((a) => {
    const t = byAddress.get(a.address) ?? {};
    const program = a.program?.name ?? a.app ?? "agent";
    // A title that is a folder (a shell's prompt) says nothing about the task.
    const title = /^\s*[~/]/.test(a.title ?? "") ? "" : clean(a.title);
    const c = classify(a.status, t.report?.msg ?? t.status?.msg ?? t.msg, declared.get(statusKey(a.address)), Number(t.status_ms) || changed.get(a.address)?.at || null);
    return {
      address: a.address,
      status: a.status,
      section: c.section,
      kind: c.kind,
      why: sentence(c.why),
      since: c.since ?? null,
      task: title && title !== program ? title : clean(a.tab_name) && !/^\d+$/.test(a.tab_name) ? clean(a.tab_name) : program,
      space: a.space_name ?? "",
      spaceId: a.space ?? null,
      tabId: a.tab ?? null,
      program: a.program ?? null,
      helpers: helpers.get(a.address) ?? 0,
      focused: Boolean(a.focused),
    };
  });
  const rank = (i) => KINDS.indexOf(i.kind);
  const waitedLongest = (x, y) => (x.since ?? Infinity) - (y.since ?? Infinity);
  const newest = (x, y) => (y.since ?? 0) - (x.since ?? 0);
  return SECTIONS.map((s) => {
    const mine = items.filter((i) => i.section === s.key);
    mine.sort(s.key === "queue" ? (x, y) => rank(x) - rank(y) || waitedLongest(x, y) : newest);
    return { ...s, items: mine };
  }).filter((s) => s.items.length);
}

/** Where a space is, as the spaces-flat sidebar groups it: its first terminal's live folder, else its folder. */
export function place(space, panes) {
  const tabs = new Set((space.tabs ?? []).map((c) => c.id));
  return (panes ?? []).find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder;
}

/**
 * Only the agents in the shown space's group (space-groups: Work, Personal, your folders, Other).
 * spaces, panes: Herdr's; config, manual: groups.js parseConfig / parseManual.
 * → { group: name | null, mine: agents, groupOfSpace: Map spaceId → name }
 * No groups set up, or no shown space: group null, every agent.
 */
export function scope(agents, spaces, panes, config, manual) {
  const all = agents ?? [];
  const groupOfSpace = new Map((spaces ?? []).map((s) => [s.id, groupOf({ id: s.id, folder: place(s, panes) }, config, manual).name]));
  const shown = (spaces ?? []).find((s) => s.active);
  if (!shown || (!config.groups.length && !manual.folders.length)) return { group: null, mine: all, groupOfSpace };
  const group = groupOfSpace.get(shown.id);
  return { group, mine: all.filter((a) => groupOfSpace.get(a.space) === group), groupOfSpace };
}

/** Agents of the other groups that wait for you: built queue sections → [{ name, n }], most first. */
export function elsewhere(sections, groupOfSpace) {
  const n = new Map();
  for (const i of sections.find((s) => s.key === "queue")?.items ?? []) {
    const name = groupOfSpace.get(i.spaceId);
    if (name) n.set(name, (n.get(name) ?? 0) + 1);
  }
  return [...n].map(([name, count]) => ({ name, n: count })).sort((x, y) => y.n - x.n);
}

/** A declared "waiting" stops keeping the Mac awake after this: nothing clears it if the job never reports back. */
export const WAITING_AWAKE_MS = 3 * 60 * 60 * 1000;

/** Should the Mac stay awake? Any agent at work, or waiting on a job since less than WAITING_AWAKE_MS. */
export function keepsAwake(sections, nowMs = Date.now()) {
  const working = sections.find((s) => s.key === "working")?.items ?? [];
  return working.some((i) => i.kind !== "waiting" || nowMs - (i.since ?? 0) < WAITING_AWAKE_MS);
}

/** "12 s", "4 m", "3 h", "2 d". */
export function since(ms, nowMs = Date.now()) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} m` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} d`;
}

/**
 * When each agent's status last changed, as this copy saw it: Herdr's mod API leaves
 * status_ms empty. Agents already there at the first look have no time (at: null).
 * memo: Map address → { status, at }; updated in place and returned.
 */
export function stamp(memo, agents, nowMs = Date.now()) {
  const live = new Set();
  // Agents there at the first look have no known start; any that come later start now.
  const first = !memo.started;
  memo.started = true;
  for (const a of agents ?? []) {
    live.add(a.address);
    const m = memo.get(a.address);
    if (!m) memo.set(a.address, { status: a.status, at: first ? null : nowMs });
    else if (m.status !== a.status) memo.set(a.address, { status: a.status, at: nowMs });
  }
  for (const k of memo.keys()) if (!live.has(k)) memo.delete(k);
  return memo;
}

/** The declared-status folder's dump (`name<TAB>json` lines) → Map key → status. */
export function parseDeclared(stdout) {
  const out = new Map();
  for (const line of String(stdout ?? "").split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    try { out.set(line.slice(0, tab).replace(/\.json$/, ""), JSON.parse(line.slice(tab + 1))); } catch {}
  }
  return out;
}

// ---- plans -----------------------------------------------------------------------------------------
// An agent whose plan was submitted to agent-plan-review (pointers.js) gets a chip on its row. Its
// colour is the plan's state; a click goes to the agent and shows its plan (the view bar's flip).

/** An approved plan's chip goes away this long after the approval: after that it is only noise. */
export const APPROVED_CHIP_MS = 10 * 60 * 1000;

/**
 * The chip for a plan pointer: { label, color (theme name), tip }, or null without a plan.
 * An approved plan has no chip once APPROVED_CHIP_MS passed since its updatedAt (the decision);
 * without a readable time the chip stays. The view bar still opens the plan.
 */
export function planChip(pointer, nowMs = Date.now()) {
  const st = pointer && STATES[pointer.status];
  if (!st) return null;
  if (pointer.status === "approved") {
    const at = Date.parse(pointer.updatedAt ?? "");
    if (Number.isFinite(at) && nowMs - at >= APPROVED_CHIP_MS) return null;
  }
  return { label: st.short.toUpperCase(), color: st.color, tip: `Plan ${st.label}${pointer.title ? ` · ${pointer.title}` : ""} · click to open` };
}

/** Whether a layout tree has the stack that flips between the agent and its plan. */
export function hasStack(tree, id = "main-stack") {
  if (!tree || typeof tree !== "object") return false;
  return tree.id === id || (tree.children ?? []).some((c) => hasStack(c, id));
}
