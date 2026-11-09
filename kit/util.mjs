// Small helpers shared by the kit: running programs, hashes, time stamps, file walks.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Runs a program. Never throws: { code, out, err }; code 127 when the program is not found. */
export function run(cmd, args, { env, timeout = 120000 } = {}) {
  const r = spawnSync(cmd, args, { env, encoding: "utf8", timeout });
  if (r.error) return { code: 127, out: "", err: String(r.error.message ?? r.error) };
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** The full path of a program on PATH, or null. */
export function which(name, env = process.env) {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

export const sha = (data) => createHash("sha256").update(data).digest("hex");

/** sha256 of a file, or null when it is missing. */
export function hashFile(p) {
  try { return sha(fs.readFileSync(p)); } catch { return null; }
}

/** "20261109-153012" */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** "~/x" -> "/Users/me/x" */
export function expand(p, home = os.homedir()) {
  if (p === "~") return home;
  return p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

/** "/Users/me/x" -> "~/x" (for messages). */
export function tilde(p, home = os.homedir()) {
  return p === home ? "~" : p.startsWith(home + path.sep) ? "~/" + p.slice(home.length + 1) : p;
}

/** Every file under dir, as paths relative to dir ("a/b.js"), sorted. skip(rel, isDir) leaves one out. */
export function walk(dir, skip = () => false, base = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (skip(rel, e.isDirectory())) continue;
    if (e.isDirectory()) out.push(...walk(dir, skip, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

export function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

/** Writes a file through a temporary file and a rename, so a reader never sees half of it. */
export function writeAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.herdr-kit-tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}

export const writeJson = (p, v) => writeAtomic(p, JSON.stringify(v, null, 2) + "\n");

export function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
