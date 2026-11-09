#!/usr/bin/env node
// What an agent in Herdr wants from the person, for the Herdr queue (the agent-queue mod).
// One file per terminal: <herdr app home>/data/agent-status/<HC_TERMINAL_ID>.json
//   { kind, text, at (ms), source: "agent" | "model" | "question" | "fallback" }
// Kinds: approve answer blocked review done waiting (see KINDS).
//
//   herdr-status <kind> "<one sentence>"     the agent says it (~/.local/bin/herdr-status)
//   herdr-status clear
//   herdr-status.mjs plan-review start|end   around the blocking ExitPlanMode hook
//   herdr-status.mjs hook <event>           Claude Code hooks (stdin: the hook's JSON)
//     SessionStart      a new session in this terminal: forget the last session's status
//                       (not after a compaction: that is the same session)
//                       Also appends {sessionId, transcriptPath, cwd, source, at} to
//                       <home>/data/agent-sessions/<terminal>.jsonl (which session ran in which
//                       terminal; files older than 30 days are pruned). Not after a compaction.
//     SessionEnd        the session is gone: forget its status
//     UserPromptSubmit  the person answered: forget the status
//     PreToolUse        (AskUserQuestion) keep the question's text: kind answer
//                       (plan_review_check) the agent blocks on the person: kind review, source
//                       "plan-review", which the queue puts above Herdr's "working"
//     PostToolUse, PostToolUseFailure  (plan_review_check) the wait ended: forget that status
//     Stop              the turn ended without `herdr-status`: a small model reads the last
//                       reply and picks the kind, in the background (C); on failure: review
// Outside Herdr (no HC_TERMINAL_ID) everything does nothing. The model's own run sets
// HERDR_STATUS_CHILD, so these hooks skip it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const KINDS = {
  approve: "wants permission for one action",
  answer: "asked a question or needs a decision",
  blocked: "cannot go on because of something outside the chat (access, broken CI, a service down)",
  review: "finished work for the person to check (PR, diff, plan, report)",
  done: "finished; nothing needed, just so the person knows",
  waiting: "waits on something that is not the person (CI, a deploy, a background job)",
};

const PLAN_WAITS = "Plan waits for your review";
const terminal = process.env.HC_TERMINAL_ID;
const home = process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config/herdr-app");
const file = terminal ? path.join(home, "data/agent-status", `${terminal.replace(/[^\w.-]/g, "_")}.json`) : null;

const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
function write(kind, text, source) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ kind, text: oneLine(text, 160), at: Date.now(), source }));
  fs.renameSync(tmp, file);
}
const clear = () => { try { fs.unlinkSync(file); } catch {} };
const oneLine = (s, max) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const firstSentence = (s) => oneLine(String(s ?? "").replace(/[#*`>_-]+/g, " ").split(/(?<=[.!?])\s/)[0], 140);

// The last assistant text in a Claude Code transcript (JSONL).
function lastReply(transcript) {
  let text = "";
  try {
    for (const line of fs.readFileSync(transcript, "utf8").trim().split("\n").slice(-200)) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== "assistant" || e.isSidechain) continue;
      const parts = Array.isArray(e.message?.content) ? e.message.content : [];
      const t = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n").trim();
      if (t) text = t;
    }
  } catch {}
  return text;
}

// C: a small model picks the kind. Runs detached, so the turn ends at once.
function classify(reply) {
  const prompt = [
    "A coding agent just ended its turn. Its last message to the person is below.",
    "Pick what the agent now needs from the person, as exactly one kind:",
    ...Object.entries(KINDS).filter(([k]) => k !== "approve").map(([k, v]) => `- ${k}: ${v}`),
    'Answer with JSON only: {"kind": "<kind>", "sentence": "<at most 15 words: what the person must do, or what was done>"}',
    "", "Message:", reply.slice(-4000),
  ].join("\n");
  // The prompt goes on stdin: --tools takes a list and would take it as a tool name.
  const r = spawnSync("claude", ["-p", "--model", "haiku", "--no-session-persistence", "--setting-sources", "project", "--strict-mcp-config", "--tools", ""], {
    input: prompt, cwd: os.tmpdir(), encoding: "utf8", timeout: 60000, env: { ...process.env, HERDR_STATUS_CHILD: "1" },
  });
  const m = String(r.stdout ?? "").match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(m?.[0] ?? "");
    if (KINDS[j.kind] && j.kind !== "approve") return { kind: j.kind, text: j.sentence };
  } catch {}
  return null;
}

// Which Claude Code session runs in this terminal: one JSON line per session start.
// Never throws: this must not block or fail a session.
function rememberSession(input) {
  try {
    if (!terminal || input.source === "compact") return;
    const dir = path.join(home, "data/agent-sessions");
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${terminal.replace(/[^\w.-]/g, "_")}.jsonl`);
    let last = null;
    try { last = JSON.parse(fs.readFileSync(f, "utf8").trimEnd().split("\n").pop()); } catch {}
    if (!(last && last.sessionId === input.session_id && last.source === input.source)) {
      const entry = { sessionId: input.session_id, transcriptPath: input.transcript_path, cwd: input.cwd, source: input.source, at: new Date().toISOString() };
      fs.appendFileSync(f, `${JSON.stringify(entry)}\n`);
    }
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    for (const name of fs.readdirSync(dir)) {
      try { const p = path.join(dir, name); if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}

function stdin() { try { return JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return {}; } }

function main(argv) {
  const [cmd, arg, ...rest] = argv;
  if (cmd === "hook") {
    if (!terminal || process.env.HERDR_STATUS_CHILD) return;
    const input = stdin();
    if (arg === "SessionStart") {
      rememberSession(input);
      return input.source === "compact" ? undefined : clear();
    }
    if (arg === "SessionEnd" || arg === "UserPromptSubmit") return clear();
    if (arg === "PreToolUse") {
      if (/plan_review_check$/.test(input.tool_name ?? "")) return write("review", PLAN_WAITS, "plan-review");
      const q = input.tool_input?.questions?.[0]?.question ?? input.tool_input?.question;
      if (q) write("answer", q, "question");
      return;
    }
    if (arg === "PostToolUse" || arg === "PostToolUseFailure") {
      if (read()?.source === "plan-review") clear();
      return;
    }
    if (arg === "Stop") {
      // The agent said it this turn (herdr-status, after the person's last message): keep it.
      if (read()?.source === "agent") return;
      const reply = lastReply(input.transcript_path);
      if (!reply) return;
      write("review", firstSentence(reply), "fallback");
      const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "classify-file"], { detached: true, stdio: ["pipe", "ignore", "ignore"], env: process.env });
      child.stdin.end(reply);
      child.unref();
    }
    return;
  }
  if (cmd === "classify-file") {
    const reply = fs.readFileSync(0, "utf8");
    const before = read();
    const got = classify(reply);
    // Only if nothing newer came meanwhile (the person replied, or the agent said it).
    const now = read();
    if (got && now?.source === "fallback" && now.at === before?.at) write(got.kind, got.text || now.text, "model");
    return;
  }
  // Around the blocking ExitPlanMode hook (settings.json). No PostToolUse follows a rejected
  // plan, so the wrapper ends the wait itself. Must not read stdin: that hook needs it.
  if (cmd === "plan-review") {
    if (!terminal || process.env.HERDR_STATUS_CHILD) return;
    if (arg === "start") write("review", PLAN_WAITS, "plan-review");
    else if (arg === "end" && read()?.source === "plan-review") clear();
    return;
  }
  // herdr-status <kind> "<sentence>" | clear
  if (!terminal) { console.error("herdr-status: not inside a Herdr terminal (HC_TERMINAL_ID is not set)."); process.exit(1); }
  if (cmd === "clear") return clear();
  if (!KINDS[cmd]) {
    console.error(`usage: herdr-status <kind> "<one sentence>" | herdr-status clear\nkinds:\n${Object.entries(KINDS).map(([k, v]) => `  ${k.padEnd(8)} ${v}`).join("\n")}`);
    process.exit(1);
  }
  const text = [arg, ...rest].join(" ").trim();
  if (!text) { console.error(`herdr-status: say in one sentence what you need (or did).`); process.exit(1); }
  write(cmd, text, "agent");
  console.log(`status: ${cmd} · ${oneLine(text, 160)}`);
}

main(process.argv.slice(2));
