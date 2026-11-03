// Space groups as plain data. Pure: plain node tests it. The spaces-flat sidebar has a copy
// (spaces-flat-patch.py copies this file there: a mod cannot import another mod's files).
//
// Two sources, in this order:
//   1. Rules: <appHome>/space-groups.json, { groups: [{ name, folders: [pattern] }] }. A space
//      goes to the first group with a pattern matching where it is.
//   2. Your folders: shared("space.groups") = { folders: [name], of: { spaceId: name } }. A space
//      you moved to a group stays there, whatever the rules say; your own folders show even
//      when empty.
// Spaces that match nothing go to "Other".

export const CONFIG_FILE = "space-groups.json";
export const SHARED_KEY = "space.groups";
export const OTHER = "Other";

export function parseConfig(text, home) {
  let d;
  try { d = JSON.parse(text ?? ""); } catch { return { groups: [] }; }
  const groups = (Array.isArray(d?.groups) ? d.groups : [])
    .filter((g) => g && typeof g.name === "string" && g.name.trim())
    .map((g) => ({ name: g.name.trim(), folders: (Array.isArray(g.folders) ? g.folders : []).filter((f) => typeof f === "string").map((f) => f.replace(/^~(?=\/|$)/, home).replace(/\/+$/, "")) }));
  return { groups };
}

/** `/a/b/**`: /a/b and under; `/a/b/*`: direct subfolders; else that folder only. */
export function matches(pattern, folder) {
  if (!folder) return false;
  const f = folder.replace(/\/+$/, "");
  if (pattern.endsWith("/**")) { const base = pattern.slice(0, -3); return f === base || f.startsWith(`${base}/`); }
  if (pattern.endsWith("/*")) { const base = pattern.slice(0, -2); return f.startsWith(`${base}/`) && !f.slice(base.length + 1).includes("/"); }
  return f === pattern;
}

export function parseManual(value) {
  const v = value && typeof value === "object" ? value : {};
  return { folders: Array.isArray(v.folders) ? v.folders.filter((x) => typeof x === "string") : [], of: v.of && typeof v.of === "object" ? { ...v.of } : {} };
}

/** The group a space is in, and why: "moved" (you put it there) or "rule". */
export function groupOf(space, config, manual) {
  const moved = manual.of[space.id];
  const names = new Set([...config.groups.map((g) => g.name), ...manual.folders]);
  if (moved && names.has(moved)) return { name: moved, why: "moved" };
  const rule = config.groups.find((g) => g.folders.some((p) => matches(p, space.folder)));
  return rule ? { name: rule.name, why: "rule" } : { name: OTHER, why: "rule" };
}

/**
 * spaces: [{ id, folder }] in sidebar order → [{ name, mine: boolean (your folder), ids }]
 * Rule groups (when not empty), then your folders (always), then Other (when not empty).
 * With no groups at all: one group named null holding every space.
 */
export function assign(spaces, config, manual) {
  const names = [...config.groups.map((g) => g.name), ...manual.folders.filter((n) => !config.groups.some((g) => g.name === n))];
  if (!names.length) return [{ name: null, mine: false, ids: spaces.map((s) => s.id) }];
  const ids = new Map([...names, OTHER].map((n) => [n, []]));
  for (const s of spaces) ids.get(groupOf(s, config, manual).name)?.push(s.id);
  return [...names, OTHER]
    .map((name) => ({ name, mine: manual.folders.includes(name) && !config.groups.some((g) => g.name === name), ids: ids.get(name) }))
    .filter((g) => g.mine || g.ids.length);
}

/** Changes to your folders. Each returns a new manual state. */
export const move = (manual, spaceId, name) => {
  const of = { ...manual.of };
  if (name) of[spaceId] = name; else delete of[spaceId];
  return { ...manual, of };
};
export const addFolder = (manual, name) => {
  const n = String(name ?? "").trim();
  return !n || n === OTHER || manual.folders.includes(n) ? manual : { ...manual, folders: [...manual.folders, n] };
};
export const removeFolder = (manual, name) => ({
  folders: manual.folders.filter((n) => n !== name),
  of: Object.fromEntries(Object.entries(manual.of).filter(([, n]) => n !== name)),
});
export const renameFolder = (manual, from, to) => {
  const n = String(to ?? "").trim();
  if (!n || n === OTHER || manual.folders.includes(n)) return manual;
  return { folders: manual.folders.map((x) => (x === from ? n : x)), of: Object.fromEntries(Object.entries(manual.of).map(([id, x]) => [id, x === from ? n : x])) };
};
/** Forgets spaces that are gone. */
export const prune = (manual, liveIds) => ({ ...manual, of: Object.fromEntries(Object.entries(manual.of).filter(([id]) => liveIds.has(id))) });
