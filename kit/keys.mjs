// keys.json: add the kit's keys to the person's file, and take them out again.
// A key the person already binds to something else is a clash: theirs stays unless they say so.
import { deepEqual } from "./util.mjs";

/** kit/keys.json limited to the given [section, key] pairs: [{ section, key, action }]. */
export function wantedKeys(kitKeys, pairs) {
  return pairs
    .filter(([s, k]) => kitKeys[s]?.[k] !== undefined)
    .map(([section, key]) => ({ section, key, action: kitKeys[section][key] }));
}

/** Sorts wanted keys against the person's keys.json: { add, same, clashes: [{ ..., theirs }] }. */
export function planKeys(current, wanted) {
  const add = [], same = [], clashes = [];
  for (const w of wanted) {
    const theirs = current?.[w.section]?.[w.key];
    if (theirs === undefined) add.push(w);
    else if (deepEqual(theirs, w.action)) same.push(w);
    else clashes.push({ ...w, theirs });
  }
  return { add, same, clashes };
}

/**
 * Adds keys to a copy of `current`. Each entry may carry `theirs` (a clash the person chose to
 * replace). Returns { next, added: [{ section, key, action, newSection, replaced? }] }.
 */
export function applyKeys(current, entries) {
  const next = structuredClone(current ?? {});
  const added = [];
  for (const e of entries) {
    const newSection = next[e.section] === undefined;
    next[e.section] ??= {};
    const rec = { section: e.section, key: e.key, action: e.action, newSection };
    if (e.theirs !== undefined) rec.replaced = e.theirs;
    next[e.section][e.key] = e.action;
    added.push(rec);
  }
  return { next, added };
}

/**
 * Takes the kit's keys out of a copy of `current`. A key the person changed since is left alone
 * (`kept`). A replaced key gets the person's old action back. A section the kit made goes when empty.
 */
export function removeKeys(current, added) {
  const next = structuredClone(current ?? {});
  const kept = [];
  for (const a of added) {
    const now = next[a.section]?.[a.key];
    if (now === undefined) continue;
    if (!deepEqual(now, a.action)) { kept.push({ ...a, now }); continue; }
    if (a.replaced !== undefined) next[a.section][a.key] = a.replaced;
    else delete next[a.section][a.key];
    if (a.newSection && Object.keys(next[a.section]).length === 0) delete next[a.section];
  }
  return { next, kept };
}

export const formatAction = (a) => (typeof a === "string" ? a : JSON.stringify(a));
