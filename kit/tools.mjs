// The tools side of the kit: the programs the pieces need (herdr-prs, herdr-show, herdr-status, the
// Claude Code hook and the status line script), kept in a stable place because the npx folder is
// temporary.
//
//   <state-dir>/<version>/        the files, copied from this package's extras/ (same relative paths)
//   <state-dir>/current           a symlink to the newest <version> (replaced in one step)
//   <bin-dir>/<name>              a symlink to <state-dir>/current/bin/<name>
//
// Hooks, the status line and mods/prs/config.json name `<state-dir>/current/...`, so an update
// only has to flip `current`. The scripts find each other by relative paths: bin/herdr-prs runs
// ../prs/cli.mjs and bin/herdr-status runs ../claude/hooks/herdr-status.mjs, after following their
// own symlinks.
//
// plan() decides and changes nothing; apply() does it and fills manifest.tools; uninstall() and
// doctor() read only the manifest.
import fs from "node:fs";
import path from "node:path";
import { byId } from "./pieces.mjs";
import { hashFile, lstat, onPath, setSymlink, sha, walk, writeAtomic } from "./util.mjs";

export const CURRENT = "current";
/** Written into every version folder: the scripts without an extension (bin/herdr-show) are CommonJS. */
const PACKAGE_JSON = JSON.stringify({ private: true, type: "commonjs" }, null, 2) + "\n";

const pick = (ids, field) => [...new Set(ids.flatMap((id) => byId(id)?.tools?.[field] ?? []))];

/** The state folder's path of a tool: <state-dir>/current/<rel>. */
export const toolPath = (ctx, rel) => path.join(ctx.stateDir, CURRENT, rel);

/** The files of the tools the pieces need, as paths in the version folder ("bin/herdr-prs"); no tests. */
export function toolFiles(pkgDir, ids) {
  const skip = (rel, isDir) => (isDir && rel.split("/").pop() === "test") || rel.endsWith(".DS_Store");
  const out = [];
  for (const entry of pick(ids, "files")) {
    const abs = path.join(pkgDir, "extras", entry);
    if (fs.statSync(abs).isDirectory()) out.push(...walk(abs, skip).map((f) => `${entry}/${f}`));
    else out.push(entry);
  }
  return out.sort();
}

const isExec = (rel) => rel.startsWith("bin/") || rel.endsWith(".sh");

/**
 * Decides what to do. Changes nothing. ids: the pieces to install (new and already installed).
 * Returns null when the pieces need no tools; else
 * { files, links: [{ name, link, target }], conflicts, binDir, onPath }.
 */
export function plan(ctx, ids, manifest) {
  const files = toolFiles(ctx.pkgDir, ids);
  if (!files.length) return null;
  const conflicts = [];
  const cur = path.join(ctx.stateDir, CURRENT);
  const st = lstat(cur);
  if (st && !st.isSymbolicLink()) conflicts.push(`${cur} is already there and is not a link`);
  const links = pick(ids, "links").map((name) => ({ name, link: path.join(ctx.binDir, name), target: toolPath(ctx, `bin/${name}`) }));
  if (lstat(ctx.binDir) && !fs.statSync(ctx.binDir, { throwIfNoEntry: false })?.isDirectory()) conflicts.push(`${ctx.binDir} is not a folder`);
  for (const l of links) {
    const s = lstat(l.link);
    if (!s) continue;
    if (!(s.isSymbolicLink() && fs.readlinkSync(l.link) === l.target)) {
      conflicts.push(`${l.link} is already there and the kit did not put it there`);
    }
  }
  return { files, links, conflicts, binDir: ctx.binDir, onPath: onPath(ctx.binDir, ctx.env), version: ctx.version };
}

/** Does what plan() decided. Fills manifest.tools. Returns notes. */
export function apply(ctx, p, manifest) {
  const notes = [];
  const t = (manifest.tools ??= { version: null, previous: null, versions: [], files: {}, links: [], binDir: null, madeBinDir: false });
  const version = ctx.version;
  const dir = path.join(ctx.stateDir, version);
  // Recorded first, so a crash half way still leaves the folder to the next uninstall.
  if (!t.versions.includes(version)) t.versions.push(version);
  fs.mkdirSync(dir, { recursive: true });

  const files = {};
  for (const rel of p.files) {
    const data = fs.readFileSync(path.join(ctx.pkgDir, "extras", rel));
    const to = path.join(dir, rel);
    if (hashFile(to) !== sha(data)) writeAtomic(to, data);
    fs.chmodSync(to, isExec(rel) ? 0o755 : 0o644);
    files[rel] = sha(data);
  }
  writeAtomic(path.join(dir, "package.json"), PACKAGE_JSON);
  files["package.json"] = sha(PACKAGE_JSON);

  // Flip `current` to the new version in one step.
  setSymlink(version, path.join(ctx.stateDir, CURRENT));
  if (t.version && t.version !== version) t.previous = t.version;
  t.version = version;
  t.files = files;

  // Old versions: keep this one and the one before.
  for (const v of [...t.versions]) {
    if (v === t.version || v === t.previous) continue;
    fs.rmSync(path.join(ctx.stateDir, v), { recursive: true, force: true });
    t.versions = t.versions.filter((x) => x !== v);
  }

  // Links in the bin folder.
  t.binDir = ctx.binDir;
  if (p.links.length && !fs.existsSync(ctx.binDir)) {
    fs.mkdirSync(ctx.binDir, { recursive: true });
    t.madeBinDir = true;
  }
  for (const l of p.links) {
    setSymlink(l.target, l.link);
    if (!t.links.some((x) => x.link === l.link)) t.links.push({ link: l.link, target: l.target });
  }
  if (p.links.length && !p.onPath) notes.push(notOnPath(ctx.binDir));
  return notes;
}

export const notOnPath = (binDir) =>
  `${binDir} is not on your PATH, so agents cannot run herdr-status and the others by name. Add this line to your shell profile: export PATH="${binDir}:$PATH"`;

/** Takes the kit's tools out. Returns notes. */
export function uninstall(ctx, manifest) {
  const t = manifest.tools;
  if (!t) return [];
  const notes = [];
  for (const l of t.links) {
    const s = lstat(l.link);
    if (!s) continue;
    if (s.isSymbolicLink() && fs.readlinkSync(l.link) === l.target) fs.rmSync(l.link);
    else notes.push(`Kept ${l.link}: it is not the kit's link any more.`);
  }
  if (t.madeBinDir) try { fs.rmdirSync(t.binDir); } catch {}
  const cur = path.join(ctx.stateDir, CURRENT);
  if (lstat(cur)?.isSymbolicLink()) fs.rmSync(cur);
  for (const v of t.versions) fs.rmSync(path.join(ctx.stateDir, v), { recursive: true, force: true });
  return notes;
}

/** { problems, warnings } for the installed tools. */
export function doctor(ctx, manifest) {
  const t = manifest.tools;
  const problems = [];
  const warnings = [];
  if (!t) return { problems, warnings };
  const dir = path.join(ctx.stateDir, t.version);
  for (const [rel, hash] of Object.entries(t.files)) {
    const now = hashFile(path.join(dir, rel));
    if (now === null) problems.push(`missing: ${path.join(dir, rel)}`);
    else if (now !== hash) problems.push(`changed: ${path.join(dir, rel)}`);
  }
  const cur = path.join(ctx.stateDir, CURRENT);
  if (!lstat(cur)?.isSymbolicLink() || fs.readlinkSync(cur) !== t.version) problems.push(`${cur} does not point to ${t.version}`);
  for (const l of t.links) {
    const s = lstat(l.link);
    if (!s) problems.push(`missing link: ${l.link}`);
    else if (!s.isSymbolicLink() || fs.readlinkSync(l.link) !== l.target) problems.push(`${l.link} is not the kit's link any more`);
    else if (!fs.existsSync(l.link)) problems.push(`broken link: ${l.link}`);
  }
  if (t.links.length && t.binDir && !onPath(t.binDir, ctx.env)) warnings.push(notOnPath(t.binDir));
  return { problems, warnings };
}
