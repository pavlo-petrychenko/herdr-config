// The Herdr side of the kit: mods, the flat sidebar, keys, starter config, the Plan view.
// plan() decides and changes nothing; apply() does it and fills the manifest; uninstall() and
// doctor() read only the manifest. Later steps add modules like this one for `claude` and `tools`.
import fs from "node:fs";
import path from "node:path";
import { herdrApp, windowStatus } from "./home.mjs";
import { applyKeys, planKeys, removeKeys, wantedKeys } from "./keys.mjs";
import { FLAT_LAYOUT, FLAT_MOD, HERDR_WRITTEN, buildFlat, flatFiles } from "./layout.mjs";
import { backupFile } from "./manifest.mjs";
import { byId } from "./pieces.mjs";
import { hashFile, readJson, run, stamp, walk, writeAtomic, writeJson } from "./util.mjs";

const KEYS = "keys.json";

/** The files of a mod in this package, as paths in the home ("mods/x/main.js"); no tests. */
export function modFiles(pkgDir, name) {
  const skip = (rel, isDir) =>
    (isDir && rel === "test") || rel === ".DS_Store" || rel.endsWith("/.DS_Store") ||
    rel.endsWith(".d.ts") || (name === "prs" && rel === "config.json");
  return walk(path.join(pkgDir, "mods", name), skip).map((f) => `mods/${name}/${f}`);
}

const hashIn = (home, rel) => hashFile(path.join(home, rel));
const pick = (ids, field) => ids.flatMap((id) => byId(id)?.herdr?.[field] ?? []);
const has = (ids, flag) => ids.some((id) => byId(id)?.herdr?.[flag]);

/** The starter space-groups.json: the "// how" text and one "Work" group for the given folders. */
export function spaceGroupsConfig(pkgDir, workFolders = []) {
  const base = readJson(path.join(pkgDir, "kit", "defaults", "space-groups.json"));
  const folders = workFolders.map((f) => f.trim().replace(/\/+$/, "")).filter(Boolean).map((f) => (f.endsWith("*") ? f : `${f}/**`));
  return { ...base, groups: folders.length ? [{ name: "Work", folders }] : [] };
}

/**
 * Decides what setup or update would do. Changes nothing.
 * ids: pieces to install (all of them: the new ones and those already in the manifest).
 * Returns { conflicts, writes, keep, remove, config, build, buildSkip, keys, planView, mods }.
 */
export function plan(ctx, ids, manifest) {
  const home = ctx.home;
  const m = manifest.herdr;
  const mods = pick(ids, "mods");
  const conflicts = [];
  const shipped = readJson(path.join(home, "installed.json"), {});
  for (const name of [...mods, ...(has(ids, "build") ? [FLAT_MOD] : [])]) {
    if (m.mods.includes(name)) continue;
    if (shipped[name]) conflicts.push(`mods/${name} is one of Herdr's own mods`);
    else if (fs.existsSync(path.join(home, "mods", name))) conflicts.push(`mods/${name} is already there and the kit did not put it there`);
  }
  if (has(ids, "build") && !m.layouts.includes(FLAT_LAYOUT)) {
    if (shipped[`layout:${FLAT_LAYOUT}`]) conflicts.push(`layouts/${FLAT_LAYOUT}.json is one of Herdr's own layouts`);
    else if (fs.existsSync(path.join(home, "layouts", `${FLAT_LAYOUT}.json`))) conflicts.push(`layouts/${FLAT_LAYOUT}.json is already there and the kit did not put it there`);
  }

  // Mod files: write new ones, replace the kit's own unchanged ones, keep what the person changed.
  const writes = [], keep = [], remove = [];
  for (const name of mods) {
    const files = modFiles(ctx.pkgDir, name);
    for (const rel of files) {
      const now = hashIn(home, rel);
      const src = hashFile(path.join(ctx.pkgDir, rel));
      if (now === null) writes.push(rel);
      else if (now === src) continue;
      else if (m.files[rel] && now === m.files[rel]) writes.push(rel);
      else keep.push(rel);
    }
    // Files an older version had and this one does not.
    for (const rel of Object.keys(m.files)) {
      if (!rel.startsWith(`mods/${name}/`) || files.includes(rel)) continue;
      if (hashIn(home, rel) === m.files[rel]) remove.push(rel);
    }
  }

  const config = pick(ids, "config").filter((c) => !fs.existsSync(path.join(home, c)));

  // The flat sidebar: rebuilt only when every file of it is still as the kit made it.
  let build = has(ids, "build");
  let buildSkip = null;
  if (build && m.mods.includes(FLAT_MOD)) {
    const changed = flatFiles(home).filter((rel) => hashIn(home, rel) !== m.files[rel]);
    if (changed.length) { build = false; buildSkip = changed; }
  }

  const kitKeys = readJson(path.join(ctx.pkgDir, "kit", "keys.json"), {});
  const current = readJson(path.join(home, KEYS), {});
  const keys = planKeys(current, wantedKeys(kitKeys, pick(ids, "keys")));

  return { conflicts, writes, keep, remove, config, build, buildSkip, keys, planView: has(ids, "planView"), mods, ids };
}

/**
 * Does what plan() decided. answers: { workFolders: [string], takeKeys: ["section key"] }.
 * Fills manifest.herdr and returns { notes: [string], flat: { ok, error, version } | null }.
 */
export function apply(ctx, p, manifest, answers = {}) {
  const home = ctx.home;
  const m = manifest.herdr;
  const notes = [];
  const when = stamp();
  const madeDir = (rel) => {
    const parts = rel.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      if (!fs.existsSync(path.join(home, d))) {
        fs.mkdirSync(path.join(home, d));
        if (!m.dirs.includes(d)) m.dirs.push(d);
      }
    }
  };

  // 1. Mod files.
  for (const name of p.mods) if (!m.mods.includes(name)) m.mods.push(name);
  for (const rel of p.writes) {
    madeDir(rel);
    writeAtomic(path.join(home, rel), fs.readFileSync(path.join(ctx.pkgDir, rel)));
    m.files[rel] = hashIn(home, rel);
  }
  for (const rel of p.mods.flatMap((n) => modFiles(ctx.pkgDir, n))) {
    if (!p.keep.includes(rel)) m.files[rel] = hashIn(home, rel);
  }
  for (const rel of p.remove) { fs.rmSync(path.join(home, rel), { force: true }); delete m.files[rel]; }
  for (const rel of p.keep) notes.push(`Kept ${rel}: you changed it, so the kit did not replace it.`);

  // 2. Starter config, only where there is none.
  for (const c of p.config) {
    const data = c === "space-groups.json"
      ? JSON.stringify(spaceGroupsConfig(ctx.pkgDir, answers.workFolders), null, 2) + "\n"
      : fs.readFileSync(path.join(ctx.pkgDir, "kit", "defaults", c));
    writeAtomic(path.join(home, c), data);
    m.files[c] = hashIn(home, c);
  }

  // 3. The Plan view (before the flat sidebar, so main-flat keeps its plan block).
  if (p.planView) {
    const env = { ...ctx.env, HERDR_APP_HOME: home };
    const status = run("agent-plan-review", ["herdr", "status"], { env });
    const wasEnabled = /integration:\s*enabled/i.test(status.out);
    const hadMod = fs.existsSync(path.join(home, "mods", "plan-review"));
    const en = run("agent-plan-review", ["herdr", "enable"], { env });
    const ins = run("agent-plan-review", ["herdr", "install"], { env });
    m.plan = {
      installedMod: Boolean(m.plan?.installedMod || (!hadMod && ins.code === 0)),
      enabled: Boolean(m.plan?.enabled || (!wasEnabled && en.code === 0)),
    };
    if (en.code !== 0 || ins.code !== 0) notes.push(`agent-plan-review failed: ${(en.err || ins.err || en.out || ins.out).trim()}`);
  }

  // 4. The flat sidebar.
  let flat = null;
  if (p.build) {
    const plan = fs.existsSync(path.join(home, "mods", "plan-review"));
    flat = buildFlat(ctx, { viewbar: p.ids.includes("viewbar"), prs: p.ids.includes("prs"), plan });
    if (flat.ok) {
      if (!m.mods.includes(FLAT_MOD)) m.mods.push(FLAT_MOD);
      if (!m.layouts.includes(FLAT_LAYOUT)) m.layouts.push(FLAT_LAYOUT);
      for (const rel of Object.keys(m.files)) if (rel.startsWith(`mods/${FLAT_MOD}/`)) delete m.files[rel];
      for (const rel of flatFiles(home)) m.files[rel] = hashIn(home, rel);
      if (!m.dirs.includes(`mods/${FLAT_MOD}`)) m.dirs.push(`mods/${FLAT_MOD}`);
      // The patch writes groups.js into agent-queue too.
      if (m.files["mods/agent-queue/groups.js"]) m.files["mods/agent-queue/groups.js"] = hashIn(home, "mods/agent-queue/groups.js");
    }
  } else if (p.buildSkip) {
    notes.push(`The flat sidebar was not rebuilt: you changed ${p.buildSkip.join(", ")}.`);
  }

  // 5. Keys.
  const take = new Set(answers.takeKeys ?? []);
  const entries = [...p.keys.add, ...p.keys.clashes.filter((c) => take.has(`${c.section} ${c.key}`))];
  if (entries.length) {
    const file = path.join(home, KEYS);
    const current = readJson(file, {});
    const existed = fs.existsSync(file);
    const before = hashFile(file);
    if (existed) {
      const backup = backupFile(file, when);
      m.backups.push({ file, backup });
      // The first backup goes back whole on uninstall, while nobody else changed the file.
      if (!m.keys.backup) { m.keys.backup = backup; m.keys.restorable = true; }
      else if (before !== m.keys.after) m.keys.restorable = false;
    } else if (m.keys.after && before !== m.keys.after) m.keys.restorable = false;
    const { next, added } = applyKeys(current, entries);
    writeJson(file, next);
    m.keys.after = hashFile(file);
    m.keys.added.push(...added);
  }

  // 6. Check every mod the kit put in.
  for (const name of m.mods) {
    const r = herdrApp(ctx, ["check", path.join(home, "mods", name)]);
    if (r.code !== 0) notes.push(`herdr-app check mods/${name} failed: ${(r.err || r.out).trim()}`);
  }
  return { notes, flat };
}

/** Takes the kit's Herdr files out. Returns notes (what was kept and why). */
export function uninstall(ctx, manifest, { purge = false } = {}) {
  const home = ctx.home;
  const m = manifest.herdr;
  const notes = [];

  if (windowStatus(ctx)?.layout === FLAT_LAYOUT) herdrApp(ctx, ["do", "layout.switch", JSON.stringify({ name: "main" })]);

  if (m.plan?.installedMod || m.plan?.enabled) {
    const env = { ...ctx.env, HERDR_APP_HOME: home };
    if (m.plan.installedMod) run("agent-plan-review", ["herdr", "uninstall"], { env });
    if (m.plan.enabled) run("agent-plan-review", ["herdr", "disable"], { env });
  }

  for (const [rel, hash] of Object.entries(m.files)) {
    const now = hashIn(home, rel);
    if (now === null) continue;
    if (now === hash) fs.rmSync(path.join(home, rel));
    else notes.push(`Kept ${rel}: you changed it after the install.`);
  }
  for (const name of m.mods) {
    const dir = path.join(home, "mods", name);
    if (!fs.existsSync(dir)) continue;
    for (const f of HERDR_WRITTEN) fs.rmSync(path.join(dir, f), { force: true });
  }
  const dirs = [...m.dirs].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const d of dirs) {
    try { fs.rmdirSync(path.join(home, d)); } catch (e) {
      if (e.code === "ENOTEMPTY" || e.code === "EEXIST") notes.push(`Kept ${d}/: it holds files the kit did not put there.`);
    }
  }

  // Keys: the backup goes back whole when nobody changed keys.json since; else only the kit's keys go.
  const file = path.join(home, KEYS);
  if (m.keys.added.length) {
    if (m.keys.restorable && m.keys.backup && fs.existsSync(m.keys.backup) && hashFile(file) === m.keys.after) {
      fs.renameSync(m.keys.backup, file);
    } else if (fs.existsSync(file)) {
      const current = readJson(file, null);
      if (current === null) notes.push(`${KEYS} is not valid JSON; take the kit's keys out by hand.`);
      else {
        const { next, kept } = removeKeys(current, m.keys.added);
        const backup = backupFile(file, stamp());
        writeJson(file, next);
        notes.push(`${KEYS} changed since the install: only the kit's keys were taken out (copy before: ${path.basename(backup)}).`);
        for (const k of kept) notes.push(`Kept key ${k.key} in "${k.section}": you changed it.`);
      }
    }
  }
  for (const b of m.backups) if (fs.existsSync(b.backup) && b.backup !== m.keys.backup) notes.push(`Backup kept: ${b.backup}`);

  // Data: the folders the pieces write, and the one Herdr makes for each mod (data/<mod>).
  // Without --purge only empty ones go.
  const data = new Set([
    ...manifest.pieces.flatMap((id) => byId(id)?.herdr?.data ?? []),
    ...m.mods, ...(m.plan?.installedMod ? ["plan-review"] : []),
  ]);
  for (const d of data) {
    const dir = path.join(home, "data", d);
    if (purge) fs.rmSync(dir, { recursive: true, force: true });
    else try { fs.rmdirSync(dir); } catch {}
  }
  return notes;
}

/** Problems with the installed Herdr files (empty when all is well). */
export function doctor(ctx, manifest) {
  const home = ctx.home;
  const m = manifest.herdr;
  const problems = [];
  for (const [rel, hash] of Object.entries(m.files)) {
    const now = hashIn(home, rel);
    if (now === null) problems.push(`missing: ${rel}`);
    else if (now !== hash) problems.push(`changed by you: ${rel} (update and uninstall keep it)`);
  }
  const keys = readJson(path.join(home, KEYS), {});
  for (const k of m.keys.added) {
    if (JSON.stringify(keys[k.section]?.[k.key]) !== JSON.stringify(k.action)) problems.push(`key ${k.key} in "${k.section}" is no longer ${JSON.stringify(k.action)}`);
  }
  for (const name of m.mods) {
    const r = herdrApp(ctx, ["check", path.join(home, "mods", name)]);
    if (r.code !== 0) problems.push(`herdr-app check mods/${name}: ${(r.err || r.out).trim()}`);
  }
  if (m.plan?.installedMod && !fs.existsSync(path.join(home, "mods", "plan-review"))) problems.push("missing: mods/plan-review (run: agent-plan-review herdr install)");
  return problems;
}
