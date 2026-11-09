// <home>/data/prs/cache/scan.json: what the transcript scan learned per file, plus two small lookups
// that outlive a deleted worktree (folder -> repo, repo -> default branch).
import path from "node:path";
import { readJson, writeAtomic } from "./util.mjs";

// Bump when the scanner reads more or differently: the per-file results of an older scanner are dropped.
export const SCAN_VERSION = 2;
const MAX_FILES = 6000;
const KEEP_MS = 45 * 24 * 3600 * 1000;
const TOUCH_MS = 24 * 3600 * 1000;
const MAX_LOOKUPS = 600;

export class ScanCache {
  constructor(file, now = Date.now) {
    this.file = file;
    this.now = now;
    const raw = readJson(file, null);
    const ok = raw && raw.version === 1;
    this.files = ok && raw.scan === SCAN_VERSION && raw.files ? raw.files : {};
    this.repos = ok && raw.repos ? raw.repos : {};
    this.defaults = ok && raw.defaults ? raw.defaults : {};
    this.dirty = false;
  }

  get(file) { return this.files[file] ?? null; }

  /** Stores an entry. `touch` keeps the "last used" time fresh without rewriting the file every run. */
  set(file, entry) { this.files[file] = { ...entry, seen: this.now() }; this.dirty = true; }
  touch(file) {
    const e = this.files[file];
    if (e && this.now() - (e.seen ?? 0) > TOUCH_MS) { e.seen = this.now(); this.dirty = true; }
  }

  setRepo(folder, repo) { if (this.repos[folder] !== repo) { this.repos[folder] = repo; this.dirty = true; } }
  setDefault(repo, branch) { if (this.defaults[repo] !== branch) { this.defaults[repo] = branch; this.dirty = true; } }

  prune() {
    const cutoff = this.now() - KEEP_MS;
    let entries = Object.entries(this.files);
    const keep = entries.filter(([, e]) => (e.seen ?? 0) >= cutoff);
    if (keep.length !== entries.length) { this.dirty = true; entries = keep; }
    if (entries.length > MAX_FILES) {
      entries.sort((a, b) => (b[1].seen ?? 0) - (a[1].seen ?? 0));
      entries = entries.slice(0, MAX_FILES);
      this.dirty = true;
    }
    this.files = Object.fromEntries(entries);
    const lookups = Object.keys(this.repos);
    if (lookups.length > MAX_LOOKUPS) {
      for (const k of lookups.slice(0, lookups.length - MAX_LOOKUPS)) delete this.repos[k];
      this.dirty = true;
    }
  }

  save() {
    if (!this.dirty) return false;
    this.prune();
    try {
      writeAtomic(this.file, JSON.stringify({ version: 1, scan: SCAN_VERSION, files: this.files, repos: this.repos, defaults: this.defaults }));
      this.dirty = false;
      return true;
    } catch { return false; }
  }
}

export const cacheDir = (home) => path.join(home, "data/prs/cache");
