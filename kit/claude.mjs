// The Claude Code side of the kit: the status hooks and the status line in <claude-dir>/settings.json.
//
// settings.json is read, changed and written as JSON, with a backup first. Every other hook stays.
// The kit knows its own hooks by the path of its tools in the command: <state-dir>/current/.
// plan() decides and changes nothing; apply() does it and fills manifest.claude; uninstall() and
// doctor() read the manifest and settings.json.
import fs from "node:fs";
import path from "node:path";
import { backupFile } from "./manifest.mjs";
import { byId } from "./pieces.mjs";
import { toolPath } from "./tools.mjs";
import { hashFile, stamp, writeJson } from "./util.mjs";

const SCRIPT = "claude/hooks/herdr-status.mjs";
const STATUS_LINE = "claude/statusline-herdr.sh";
const MATCH_PLAN_CHECK = "mcp__agent-plan-review__plan_review_check";

/** The hooks the owner uses for the queue (events and matchers as in their settings.json). */
export const HOOKS = [
  { event: "SessionStart" },
  { event: "SessionEnd" },
  { event: "UserPromptSubmit" },
  { event: "PreToolUse", matcher: "AskUserQuestion" },
  { event: "PreToolUse", matcher: MATCH_PLAN_CHECK },
  { event: "PostToolUse", matcher: MATCH_PLAN_CHECK },
  { event: "PostToolUseFailure", matcher: MATCH_PLAN_CHECK },
  { event: "Stop" },
];
const TIMEOUT = 10;

const quote = (p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p}'`);
/** The folder every command of the kit starts in. */
const marker = (ctx) => `${toolPath(ctx, "")}/`;
const isKit = (ctx, command) => typeof command === "string" && command.includes(marker(ctx));
const hookCommand = (ctx, event) => `node ${quote(toolPath(ctx, SCRIPT))} hook ${event}`;
const statusLineCommand = (ctx) => quote(toolPath(ctx, STATUS_LINE));

export const settingsFile = (ctx) => path.join(ctx.claudeDir, "settings.json");

/** { exists, data } or { exists, invalid: "why" }. */
function load(file) {
  if (!fs.existsSync(file)) return { exists: false, data: {} };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return { exists: true, invalid: "it is not a JSON object" };
    if (data.hooks !== undefined && (typeof data.hooks !== "object" || data.hooks === null || Array.isArray(data.hooks))) return { exists: true, invalid: '"hooks" is not an object' };
    return { exists: true, data };
  } catch (e) {
    return { exists: true, invalid: `it is not valid JSON (${e.message})` };
  }
}

const hasHook = (data, ctx, h) =>
  (data.hooks?.[h.event] ?? []).some((g) => (g?.matcher ?? null) === (h.matcher ?? null) && (g?.hooks ?? []).some((x) => x?.command === hookCommand(ctx, h.event)));

/** What the status line is now: "none", "ours" or "other" (with the person's setting). */
export function statusLineState(ctx) {
  const l = load(settingsFile(ctx));
  const sl = l.data?.statusLine;
  if (sl === undefined || sl === null) return { state: "none" };
  return isKit(ctx, sl.command) ? { state: "ours", current: sl } : { state: "other", current: sl };
}

/**
 * Decides what to add. Changes nothing. ids: the pieces to install.
 * Returns null when no piece needs hooks; else { file, hooks: [to add], conflicts, statusLine }.
 */
export function plan(ctx, ids) {
  if (!ids.some((id) => byId(id)?.claude?.hooks)) return null;
  const file = settingsFile(ctx);
  const conflicts = [];
  if (ctx.stateDir.includes("'")) conflicts.push(`the state folder ${ctx.stateDir} has a ' in its name; use another --state-dir`);
  const l = load(file);
  if (l.invalid) conflicts.push(`${file}: ${l.invalid}. Fix it, then run herdr-kit again.`);
  const hooks = l.invalid ? [] : HOOKS.filter((h) => !hasHook(l.data, ctx, h));
  return { file, hooks, conflicts, statusLine: statusLineState(ctx).state };
}

/**
 * Does what plan() decided. answers.statusLine: "add" | "replace" | anything else (leave it).
 * Fills manifest.claude. Returns notes.
 */
export function apply(ctx, p, manifest, answers = {}) {
  const notes = [];
  const file = p.file;
  const l = load(file);
  const data = l.data;
  const c = (manifest.claude ??= {
    file, created: false, madeDir: false, backup: null, after: null, restorable: false, backups: [], hooks: [], statusLine: null,
  });
  const sl = statusLineState(ctx);
  const setLine = (answers.statusLine === "add" && sl.state === "none") || (answers.statusLine === "replace" && sl.state === "other");
  if (!p.hooks.length && !setLine) return notes;

  const before = hashFile(file);
  if (l.exists) {
    const backup = backupFile(file, stamp());
    c.backups.push(backup);
    // The first backup goes back whole on uninstall, while nobody else changed the file.
    if (!c.backup) { c.backup = backup; c.restorable = true; }
    else if (before !== c.after) c.restorable = false;
  } else {
    if (!fs.existsSync(ctx.claudeDir)) c.madeDir = true;
    if (!c.after) c.created = true;
    else if (before !== c.after) c.restorable = false;
  }

  if (p.hooks.length) {
    data.hooks ??= {};
    for (const h of p.hooks) {
      const command = hookCommand(ctx, h.event);
      (data.hooks[h.event] ??= []).push({
        ...(h.matcher ? { matcher: h.matcher } : {}),
        hooks: [{ type: "command", command, timeout: TIMEOUT }],
      });
      c.hooks.push({ event: h.event, matcher: h.matcher ?? null, command });
    }
  }
  if (setLine) {
    c.statusLine = { command: statusLineCommand(ctx), previous: sl.state === "other" ? sl.current : null };
    data.statusLine = { type: "command", command: c.statusLine.command };
  }
  writeJson(file, data);
  c.after = hashFile(file);
  if (p.hooks.length) notes.push("Claude Code reads its hooks when a session starts: restart the sessions that are running.");
  return notes;
}

/** Takes the kit's hooks and status line out of a settings object. Returns it. */
function strip(ctx, data, c) {
  if (data.hooks) {
    for (const [event, groups] of Object.entries(data.hooks)) {
      if (!Array.isArray(groups)) continue;
      const kept = [];
      for (const g of groups) {
        const rest = (g?.hooks ?? []).filter((x) => !isKit(ctx, x?.command));
        if (!Array.isArray(g?.hooks) || rest.length === g.hooks.length) kept.push(g);
        else if (rest.length) kept.push({ ...g, hooks: rest });
      }
      if (kept.length) data.hooks[event] = kept;
      else delete data.hooks[event];
    }
    if (!Object.keys(data.hooks).length) delete data.hooks;
  }
  if (data.statusLine && isKit(ctx, data.statusLine.command)) {
    if (c.statusLine?.previous) data.statusLine = c.statusLine.previous;
    else delete data.statusLine;
  }
  return data;
}

/** Takes the kit's hooks out; the status line goes back. Returns notes. */
export function uninstall(ctx, manifest) {
  const c = manifest.claude;
  if (!c) return [];
  const notes = [];
  const file = c.file;
  const now = hashFile(file);
  const rmdir = () => { if (c.madeDir) try { fs.rmdirSync(path.dirname(file)); } catch {} };
  const keepBackups = (except) => { for (const b of c.backups) if (b !== except && fs.existsSync(b)) notes.push(`Backup kept: ${b}`); };

  if (now === null) return notes;
  if (now === c.after && c.restorable && c.backup && fs.existsSync(c.backup)) {
    fs.renameSync(c.backup, file);
    keepBackups(c.backup);
    return notes;
  }
  if (now === c.after && c.created) {
    fs.rmSync(file);
    rmdir();
    keepBackups(null);
    return notes;
  }
  const l = load(file);
  if (l.invalid) {
    notes.push(`${file} is ${l.invalid}; take the kit's hooks out by hand (they run ${marker(ctx)}).`);
    return notes;
  }
  const backup = backupFile(file, stamp());
  const next = strip(ctx, l.data, c);
  if (c.created && !Object.keys(next).length) { fs.rmSync(file); rmdir(); fs.rmSync(backup); }
  else {
    writeJson(file, next);
    notes.push(`${path.basename(file)} changed since the install: only the kit's hooks were taken out (copy before: ${path.basename(backup)}).`);
  }
  keepBackups(null);
  return notes;
}

/** Problems with the installed hooks (empty when all is well). */
export function doctor(ctx, manifest) {
  const c = manifest.claude;
  if (!c) return [];
  const problems = [];
  const l = load(c.file);
  if (!l.exists) return [`missing: ${c.file}`];
  if (l.invalid) return [`${c.file}: ${l.invalid}`];
  for (const h of HOOKS) if (!hasHook(l.data, ctx, h)) problems.push(`hook missing in settings.json: ${h.event}${h.matcher ? ` (${h.matcher})` : ""} (run: herdr-kit update)`);
  if (c.statusLine && !isKit(ctx, l.data.statusLine?.command)) problems.push("the Herdr status line is not set in settings.json any more");
  return problems;
}
