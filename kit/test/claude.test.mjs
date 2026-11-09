import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hashFile } from "../util.mjs";
import { kit, readJson, world } from "./helpers.mjs";

const PROGRAMS = ["python3", "git", "gh", "claude", "jq"];
const settings = (w) => path.join(w.claude, "settings.json");
const manifestOf = (w) => readJson(path.join(w.state, "manifest.json"));
const backups = (w) => fs.readdirSync(w.claude).filter((f) => f.includes(".herdr-kit-"));

// What a person already has: other tools' hooks on the same events, and settings of their own.
const THEIRS = {
  model: "opus",
  permissions: { allow: ["Bash(ls)"] },
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: "/bin/other-tool hook SessionStart" }] }],
    PreToolUse: [
      { matcher: "AskUserQuestion", hooks: [{ type: "command", command: "/bin/mine ask", timeout: 5 }] },
      { matcher: "Bash", hooks: [{ type: "command", command: "/bin/mine bash" }] },
    ],
    Notification: [{ hooks: [{ type: "command", command: "/bin/notify" }] }],
  },
};
const put = (w, data) => { fs.mkdirSync(w.claude, { recursive: true }); fs.writeFileSync(settings(w), JSON.stringify(data, null, 2) + "\n"); };
const cmd = (w, event) => `node ${path.join(w.state, "current/claude/hooks/herdr-status.mjs")} hook ${event}`;
const kitGroup = (w, event, matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: cmd(w, event), timeout: 10 }] });
const PLAN_CHECK = "mcp__agent-plan-review__plan_review_check";

test("hooks: the kit's are added exactly (events, matchers, commands) and every other hook stays", async () => {
  const w = world({ programs: PROGRAMS });
  put(w, THEIRS);
  const r = await kit(w, ["--yes"]);
  assert.equal(r.code, 0, r.text);
  const now = readJson(settings(w));
  assert.equal(now.model, "opus");
  assert.deepEqual(now.permissions, THEIRS.permissions);
  assert.deepEqual(now.hooks, {
    SessionStart: [...THEIRS.hooks.SessionStart, kitGroup(w, "SessionStart")],
    PreToolUse: [...THEIRS.hooks.PreToolUse, kitGroup(w, "PreToolUse", "AskUserQuestion"), kitGroup(w, "PreToolUse", PLAN_CHECK)],
    Notification: THEIRS.hooks.Notification,
    SessionEnd: [kitGroup(w, "SessionEnd")],
    UserPromptSubmit: [kitGroup(w, "UserPromptSubmit")],
    PostToolUse: [kitGroup(w, "PostToolUse", PLAN_CHECK)],
    PostToolUseFailure: [kitGroup(w, "PostToolUseFailure", PLAN_CHECK)],
    Stop: [kitGroup(w, "Stop")],
  });
  assert.match(r.text, /restart the sessions that are running/);
  assert.equal(manifestOf(w).claude.hooks.length, 8);
  assert.equal(backups(w).length, 1);
  const d = await kit(w, ["doctor"]);
  assert.match(d.text, /All files are as the kit put them/);
});

test("hooks: a second run, and an update, add nothing and make no backup", async () => {
  const w = world({ programs: PROGRAMS });
  put(w, THEIRS);
  assert.equal((await kit(w, ["--yes"])).code, 0);
  const once = fs.readFileSync(settings(w), "utf8");
  assert.equal((await kit(w, ["--yes"])).code, 0);
  assert.equal((await kit(w, ["update", "--yes"])).code, 0);
  assert.equal(fs.readFileSync(settings(w), "utf8"), once);
  assert.equal(backups(w).length, 1);
  assert.equal(manifestOf(w).claude.hooks.length, 8);
});

test("hooks: update puts back a hook the person deleted; doctor names it first", async () => {
  const w = world({ programs: PROGRAMS });
  assert.equal((await kit(w, ["--yes"])).code, 0);
  const data = readJson(settings(w));
  delete data.hooks.Stop;
  fs.writeFileSync(settings(w), JSON.stringify(data));
  const d = await kit(w, ["doctor"]);
  assert.equal(d.code, 1);
  assert.match(d.text, /hook missing in settings.json: Stop/);
  assert.equal((await kit(w, ["update", "--yes"])).code, 0);
  assert.deepEqual(readJson(settings(w)).hooks.Stop, [kitGroup(w, "Stop")]);
});

test("uninstall puts settings.json back byte for byte; only the kit's hooks go when the person edited it since", async () => {
  const w = world({ programs: PROGRAMS });
  put(w, THEIRS);
  const original = fs.readFileSync(settings(w), "utf8");
  assert.equal((await kit(w, ["--yes"])).code, 0);
  assert.equal((await kit(w, ["uninstall", "--yes"])).code, 0);
  assert.equal(fs.readFileSync(settings(w), "utf8"), original);
  assert.deepEqual(backups(w), []);

  // Edited after the install: surgical removal.
  assert.equal((await kit(w, ["--yes"])).code, 0);
  const data = readJson(settings(w));
  data.model = "sonnet";
  data.hooks.Stop.push({ hooks: [{ type: "command", command: "/bin/after-install" }] });
  fs.writeFileSync(settings(w), JSON.stringify(data, null, 2) + "\n");
  const r = await kit(w, ["uninstall", "--yes"]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /only the kit's hooks were taken out/);
  assert.deepEqual(readJson(settings(w)), { ...THEIRS, model: "sonnet", hooks: { ...THEIRS.hooks, Stop: [{ hooks: [{ type: "command", command: "/bin/after-install" }] }] } });
});

test("a Claude folder and settings.json the kit made are removed on uninstall", async () => {
  const w = world({ programs: PROGRAMS });
  assert.ok(!fs.existsSync(w.claude));
  assert.equal((await kit(w, ["--yes"])).code, 0);
  assert.ok(fs.existsSync(settings(w)));
  assert.equal((await kit(w, ["uninstall", "--yes"])).code, 0);
  assert.ok(!fs.existsSync(w.claude));
});

test("a settings.json that is not valid JSON stops the install and is not touched", async () => {
  const w = world({ programs: PROGRAMS });
  fs.mkdirSync(w.claude);
  fs.writeFileSync(settings(w), '{ "hooks": ');
  const r = await kit(w, ["--yes"]);
  assert.equal(r.code, 1);
  assert.match(r.text, /settings.json: it is not valid JSON/);
  assert.equal(fs.readFileSync(settings(w), "utf8"), '{ "hooks": ');
  assert.ok(!fs.existsSync(w.state));
});

test("without Claude Code the statuses piece is off: no hooks, no settings.json", async () => {
  const w = world({ programs: ["python3", "git", "gh"] });
  const r = await kit(w, ["--yes"]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Agent statuses \(statuses\).*Off: Claude Code \(claude\) was not found/);
  assert.ok(!fs.existsSync(w.claude));
  assert.ok(!fs.existsSync(path.join(w.links, "herdr-status")));
});

test("status line: --yes adds it only when there is none; uninstall takes it out", async () => {
  const w = world({ programs: PROGRAMS });
  assert.equal((await kit(w, ["--yes"])).code, 0);
  assert.deepEqual(readJson(settings(w)).statusLine, { type: "command", command: path.join(w.state, "current/claude/statusline-herdr.sh") });
  assert.ok(fs.existsSync(path.join(w.state, "current/claude/statusline-herdr.sh")));
  assert.equal((await kit(w, ["uninstall", "--yes"])).code, 0);
  assert.ok(!fs.existsSync(settings(w)));

  const mine = { type: "command", command: "~/my-line.sh" };
  put(w, { statusLine: mine });
  assert.equal((await kit(w, ["--yes"])).code, 0);
  assert.deepEqual(readJson(settings(w)).statusLine, mine, "--yes keeps the person's status line");
  assert.equal(manifestOf(w).claude.statusLine, null);
});

test("status line: asked 'Add the Herdr status line?' (default yes) when there is none", async () => {
  const w = world({ programs: PROGRAMS });
  // pieces: Enter, work folders: Enter, status line: Enter (= yes), Go ahead: Enter
  assert.equal((await kit(w, [], { answers: ["", "", "", ""] })).code, 0);
  assert.ok(readJson(settings(w)).statusLine);
  assert.equal((await kit(w, ["uninstall"], { answers: ["y"] })).code, 0);

  const w2 = world({ programs: PROGRAMS });
  const r = await kit(w2, [], { answers: ["", "", "n", ""] });
  assert.match(r.asked, /Add the Herdr status line\? \[Y\/n\]/);
  assert.equal(readJson(settings(w2)).statusLine, undefined);
});

test("status line: asked 'Replace your Claude Code status line?' (default no); replace and uninstall give it back", async () => {
  const mine = { type: "command", command: "~/my-line.sh", padding: 1 };
  const keep = world({ programs: PROGRAMS });
  put(keep, { statusLine: mine });
  const r = await kit(keep, [], { answers: ["", "", "", ""] });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(readJson(settings(keep)).statusLine, mine);

  const w = world({ programs: PROGRAMS });
  put(w, { model: "opus", statusLine: mine });
  const a = await kit(w, [], { answers: ["", "", "y", ""] });
  assert.equal(a.code, 0, a.text);
  assert.match(a.asked, /Replace your Claude Code status line\? \[y\/N\]/);
  assert.equal(readJson(settings(w)).statusLine.command, path.join(w.state, "current/claude/statusline-herdr.sh"));
  assert.deepEqual(manifestOf(w).claude.statusLine.previous, mine);

  // The person edits the file after the install: uninstall still gives the old status line back.
  const data = readJson(settings(w));
  data.model = "sonnet";
  fs.writeFileSync(settings(w), JSON.stringify(data));
  assert.equal((await kit(w, ["uninstall", "--yes"])).code, 0);
  assert.deepEqual(readJson(settings(w)), { model: "sonnet", statusLine: mine });

  // Untouched since the install: the file is back byte for byte.
  const w3 = world({ programs: PROGRAMS });
  put(w3, { model: "opus", statusLine: mine });
  const before = fs.readFileSync(settings(w3), "utf8");
  assert.equal((await kit(w3, [], { answers: ["", "", "y", ""] })).code, 0);
  assert.equal((await kit(w3, ["uninstall", "--yes"])).code, 0);
  assert.equal(fs.readFileSync(settings(w3), "utf8"), before);
});

test("status line: without jq it is not offered", async () => {
  const w = world({ programs: ["python3", "git", "gh", "claude"] });
  const r = await kit(w, ["--yes"]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /No Herdr status line: jq was not found/);
  assert.equal(readJson(settings(w)).statusLine, undefined);
});

test("SessionStart: the installed hook gives the agent the herdr-status instruction only inside Herdr", async () => {
  const w = world({ programs: PROGRAMS });
  assert.equal((await kit(w, ["--yes"])).code, 0);
  const script = path.join(w.state, "current/claude/hooks/herdr-status.mjs");
  const base = { PATH: process.env.PATH, HOME: w.root, HERDR_APP_HOME: w.home };
  const hook = (env, source = "startup") => spawnSync("node", [script, "hook", "SessionStart"], {
    env: { ...base, ...env }, input: JSON.stringify({ session_id: "s1", source, cwd: "/x", transcript_path: "/x/t" }), encoding: "utf8",
  });

  const inside = hook({ HC_TERMINAL_ID: "t9" });
  assert.equal(inside.status, 0, inside.stderr);
  const out = JSON.parse(inside.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  const text = out.hookSpecificOutput.additionalContext;
  assert.match(text, /herdr-status <kind> "<one sentence>"/);
  for (const kind of ["answer", "blocked", "review", "done", "waiting"]) assert.match(text, new RegExp(`${kind} \\(`));
  assert.ok(fs.existsSync(path.join(w.home, "data/agent-sessions/t9.jsonl")), "the session line is written as before");

  assert.equal(hook({}).stdout, "", "outside Herdr: nothing");
  assert.equal(hook({ HC_TERMINAL_ID: "t9", HERDR_STATUS_NO_CONTEXT: "1" }).stdout, "", "switched off");
  assert.equal(hook({ HC_TERMINAL_ID: "t9" }, "compact").stdout, "", "not after a compaction");
  assert.equal(hook({ HC_TERMINAL_ID: "t9", HERDR_STATUS_CHILD: "1" }).stdout, "", "not in the classifier's own run");
});

test("hook files stay as the kit wrote them (doctor sees a changed hook script)", async () => {
  const w = world({ programs: PROGRAMS });
  assert.equal((await kit(w, ["--yes"])).code, 0);
  const f = path.join(w.state, "0.1.0/claude/hooks/herdr-status.mjs");
  assert.equal(hashFile(f), manifestOf(w).tools.files["claude/hooks/herdr-status.mjs"]);
  fs.appendFileSync(f, "// x\n");
  assert.match((await kit(w, ["doctor"])).text, /changed: .*herdr-status.mjs/);
});
