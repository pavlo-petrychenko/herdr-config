// The PRs panel's button and badge. The panel itself is the `prs` mod (mods/prs), a block of the
// side column's stack ("side-prs" in the main-flat layout); this file only decides whether the
// button shows and keeps the data fresh while an agent is focused.
//
// Data: <app home>/data/prs/<terminal>.json (extras/prs/FORMAT.md), made by `herdr-prs refresh`.
// One background loop (init), one `exec` at a time:
//   - reads the focused agent's file when the agent changes, and when the PRs view says it
//     refreshed (shared "prs.updated", polled each tick: no folder watch)
//   - runs `herdr-prs refresh <terminal>` when an agent gets focus and every 5 minutes while it
//     stays focused (decideRefresh); the CLI's own lock handles overlap with the PRs view
//   - redraws the bar (cx.notify) when what the button shows changed
// Errors are ignored: the last data stays, and the loop waits before it tries again.

import { agents, focused, shared, appHome, exec, readTextFile } from "herdr";
import { currentAgent } from "./logic.js";
import { parseData, prsBadge, decideRefresh } from "./prs-logic.js";

const TICK_MS = 2000;
const RETRY_MS = 15000;
const EXEC_MS = 28000; // Herdr stops an exec at 30 s
const UPDATED = "prs.updated"; // shared by the PRs mod: { terminal, at }

const DATA = new Map(); // terminal -> { count, problems, at }
const RAW = new Map(); // terminal -> the file's text, to see a change
const RUNS = new Map(); // terminal -> { start, discover } of the last refresh
const LAST = (globalThis.__viewbarLast ??= {}); // tab -> the agent last focused there (the bar's own)

const sleep = (cx, ms) => new Promise((done) => cx.timer.after(ms, done));

// The agent the bar is about (the same pick as the bar's).
function agentNow() {
  const f = focused();
  const list = agents();
  if (f?.terminal && list.some((a) => a.address === f.terminal && a.tab === f.tab)) LAST[f.tab] = f.terminal;
  return currentAgent(list, f, LAST);
}

// Read one terminal's file into the cache. Returns whether what the bar shows changed.
async function load(terminal) {
  if (!terminal) return false;
  let raw = null;
  try { raw = await readTextFile(`${appHome()}/data/prs/${terminal}.json`); } catch { raw = null; }
  if (raw === (RAW.get(terminal) ?? null)) return false;
  RAW.set(terminal, raw);
  const before = JSON.stringify(DATA.get(terminal) ?? null);
  const data = parseData(raw);
  if (data) DATA.set(terminal, data); else DATA.delete(terminal);
  return JSON.stringify(data ?? null) !== before;
}

async function cliPath() {
  try {
    const cli = JSON.parse(await readTextFile(`${appHome()}/mods/prs/config.json`))?.cli;
    if (typeof cli === "string" && cli.trim()) return cli.trim();
  } catch {}
  return "herdr-prs";
}

// `herdr-prs refresh`, with this app's home so it writes where we read.
async function refresh(terminal, discover) {
  const run = { start: Date.now(), discover: RUNS.get(terminal)?.discover ?? null };
  RUNS.set(terminal, run);
  const cli = await cliPath();
  const r = await exec("/usr/bin/env", [`HERDR_APP_HOME=${appHome()}`, cli, "refresh", terminal, ...(discover ? ["--discover"] : [])], { timeout: EXEC_MS });
  if (r?.code === 0 && discover) run.discover = Date.now();
}

export const prs = {
  kind: "prs", title: "Pull requests", icon: "mods/viewbar/icons/prs.svg",
  child: "side-prs", focus: "prs.focus",

  init(cx) {
    cx.spawn(async (cx) => {
      let terminal = null;
      let updated = null;
      for (;;) {
        let wait = TICK_MS;
        try {
          const agent = agentNow();
          const next = agent?.address ?? null;
          const focusChanged = next !== terminal;
          terminal = next;
          let changed = false;
          if (focusChanged) changed = (await load(terminal)) || changed;
          const u = shared(UPDATED);
          const key = u ? `${u.terminal}@${u.at}` : null;
          if (key !== updated) {
            updated = key;
            if (u?.terminal && !(focusChanged && u.terminal === terminal)) changed = (await load(u.terminal)) || changed;
          }
          const plan = decideRefresh({ terminal, now: Date.now(), last: RUNS.get(terminal), focusChanged });
          if (plan) {
            await refresh(terminal, plan.discover);
            changed = (await load(terminal)) || changed;
          }
          if (changed) cx.notify();
        } catch {
          wait = RETRY_MS;
        }
        await sleep(cx, wait);
      }
    });
  },

  available: ({ terminal }) => prsBadge(DATA.get(terminal)),
  body: () => [],
};
