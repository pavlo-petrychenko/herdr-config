// Small helpers shared by the collector: paths, atomic writes, repo/URL parsing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Herdr's home: HERDR_APP_HOME, else ~/.config/herdr-app. */
export function appHome(env = process.env) {
  return env.HERDR_APP_HOME || path.join(os.homedir(), ".config/herdr-app");
}

/** Claude Code's folder: CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

/** Writes through a temporary file and a rename, so a reader never sees half a file. */
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

export const safeName = (s) => String(s).replace(/[^\w.-]/g, "_");

/** "https://github.com/o/r/pull/12" -> { repo: "o/r", number: 12 } (github.com only). */
export function parsePrUrl(url) {
  const m = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(String(url ?? ""));
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/** A git remote URL -> "owner/name" (github.com only). Handles https, ssh:// and scp-like. */
export function parseRemote(url) {
  const s = String(url ?? "").trim();
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git:\/\/|git@)github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(s);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** "/x/shop/.claude/worktrees/agent-1/sub" -> "/x/shop" (Claude Code's agent worktrees live inside the repo). */
export function mainCheckoutOf(p) {
  const m = /^(.*?)\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/.exec(String(p ?? ""));
  return m ? m[1] : null;
}

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export const uniq = (list) => [...new Set(list)];

/** Runs `fn` over `items` with at most `limit` in flight; results keep the order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Stable key of a PR across repos. */
export const prKey = (repo, number) => `${repo}#${number}`;
