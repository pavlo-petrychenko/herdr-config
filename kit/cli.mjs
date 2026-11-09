#!/usr/bin/env node
// herdr-kit: puts the herdr-config pieces into anyone's Herdr, and takes them out again.
//
//   npx herdr-kit [setup]     the wizard (plan page "wizard", steps 1-7)
//   npx herdr-kit update      new mod files, then the flat sidebar rebuilt from the current Herdr
//   npx herdr-kit doctor      the checks, and "is every installed file still the kit's"
//   npx herdr-kit uninstall   take out what the manifest lists (--purge: the mods' data too)
//
// Flags: --yes (no questions), --pieces a,b, --home <dir>, --state-dir <dir>, --bin-dir <dir>,
// --claude-dir <dir>, --purge.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import * as claude from "./claude.mjs";
import * as herdr from "./herdr.mjs";
import { checkPrograms, findHerdr, herdrApp, resolveBinDir, resolveClaudeDir, resolveHome, resolveStateDir, windowStatus } from "./home.mjs";
import { formatAction } from "./keys.mjs";
import { FLAT_LAYOUT } from "./layout.mjs";
import { loadManifest, newManifest, removeManifest, saveManifest } from "./manifest.mjs";
import { PIECES, byId, choosePieces } from "./pieces.mjs";
import * as tools from "./tools.mjs";
import { readJson, tilde } from "./util.mjs";

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ISSUES = "https://github.com/pavlo-petrychenko/herdr-config/issues";
const SWITCH_KEY = process.platform === "darwin" ? "cmd-shift-l" : "ctrl-shift-l";

const HELP = `herdr-kit: the herdr-config pieces for your Herdr.

  npx herdr-kit [setup]     pick pieces and install them (asks before it changes anything)
  npx herdr-kit update      new mod files, and the flat sidebar rebuilt from your current Herdr
  npx herdr-kit doctor      check Herdr, the programs, and the installed files
  npx herdr-kit uninstall   take out everything the kit installed

  --yes             no questions: all pieces that can work, clashing keys stay yours
  --pieces a,b      only these pieces (${PIECES.map((p) => p.id).join(", ")})
  --home <dir>      the Herdr home (default: $HERDR_APP_HOME, else ~/.config/herdr-app)
  --state-dir <dir> where the kit keeps manifest.json and the tools (default: ~/.local/share/herdr-kit)
  --bin-dir <dir>   where the tool links go (default: ~/.local/bin)
  --claude-dir <dir> Claude Code's folder (default: $CLAUDE_CONFIG_DIR, else ~/.claude)
  --purge           uninstall: also delete the data the mods wrote
`;

export function parseArgs(argv) {
  const flags = { command: null, yes: false, purge: false, help: false, pieces: null, home: null, stateDir: null, binDir: null, claudeDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--purge") flags.purge = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (a.startsWith("--pieces")) flags.pieces = value().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--home")) flags.home = value();
    else if (a.startsWith("--state-dir")) flags.stateDir = value();
    else if (a.startsWith("--bin-dir")) flags.binDir = value();
    else if (a.startsWith("--claude-dir")) flags.claudeDir = value();
    else if (a.startsWith("-")) throw new Error(`unknown flag ${a}`);
    else if (!flags.command) flags.command = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  flags.command ??= "setup";
  if (!["setup", "update", "doctor", "uninstall"].includes(flags.command)) throw new Error(`unknown command ${flags.command}`);
  for (const id of flags.pieces ?? []) if (!byId(id)) throw new Error(`unknown piece ${id} (pieces: ${PIECES.map((p) => p.id).join(", ")})`);
  return flags;
}

/**
 * Runs the kit. io: { env, out (line printer), ask (question -> answer), patchScript, version (tests) }.
 * Returns the exit code.
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const out = io.out ?? ((s = "") => process.stdout.write(s + "\n"));
  let flags;
  try { flags = parseArgs(argv); } catch (e) { out(`herdr-kit: ${e.message}\n\n${HELP}`); return 2; }
  if (flags.help) { out(HELP); return 0; }

  let rl = null;
  const ask = io.ask ?? (async (q) => {
    rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
    return (await rl.question(q)).trim();
  });
  const ctx = {
    home: resolveHome(flags.home, env),
    stateDir: resolveStateDir(flags.stateDir, env),
    binDir: resolveBinDir(flags.binDir),
    claudeDir: resolveClaudeDir(flags.claudeDir, env),
    pkgDir: PKG_DIR,
    patchScript: io.patchScript ?? path.join(PKG_DIR, "spaces-flat-patch.py"),
    env, out, ask, yes: flags.yes, flags,
    version: io.version ?? readJson(path.join(PKG_DIR, "package.json"), {}).version ?? "0.0.0",
  };
  try {
    if (flags.command === "doctor") return doctor(ctx);
    if (flags.command === "uninstall") return await uninstall(ctx);
    return await setup(ctx, flags.command === "update");
  } finally {
    rl?.close();
  }
}

// --yes answers every question with yes; the clash questions are never asked then.
const yesNo = async (ctx, q, dflt) => {
  if (ctx.yes) return true;
  const a = (await ctx.ask(`${q} ${dflt ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  return a === "" ? dflt : a.startsWith("y");
};

/** The status line question. Returns "add", "replace" or "keep". --yes adds one only when there is none. */
async function askStatusLine(ctx, jq) {
  const { state, current } = claude.statusLineState(ctx);
  if (state === "ours") return "keep";
  if (!jq.ok) {
    if (state === "none") ctx.out(`   No Herdr status line: ${jq.why} (the status line script needs it).`);
    return "keep";
  }
  if (state === "none") return (await yesNo(ctx, "   Add the Herdr status line?", true)) ? "add" : "keep";
  if (ctx.yes) return "keep";
  ctx.out(`   You already have a status line: ${current.command ?? JSON.stringify(current)}`);
  return (await yesNo(ctx, "   Replace your Claude Code status line?", false)) ? "replace" : "keep";
}

/** Steps 1 and 2. Returns { found, checks } or null (stopped). */
function checks(ctx) {
  const { out } = ctx;
  out("1. Herdr");
  const found = findHerdr(ctx);
  if (found.stop) { out(`   Stopped: ${found.stop}`); return null; }
  out(`   Herdr ${found.version}, home ${tilde(ctx.home)}, window ${found.window ? "open" : "not open"}`);
  out("2. Programs");
  const c = checkPrograms(ctx, found);
  const line = (name, need) => out(`   ${c[need].ok ? "ok     " : "missing"} ${name}${c[need].ok ? "" : `: ${c[need].why}`}`);
  line("Node 20+", "node20");
  line("git", "git");
  line("Python 3", "python3");
  line("GitHub CLI, logged in", "gh");
  line("Claude Code", "claude");
  line("agent-plan-review", "agent-plan-review");
  return { found, checks: c };
}

/** Step 3: pick pieces. Returns the ids to install (may be empty). */
async function pickPieces(ctx, c, have) {
  const { out } = ctx;
  out("3. Pieces");
  let { on, off } = choosePieces(c, ctx.flags.pieces, have);
  const offWhy = new Map(off.map((o) => [o.id, o.why]));
  const shown = PIECES.filter((p) => !ctx.flags.pieces || ctx.flags.pieces.includes(p.id));
  const print = () => shown.forEach((p, i) => {
    const mark = have.includes(p.id) ? "[installed]" : on.includes(p.id) ? "[x]" : "[ ]";
    out(`   ${i + 1}. ${mark} ${p.title} (${p.id}): ${p.about}${offWhy.has(p.id) ? `. Off: ${offWhy.get(p.id)}` : ""}`);
  });
  print();
  if (!ctx.yes) {
    for (;;) {
      const a = await ctx.ask("   Type a number to switch a piece on or off, Enter when done: ");
      if (a === "") break;
      const p = shown[Number(a) - 1];
      if (!p || have.includes(p.id)) { out("   No such piece to switch."); continue; }
      if (on.includes(p.id)) on = on.filter((id) => id !== p.id);
      else if (offWhy.has(p.id) && !(p.requires ?? []).length) out(`   ${p.title} cannot be on: ${offWhy.get(p.id)}`);
      else {
        const base = (p.requires ?? []).find((r) => !on.includes(r) && !have.includes(r));
        if (base) out(`   ${p.title} needs the ${byId(base).title} piece: switch that on first.`);
        else { on.push(p.id); offWhy.delete(p.id); }
      }
      // A piece whose base was switched off goes off too.
      on = on.filter((id) => (byId(id).requires ?? []).every((r) => on.includes(r) || have.includes(r)));
      print();
    }
  }
  return on.filter((id) => !have.includes(id));
}

/** Step 5: what will change. */
function describe(ctx, p, found, tp, cp, answers) {
  const { out } = ctx;
  out("5. What will change");
  const home = tilde(ctx.home);
  const byMod = new Map();
  for (const rel of p.writes) { const mod = rel.split("/")[1]; byMod.set(mod, (byMod.get(mod) ?? 0) + 1); }
  for (const [mod, n] of byMod) out(`   write ${home}/mods/${mod}/ (${n} file${n === 1 ? "" : "s"})`);
  for (const rel of p.remove) out(`   remove ${home}/${rel} (no longer in the kit)`);
  for (const rel of p.keep) out(`   keep ${home}/${rel} (you changed it)`);
  if (p.build) out(`   build ${home}/mods/spaces-flat/ and ${home}/layouts/main-flat.json from your Herdr ${found.version} (a copy of its spaces mod and main layout, then patched)`);
  for (const c of p.config) out(`   write ${home}/${c} (starter config)`);
  for (const g of p.generated) out(`   write ${home}/${g.rel} (the path of herdr-prs: Herdr started from the Dock has a short PATH)`);
  if (tp) {
    out(`   write ${tilde(path.join(ctx.stateDir, ctx.version))}/ (${tp.files.length + 1} files: ${[...new Set(tp.files.map((f) => f.split("/")[0]))].join(", ")}), and ${tilde(path.join(ctx.stateDir, "current"))} points to it`);
    for (const l of tp.links) out(`   link ${tilde(l.link)} -> ${tilde(l.target)}`);
    if (tp.links.length && !tp.onPath) out(`   Note: ${tp.binDir} is not on your PATH (the end of this run says what to add).`);
  }
  if (cp) {
    if (cp.hooks.length) {
      out(`   ${tilde(cp.file)} (a copy goes to settings.json.herdr-kit-<time>.bak first; your other hooks stay):`);
      for (const h of cp.hooks) out(`     add hook ${h.event}${h.matcher ? ` (${h.matcher})` : ""} -> herdr-status.mjs`);
    } else out(`   ${tilde(cp.file)}: the hooks are already there.`);
    if (answers.statusLine === "add") out("     set the Herdr status line (it shows your plan's limits and feeds the usage bar)");
    if (answers.statusLine === "replace") out("     replace your status line with the Herdr status line (you can put it back: uninstall does)");
  }
  if (p.planView) out("   run agent-plan-review herdr enable, agent-plan-review herdr install");
  if (p.keys.add.length || p.keys.clashes.length) {
    out(`   keys.json (a copy goes to keys.json.herdr-kit-<time>.bak first):`);
    for (const k of p.keys.add) out(`     add ${k.key} -> ${formatAction(k.action)} (in "${k.section}")`);
    for (const k of p.keys.clashes) out(`     clash: ${k.key} in "${k.section}" is yours (${formatAction(k.theirs)}); the kit wants ${formatAction(k.action)}. Default: keep yours.`);
    out("   Note: Herdr adds its new default shortcuts only to a keys.json nobody edited. After this,");
    out("   new Herdr shortcuts must be added to keys.json by hand.");
  }
  if (!p.writes.length && !p.remove.length && !p.build && !p.config.length && !p.generated.length && !p.planView && !p.keys.add.length && !p.keys.clashes.length && !tp && !cp) out("   Nothing to change.");
}

async function setup(ctx, isUpdate) {
  const { out } = ctx;
  out(`herdr-kit ${ctx.version}${isUpdate ? ": update" : ""}`);
  const old = loadManifest(ctx.stateDir);
  if (old && old.home !== ctx.home) {
    out(`Stopped: the kit is installed in ${old.home} (state folder ${tilde(ctx.stateDir)}). Uninstall it there first, or use another --state-dir.`);
    return 1;
  }
  if (isUpdate && !old) { out(`herdr-kit is not installed in ${tilde(ctx.home)}. Run: npx herdr-kit`); return 1; }
  const r = checks(ctx);
  if (!r) return 1;
  const manifest = old ?? newManifest(ctx.version, ctx.home);
  const have = manifest.pieces;

  let ids;
  if (isUpdate) {
    const { on, off } = choosePieces(r.checks, have);
    out(`3. Pieces: ${on.join(", ") || "none"}`);
    for (const o of off) out(`   ${byId(o.id).title} is not updated: ${o.why}`);
    ids = on;
  } else {
    const added = await pickPieces(ctx, r.checks, have);
    if (!added.length && !have.length) { out("Nothing picked; nothing changed."); return 0; }
    // Already installed pieces are updated too, when their programs are there.
    ids = [...choosePieces(r.checks, have).on, ...added];
  }

  const answers = { workFolders: [], takeKeys: [], statusLine: "keep" };
  if (!isUpdate) {
    out("4. Questions");
    if (ids.includes("core") && !fs.existsSync(path.join(ctx.home, "space-groups.json")) && !ctx.yes) {
      const a = await ctx.ask("   Work folders for the sidebar groups, separated by commas (Enter: none, all spaces go to Other): ");
      answers.workFolders = a.split(",").map((s) => s.trim()).filter(Boolean);
    } else out("   None.");
    if (ids.includes("statuses") && !have.includes("statuses")) answers.statusLine = await askStatusLine(ctx, r.checks.jq);
  }

  const p = herdr.plan(ctx, ids, manifest);
  const tp = tools.plan(ctx, ids, manifest);
  const cp = claude.plan(ctx, ids);
  p.conflicts.push(...(tp?.conflicts ?? []), ...(cp?.conflicts ?? []));
  if (p.conflicts.length) {
    out("Stopped, nothing was changed:");
    for (const c of p.conflicts) out(`   ${tilde(ctx.home)}/${c}`);
    out("   Rename or remove it, then run herdr-kit again.");
    return 1;
  }
  describe(ctx, p, r.found, tp, cp, answers);
  if (!ctx.yes) {
    for (const k of p.keys.clashes) {
      if (await yesNo(ctx, `   Use the kit's ${k.key} (${formatAction(k.action)}) instead of yours?`, false)) answers.takeKeys.push(`${k.section} ${k.key}`);
    }
  }
  if (!(await yesNo(ctx, "Go ahead?", true))) { out("Nothing changed."); return 0; }

  out("6. Installing");
  const before = r.found.window?.layout ?? null;
  let res;
  const toolNotes = [];
  try {
    if (tp) toolNotes.push(...tools.apply(ctx, tp, manifest));
    res = herdr.apply(ctx, p, manifest, answers);
    if (cp) res.notes.push(...claude.apply(ctx, cp, manifest, answers));
  } finally {
    manifest.version = ctx.version;
    manifest.pieces = [...new Set([...have, ...ids])];
    saveManifest(ctx.stateDir, manifest);
  }
  for (const n of [...res.notes, ...toolNotes]) out(`   ${n}`);
  if (res.flat && !res.flat.ok) {
    out("   The flat sidebar could not be built on this Herdr. Your layout is kept; the other pieces are in.");
    out(`   Herdr: ${res.flat.version}`);
    out(`   Error: ${res.flat.error}`);
    out(`   Please open an issue with these lines: ${ISSUES}`);
  }
  out(`   Manifest: ${tilde(path.join(ctx.stateDir, "manifest.json"))}`);

  out("7. Done");
  const flatThere = manifest.herdr.layouts.includes(FLAT_LAYOUT) && fs.existsSync(path.join(ctx.home, "layouts", `${FLAT_LAYOUT}.json`));
  if (isUpdate) {
    // The rebuild shows main-flat; go back to what the window showed before.
    if (before && res.flat?.ok && before !== FLAT_LAYOUT) herdrApp(ctx, ["do", "layout.switch", JSON.stringify({ name: before })]);
    out("   Updated.");
  } else if (flatThere && windowStatus(ctx)) {
    herdrApp(ctx, ["do", "layout.switch", JSON.stringify({ name: FLAT_LAYOUT })]);
    out(`   Herdr now shows the main-flat layout. ${SWITCH_KEY} switches back to your layout.`);
  } else out("   Installed.");
  out("   Undo it all: npx herdr-kit uninstall");
  return res.flat && !res.flat.ok ? 1 : 0;
}

function doctor(ctx) {
  const { out } = ctx;
  out(`herdr-kit ${ctx.version}: doctor`);
  const r = checks(ctx);
  if (!r) return 1;
  const m = loadManifest(ctx.stateDir);
  out("3. Installed files");
  if (!m) { out(`   herdr-kit is not installed (no ${tilde(path.join(ctx.stateDir, "manifest.json"))}).`); return 0; }
  if (m.home !== ctx.home) { out(`   The manifest is for ${m.home}, not this home.`); return 1; }
  out(`   Version ${m.version}, pieces: ${m.pieces.join(", ")}`);
  const t = tools.doctor(ctx, m);
  const problems = [...herdr.doctor(ctx, m), ...t.problems, ...claude.doctor(ctx, m)];
  for (const p of problems) out(`   ${p}`);
  for (const w of t.warnings) out(`   warning: ${w}`);
  out(problems.length ? `   ${problems.length} problem${problems.length === 1 ? "" : "s"}.` : "   All files are as the kit put them.");
  return problems.length ? 1 : 0;
}

async function uninstall(ctx) {
  const { out } = ctx;
  out(`herdr-kit ${ctx.version}: uninstall`);
  const m = loadManifest(ctx.stateDir);
  if (!m) { out(`Nothing to uninstall: no ${tilde(path.join(ctx.stateDir, "manifest.json"))}.`); return 0; }
  if (m.home !== ctx.home) { out(`Stopped: the kit is installed in ${m.home}, not ${ctx.home}. Use --home ${m.home}.`); return 1; }
  out(`This takes out the pieces ${m.pieces.join(", ")} from ${tilde(ctx.home)} and puts keys.json back.`);
  if (m.claude) out(`It also takes the Herdr hooks out of ${tilde(m.claude.file)} (your other hooks stay).`);
  if (!ctx.flags.purge) out("The data the mods wrote (data/agent-status, data/prs, ...) stays; --purge deletes it.");
  if (!(await yesNo(ctx, "Go ahead?", false))) { out("Nothing changed."); return 0; }
  const notes = [...claude.uninstall(ctx, m), ...herdr.uninstall(ctx, m, { purge: ctx.flags.purge }), ...tools.uninstall(ctx, m)];
  for (const n of notes) out(`   ${n}`);
  removeManifest(ctx.stateDir);
  try { fs.rmdirSync(ctx.stateDir); } catch {} // only when nothing else is in it
  out(`Done. Herdr shows the main layout${notes.length ? "; see the lines above for what was kept" : ""}.`);
  return 0;
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`herdr-kit: ${e.stack ?? e}\n`);
    process.exitCode = 1;
  });
}
