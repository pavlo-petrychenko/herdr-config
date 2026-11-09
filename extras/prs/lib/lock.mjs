// A lock per terminal for `refresh`: <home>/data/prs/<terminal>.lock holds { pid, at }.
// The view and the view bar both run the command; one run at a time saves GitHub calls.
// A run that finds a live lock (its process exists and it is under 60 s old) waits up to 15 s for it to go,
// then exits without refreshing: the other run wrote the file.
import fs from "node:fs";
import path from "node:path";

export const LOCK_STALE_MS = 60000;
export const LOCK_WAIT_MS = 15000;
const POLL_MS = 200;

export const lockFile = (dataFile) => dataFile.replace(/\.json$/, ".lock");

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

/** The lock's holder if it still counts ({ pid, at }), else null. */
export function liveLock(file, { now = Date.now, alive = pidAlive } = {}) {
  let held;
  try { held = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  if (!Number.isInteger(held?.pid) || !Number.isFinite(held?.at)) return null; // unreadable: nobody's
  if (now() - held.at >= LOCK_STALE_MS || now() - held.at < -LOCK_STALE_MS) return null;
  return alive(held.pid) ? held : null;
}

function tryTake(file, { pid, now }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, JSON.stringify({ pid, at: now() }), { flag: "wx" });
    return true;
  } catch (e) {
    if (e?.code !== "EEXIST") throw e;
    return false;
  }
}

/**
 * Runs fn() holding the lock. Returns { ran: true, value } or { ran: false } when another live run held it
 * for the whole wait. Never throws for lock trouble (a read-only folder): then fn runs without a lock.
 */
export async function withLock(file, fn, { pid = process.pid, now = Date.now, alive = pidAlive, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), waitMs = LOCK_WAIT_MS } = {}) {
  const t0 = now();
  let waited = false;
  for (;;) {
    const held = liveLock(file, { now, alive });
    if (!held) {
      if (waited && !fs.existsSync(file)) return { ran: false }; // it finished and let go: its file is fresh
      try { fs.unlinkSync(file); } catch {} // no lock, or a dead or old one
      let took = false;
      try { took = tryTake(file, { pid, now }); } catch { return { ran: true, value: await fn() }; }
      if (took) break;
      continue; // lost a race: look again
    }
    if (now() - t0 >= waitMs) return { ran: false };
    waited = true;
    await sleep(POLL_MS);
  }
  try {
    return { ran: true, value: await fn() };
  } finally {
    try {
      const mine = JSON.parse(fs.readFileSync(file, "utf8"));
      if (mine?.pid === pid) fs.unlinkSync(file);
    } catch {}
  }
}
