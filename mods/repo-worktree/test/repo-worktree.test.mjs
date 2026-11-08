// Run: node --experimental-default-type=module --test ~/.config/herdr-app/mods/repo-worktree/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { render, slug, shellQuote, placeholders } from "../template.js";
import { parseConfig, entryFor } from "../config.js";
import { getStrategy } from "../strategies/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const HOME = "/Users/me";
const command = getStrategy("command");

test("template: fills, filters, quotes and refuses unknown names", () => {
  assert.equal(render("{repo.parent}/website-{folder}", { "repo.parent": "/p", folder: "x" }), "/p/website-x");
  assert.equal(render("{branch:slug}", { branch: "feat/PF-1 Fix" }), "feat-PF-1-Fix");
  assert.equal(render("a={v}", { v: "it's x" }, { quote: true }), `a='it'\\''s x'`);
  assert.throws(() => render("{nope}", {}), /Unknown placeholder \{nope\}/);
  assert.throws(() => render("{v:upper}", { v: "x" }), /Unknown filter/);
  assert.equal(slug("--a//b--"), "a-b");
  assert.equal(shellQuote(""), "''");
  assert.deepEqual(placeholders("{a} {b:slug}"), [{ name: "a", filter: null }, { name: "b", filter: "slug" }]);
});

test("config: no file and unlisted repos use git: Herdr's folder, in the background, with the defaults", () => {
  const ctx = { "repo.main": "/r/app", "repo.parent": "/r", "repo.name": "app", "repo.top": "/r/app", home: HOME };
  for (const text of [null, "", "{}", '{"repos":{}}']) {
    const e = entryFor(parseConfig(text, HOME), "/any/repo");
    assert.equal(e.strategy, "git");
    const plan = getStrategy("git").plan(e.options, { name: "feat/x" }, ctx);
    assert.equal(plan.kind, "space");
    assert.equal(plan.path, `${HOME}/.herdr/worktrees/app/feat-x`);
    assert.equal(plan.space, "app-feat-x");
    assert.equal(plan.background, true);
  }
  const withDefaults = parseConfig(JSON.stringify({ defaults: { agent: ["opencode"] }, repos: { "~/w": { strategy: "command", path: "{repo.parent}/w-{name}", run: "x", agent: ["claude"] } } }), HOME);
  assert.deepEqual(entryFor(withDefaults, "/elsewhere").options.agent, ["opencode"]);
  assert.deepEqual(entryFor(withDefaults, `${HOME}/w`).options.agent, ["claude"]);
  assert.match(parseConfig('{"defaults": []}', HOME).errors[0], /"defaults" must be an object/);
});

test("git strategy: creates a branch, or checks out one that exists, under Herdr's folder", () => {
  const { root, main, ctx } = sandbox();
  execFileSync("git", ["-C", main, "branch", "old"]);
  const g = getStrategy("git");
  const c = { ...ctx, home: root };
  for (const name of ["new/one", "old"]) {
    const r = runPlan(g.plan({}, { name }, c));
    assert.equal(r.status, 0, r.stderr);
    const dir = join(root, ".herdr", "worktrees", "repo", name.replace("/", "-"));
    assert.equal(execFileSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8" }).trim(), name);
  }
});

test("config: broken file and broken entries are reported, not ignored", () => {
  assert.match(entryFor(parseConfig("{nope", HOME), "/r").errors[0], /Not valid JSON/);
  assert.match(entryFor(parseConfig('{"repos":[]}', HOME), "/r").errors[0], /"repos" must be an object/);
  const c = parseConfig(JSON.stringify({ repos: { "~/a": { strategy: "magic" }, "~/b": { strategy: "command" }, "~/c": "x" } }), HOME);
  assert.match(entryFor(c, `${HOME}/a`).errors[0], /Unknown strategy "magic"/);
  assert.deepEqual(entryFor(c, `${HOME}/b`).errors, ['"path" is required (a string).', '"run" is required (a string).']);
  assert.match(entryFor(c, `${HOME}/c`).errors[0], /must be an object/);
  assert.equal(entryFor(c, "/other").strategy, "git");
});

test("command: validation catches bad placeholders, defaults and options", () => {
  const base = { path: "{repo.parent}/x-{name}", run: "echo {name}" };
  assert.deepEqual(command.validate(base), []);
  assert.match(command.validate({ ...base, run: "echo {oops}" })[0], /uses \{oops\}/);
  assert.match(command.validate({ ...base, fields: [{ name: "a", default: "{b}" }, { name: "b" }], run: "x", path: "y" })[0], /not a field above it/);
  assert.match(command.validate({ ...base, fields: [{ name: "home" }] })[0], /reserved/);
  assert.match(command.validate({ ...base, agent: "claude" })[0], /"agent" must be an array/);
  assert.match(command.validate({ ...base, nonZeroExit: "maybe" })[0], /nonZeroExit/);
  assert.match(command.validate({ ...base, path: "{name:upper}" })[0], /unknown filter/);
});

test("website config: valid, matched by ~ path, one name field builds the make command", () => {
  const text = readFileSync(join(here, "..", "..", "..", "repo-worktree.json"), "utf8");
  const entry = entryFor(parseConfig(text, "/Users/pavlopetricenko"), "/Users/pavlopetricenko/Desktop/project/website");
  assert.equal(entry.errors, undefined, String(entry.errors));
  assert.equal(entry.strategy, "command");
  assert.deepEqual(command.fields(entry.options).map((f) => f.name), ["name"]);
  const ctx = { "repo.main": "/Users/pavlopetricenko/Desktop/project/website", "repo.parent": "/Users/pavlopetricenko/Desktop/project", "repo.name": "website", "repo.top": "/Users/pavlopetricenko/Desktop/project/website", home: "/Users/pavlopetricenko" };
  const plan = command.plan(entry.options, { name: "PF-1_Fix/it" }, ctx);
  assert.equal(plan.kind, "space");
  assert.equal(plan.background, true);
  assert.equal(plan.space, "website-PF-1_Fix-it");
  assert.equal(plan.folder, "/Users/pavlopetricenko/Desktop/project/website");
  assert.equal(plan.path, "/Users/pavlopetricenko/Desktop/project/website-PF-1_Fix-it");
  assert.match(plan.argv[2], /make worktree branch='PF-1_Fix\/it' folder='PF-1_Fix-it' services='frontend [^']+' base=master/);
  assert.match(plan.argv[2], /'claude'/);
  assert.match(command.plan(entry.options, { name: " " }, ctx).error, /Type a name/);
});

// The generated script, run for real against a throwaway repo.
function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-worktree-")));
  const main = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  execFileSync("git", ["-C", main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const ctx = { "repo.main": main, "repo.parent": root, "repo.name": "repo", "repo.top": main, home: root };
  return { root, main, ctx };
}
// SHELL=true: the closing interactive shell exits at once, so the test sees the script's end.
// The OSC 7501 reports a run sent: [state, app, msg].
const reports = (out) => [...out.matchAll(/\x1b\]7501;state=(\w+):app=([^:]*):msg=([^\x07]*)\x07/g)].map(([, st, app, msg]) => [st, app, Buffer.from(msg, "base64").toString()]);
// No Herdr variables: a script that closes "its own space" must never reach the real window.
const testEnv = () => {
  const env = { ...process.env, SHELL: "/usr/bin/true" };
  for (const k of Object.keys(env)) if (/^(HC_|HERDR_)/.test(k)) delete env[k];
  env.PATH = env.PATH.split(":").filter((d) => !d.endsWith("/.local/bin")).join(":");
  return env;
};
const runPlan = (plan, pathFirst) => {
  const env = testEnv();
  if (pathFirst) env.PATH = `${pathFirst}:${env.PATH}`;
  return spawnSync(plan.argv[0], plan.argv.slice(1), { cwd: plan.folder, encoding: "utf8", env });
};

const opts = (extra = {}) => ({
  fields: [{ name: "branch", required: true }, { name: "note", default: "it's {branch}" }],
  path: "{repo.parent}/repo-{branch:slug}",
  run: "git worktree add -q -b {branch} {repo.parent}/repo-{branch:slug} && printf %s {note} > {repo.parent}/note",
  after: "pwd > {repo.parent}/after",
  agent: ["sh", "-c", "pwd > \"$0\"", "{repo.parent}/agent"],
  ...extra,
});

test("script: creates the checkout, runs after and the agent inside it", () => {
  const { root, ctx } = sandbox();
  const o = opts();
  assert.deepEqual(command.validate(o), []);
  const plan = command.plan(o, command.defaults(o, { branch: "feat/x" }, { branch: true }, ctx), ctx);
  const r = runPlan(plan);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(root, "repo-feat-x", ".git")));
  assert.equal(readFileSync(join(root, "note"), "utf8"), "it's feat/x");
  assert.equal(readFileSync(join(root, "after"), "utf8").trim(), join(root, "repo-feat-x"));
  assert.equal(readFileSync(join(root, "agent"), "utf8").trim(), join(root, "repo-feat-x"));
  assert.deepEqual(reports(r.stdout), [["working", "repo-feat-x", "Creating repo-feat-x"], ["done", "repo-feat-x", "repo-feat-x is ready"]]);
  // Again: it exists, so the command is skipped and the agent still starts there.
  writeFileSync(join(root, "agent"), "");
  const again = runPlan(plan);
  assert.match(again.stdout, /Worktree already exists/);
  assert.equal(readFileSync(join(root, "agent"), "utf8").trim(), join(root, "repo-feat-x"));
});

test("script: a failed command that made nothing stops before the agent", () => {
  const { root, ctx } = sandbox();
  const o = opts({ run: "echo boom >&2; exit 3" });
  const r = runPlan(command.plan(o, { branch: "b", note: "" }, ctx));
  assert.match(r.stderr, /exited with 3 and .*repo-b was not created/);
  assert.equal(reports(r.stdout).at(-1)[0], "blocked");
  assert.ok(!existsSync(join(root, "agent")));
});

test("script: nonZeroExit decides about a failed command that left a checkout", () => {
  for (const [mode, agentRuns, message] of [["warn-if-created", true, /⚠ The command exited with 5/], ["fail", false, /✗ The command exited with 5\. .* is left as it is/]]) {
    const { root, ctx } = sandbox();
    const o = opts({ run: "git worktree add -q -b {branch} {repo.parent}/repo-{branch}; exit 5", nonZeroExit: mode });
    const r = runPlan(command.plan(o, { branch: "w", note: "" }, ctx));
    assert.match(r.stderr, message);
    assert.equal(existsSync(join(root, "agent")), agentRuns, mode);
  }
});

test("worktrees: parse, sort, filter, exact match, space and age", async () => {
  const { parseWorktrees, filterWorktrees, exactMatch, spaceFor, ago } = await import("../worktrees.js");
  const porcelain = [
    "worktree /p/website\nHEAD a\nbranch refs/heads/master",
    "worktree /p/website-old\nHEAD b\nbranch refs/heads/old",
    "worktree /p/website-PF-1_fix\nHEAD c\nbranch refs/heads/PF-1/fix",
    "worktree /p/website-gone\nHEAD d\nbranch refs/heads/gone\nprunable gitdir file points to non-existent location",
    "worktree /p/website-detached\nHEAD e\ndetached",
    "worktree /p/website/.claude/worktrees/agent-1\nHEAD f\nbranch refs/heads/agent-1",
  ].join("\n\n");
  const refs = "master\t100\nold\t200\nPF-1/fix\t300\ngone\t400";
  const list = parseWorktrees(porcelain, refs);
  assert.deepEqual(list.map((c) => c.name), ["website", "website-PF-1_fix", "website-old", "website-detached"]);
  assert.equal(list[0].main, true);
  assert.equal(list[3].branch, null);
  assert.deepEqual(filterWorktrees(list, "fix").map((c) => c.name), ["website-PF-1_fix"]);
  assert.deepEqual(filterWorktrees(list, "WEB old").map((c) => c.name), ["website-old"]);
  assert.equal(filterWorktrees(list, "").length, 4);
  assert.equal(exactMatch(list, "PF-1/fix")?.name, "website-PF-1_fix");
  assert.equal(exactMatch(list, "x", "website-old")?.name, "website-old");
  assert.equal(exactMatch(list, "fix", "website-fix"), null);
  assert.equal(exactMatch(list, "  "), null);
  // The deepest checkout wins: a space in a worktree is not the main checkout's.
  const places = [{ id: "a", folder: "/p/website/api" }, { id: "b", folder: "/p/website-old/src" }, { id: "c", folder: "/p/websiteX" }];
  assert.equal(spaceFor("/p/website", list, places)?.id, "a");
  assert.equal(spaceFor("/p/website-old", list, places)?.id, "b");
  assert.equal(spaceFor("/p/website-PF-1_fix", list, places), null);
  assert.equal(ago(1000, 1000 + 120), "2m");
  assert.equal(ago(1000, 1000 + 3 * 86400), "3d");
  assert.equal(ago(0), "");
});

test("remove: options are validated", async () => {
  const { validateRemove } = await import("../remover.js");
  assert.deepEqual(validateRemove(undefined), []);
  assert.deepEqual(validateRemove({ deleteBranch: false, docker: true }), []);
  assert.match(validateRemove({ branch: true })[0], /unknown option "branch"/);
  assert.match(validateRemove({ docker: "yes" })[0], /must be true or false/);
  assert.match(validateRemove({ plans: "no" })[0], /"remove.plans" must be true or false/);
  assert.deepEqual(validateRemove({ plans: false }), []);
  assert.match(validateRemove([])[0], /must be an object/);
});

test("remove: deletes many checkouts and their branches, keeps the rest, refuses the main one", async () => {
  const { removePlan } = await import("../remover.js");
  const { root, main } = sandbox();
  const git = (...a) => execFileSync("git", ["-C", main, ...a], { encoding: "utf8" });
  for (const b of ["a", "b/two", "keep"]) git("worktree", "add", "-q", "-b", b, join(root, `repo-${b.replace("/", "-")}`));
  writeFileSync(join(root, "repo-a", "dirty.txt"), "x");
  const items = [{ path: join(root, "repo-a"), name: "repo-a", branch: "a" }, { path: join(root, "repo-b-two"), name: "repo-b-two", branch: "b/two" }];
  const plan = removePlan(items, main);
  assert.equal(plan.space, "removing 2 worktrees");
  const r = runPlan(plan);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(root, "repo-a")) && !existsSync(join(root, "repo-b-two")));
  assert.ok(existsSync(join(root, "repo-keep", ".git")));
  assert.deepEqual(git("branch", "--format=%(refname:short)").trim().split("\n").sort(), ["keep", "main"]);
  assert.doesNotMatch(git("worktree", "list"), /repo-a|repo-b-two/);
  assert.deepEqual(reports(r.stdout).map(([s]) => s), ["working", "done"]);
  assert.match(removePlan([{ path: main, name: "repo", branch: "main" }], main).error, /Only linked/);
  assert.match(removePlan([], main).error, /Nothing/);
});

test("remove: deleteBranch false keeps branches; a folder that cannot go is reported, its branch kept", async () => {
  const { removePlan } = await import("../remover.js");
  const { root, main } = sandbox();
  const git = (...a) => execFileSync("git", ["-C", main, ...a], { encoding: "utf8" });
  git("worktree", "add", "-q", "-b", "x", join(root, "repo-x"));
  git("worktree", "add", "-q", "-b", "stuck", join(root, "repo-stuck"));
  const r1 = runPlan(removePlan([{ path: join(root, "repo-x"), name: "repo-x", branch: "x" }], main, { deleteBranch: false }));
  assert.equal(r1.status, 0, r1.stderr);
  assert.ok(!existsSync(join(root, "repo-x")));
  assert.match(git("branch"), /\bx\b/);
  // An immutable file: rm fails even after chmod.
  writeFileSync(join(root, "repo-stuck", "locked"), "x");
  execFileSync("chflags", ["uchg", join(root, "repo-stuck", "locked")]);
  try {
    const r2 = runPlan(removePlan([{ path: join(root, "repo-stuck"), name: "repo-stuck", branch: "stuck" }], main));
    assert.match(r2.stderr, /✗ repo-stuck/);
    assert.match(r2.stderr, /1 of 1 failed/);
    assert.equal(reports(r2.stdout).at(-1)[0], "blocked");
    assert.match(git("branch"), /\bstuck\b/);
  } finally {
    execFileSync("chflags", ["nouchg", join(root, "repo-stuck", "locked")]);
  }
});

test("remove: by default it stops and removes the checkout's containers, and only those", async () => {
  const { removePlan } = await import("../remover.js");
  const { root, main } = sandbox();
  execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "c", join(root, "repo-c")]);
  const wt = join(root, "repo-c");
  // A fake docker: c1 mounts a folder inside the checkout, c2 is a compose project started
  // there, c3 belongs to another checkout. It logs every removal.
  const bin = join(root, "bin");
  execFileSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "docker"), `#!/bin/sh
case "$1" in
  info) exit 0 ;;
  ps) printf 'c1\\nc2\\nc3\\n' ;;
  inspect)
    case "$2" in -f) echo "/name-$4"; exit 0 ;; esac
    case "$2" in c1) printf '${wt}/api\\n' ;; c2) printf '/var/x\\n${wt}' ;; c3) printf '${root}/repo-other/api\\n${root}/repo-cc' ;; esac ;;
  rm) echo "$*" >> "${root}/docker.log" ;;
esac
`);
  execFileSync("chmod", ["+x", join(bin, "docker")]);
  const r = runPlan(removePlan([{ path: wt, name: "repo-c", branch: "c" }], main), bin);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(join(root, "docker.log"), "utf8").trim().split("\n"), ["rm -f -v c1", "rm -f -v c2"]);
  assert.match(r.stdout, /Removing container name-c1/);
  assert.ok(!existsSync(wt));
  // docker: false leaves containers alone.
  execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "d", join(root, "repo-d")]);
  writeFileSync(join(root, "docker.log"), "");
  runPlan(removePlan([{ path: join(root, "repo-d"), name: "repo-d", branch: "d" }], main, { docker: false }), bin);
  assert.equal(readFileSync(join(root, "docker.log"), "utf8"), "");
});

test("remove: plans option forgets each checkout's plans, tolerates a missing or old agent-plan-review", async () => {
  const { removePlan, REMOVE_DEFAULTS } = await import("../remover.js");
  assert.equal(REMOVE_DEFAULTS.plans, true);
  const { root, main } = sandbox();
  const git = (...a) => execFileSync("git", ["-C", main, ...a], { encoding: "utf8" });
  const names = ["p1", "p 2"];
  const items = names.map((n) => ({ path: join(root, `repo-${n}`), name: `repo-${n}`, branch: n.replace(" ", "") }));
  const add = () => items.forEach((c) => { if (!existsSync(c.path)) git("worktree", "add", "-q", "-b", c.branch + Math.random().toString(36).slice(2, 6), c.path); });
  const script = (opts) => removePlan(items, main, opts).argv[2];
  // Script shape: default on, quoted paths, per checkout; off is absent.
  for (const c of items) assert.ok(script().includes(`forget_plans ${shellQuote(c.path)};`));
  assert.ok(script().includes("agent-plan-review forget --worktree"));
  assert.ok(!script({ plans: false }).includes("agent-plan-review forget"));

  const fake = (body) => {
    const bin = join(root, "bin-apr");
    execFileSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, "agent-plan-review"), `#!/bin/sh\n${body}\n`);
    execFileSync("chmod", ["+x", join(bin, "agent-plan-review")]);
    return bin;
  };
  // Working forget: called once per checkout with the path; its output is in the job output.
  add();
  let bin = fake(`echo "$@" >> "${root}/apr.log"; echo "forgot 2 plans"`);
  let r = runPlan(removePlan(items, main), bin);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(join(root, "apr.log"), "utf8").trim().split("\n").sort(), items.map((c) => `forget --worktree ${c.path}`).sort());
  assert.match(r.stdout, /forgot 2 plans/);
  assert.ok(items.every((c) => !existsSync(c.path)));
  // plans: false never calls it.
  add();
  writeFileSync(join(root, "apr.log"), "");
  r = runPlan(removePlan(items, main, { plans: false }), bin);
  assert.equal(readFileSync(join(root, "apr.log"), "utf8"), "");
  // Old version: unknown command is skipped with one line, removal succeeds.
  add();
  bin = fake(`echo "error: unknown command 'forget'" >&2; exit 2`);
  r = runPlan(removePlan(items, main), bin);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /plans: agent-plan-review has no forget command; skipped/);
  // Old version that prints its usage text and exits 1: also skipped.
  add();
  bin = fake(`printf 'agent-plan-review — a local review surface\\n\\nUsage:\\n  agent-plan-review <command>\\n\\nCommands:\\n  serve  start\\n'; exit 1`);
  r = runPlan(removePlan(items, main), bin);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /plans: agent-plan-review has no forget command; skipped/);
  assert.doesNotMatch(r.stdout, /Usage:/);
  // Real error: shown, removal still succeeds.
  add();
  bin = fake(`echo "database locked" >&2; exit 1`);
  r = runPlan(removePlan(items, main), bin);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /database locked/);
  assert.match(r.stdout, /forget failed/);
  assert.doesNotMatch(r.stderr, /failed\./);
  assert.deepEqual(reports(r.stdout).map(([s]) => s), ["working", "done"]);
});

test("snapshot: one git call gives the repo and its checkouts, from any checkout", async () => {
  const { SNAPSHOT, parseSnapshot } = await import("../worktrees.js");
  const { root, main } = sandbox();
  execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "w", join(root, "repo-w")]);
  for (const from of [main, join(root, "repo-w")]) {
    const out = execFileSync("/bin/sh", ["-c", SNAPSHOT, "sh", from], { encoding: "utf8" });
    const snap = parseSnapshot(out);
    assert.deepEqual(snap.repo, { top: from, main, name: "repo", parent: root });
    assert.deepEqual(snap.list.map((c) => c.name), ["repo", "repo-w"]);
    assert.ok(snap.list[1].at > 0);
  }
  const outside = spawnSync("/bin/sh", ["-c", SNAPSHOT, "sh", root], { encoding: "utf8" });
  assert.equal(parseSnapshot(outside.stdout), null);
});

test("the list scrolls only when the chosen row is out of view", async () => {
  const { scrollTarget } = await import("../worktrees.js");
  assert.equal(scrollTarget(0, 0, 8), null);
  assert.equal(scrollTarget(7, 0, 8), null);
  assert.equal(scrollTarget(8, 0, 8), 1); // down past the last visible row
  assert.equal(scrollTarget(3, 5, 8), 3); // up past the first visible row
  assert.equal(scrollTarget(0, 6, 8), 0); // wrap to the top
  assert.equal(scrollTarget(13, 0, 8), 6); // wrap to the bottom
});
