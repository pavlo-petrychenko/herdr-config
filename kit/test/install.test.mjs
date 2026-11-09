import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { trimLayout } from "../layout.mjs";
import { hashFile } from "../util.mjs";
import { DEFAULT_KEYS, calls, kit, readJson, shownLayout, snapshot, world } from "./helpers.mjs";

const manifestOf = (w) => readJson(path.join(w.state, "manifest.json"));

test("setup --yes installs every piece, writes a manifest that matches the files, and shows main-flat", async () => {
  const w = world({ programs: ["python3", "git", "gh", "agent-plan-review"] });
  const r = await kit(w, ["--yes"]);
  assert.equal(r.code, 0, r.text);
  const m = manifestOf(w);
  assert.equal(m.version, "0.1.0");
  assert.equal(m.home, w.home);
  assert.deepEqual(m.pieces.sort(), ["core", "file-viewer", "plan", "prs", "repo-worktree", "viewbar"]);
  assert.deepEqual(m.herdr.mods.sort(), ["agent-queue", "agent-usage", "file-viewer", "prs", "repo-worktree", "space-groups", "spaces-flat", "viewbar"]);
  for (const [rel, hash] of Object.entries(m.herdr.files)) assert.equal(hashFile(path.join(w.home, rel)), hash, rel);
  assert.ok(m.herdr.files["layouts/main-flat.json"]);
  assert.ok(m.herdr.files["mods/spaces-flat/styles.js"]);
  assert.ok(!Object.keys(m.herdr.files).some((f) => f.includes("/test/")), "no test files");
  // Starter config: written because there was none.
  assert.deepEqual(readJson(path.join(w.home, "space-groups.json")).groups, []);
  assert.deepEqual(readJson(path.join(w.home, "repo-worktree.json")).repos, {});
  // Keys: Herdr's own stay, the kit's are added.
  const keys = readJson(path.join(w.home, "keys.json"));
  assert.equal(keys.global["cmd-w"], "tab.close");
  assert.equal(keys.global["cmd-shift-n"], "mod.open:repo-worktree");
  assert.equal(keys["layout:main-flat"]["cmd-w"], "viewbar.close");
  assert.match(r.text, /new Herdr shortcuts must be added to keys.json by hand/);
  assert.ok(fs.existsSync(m.herdr.keys.backup));
  // The Plan view ran, the layout keeps every block, and main-flat shows.
  assert.match(fs.readFileSync(path.join(w.fakeState, "apr.log"), "utf8"), /herdr enable\nherdr install/);
  assert.ok(JSON.stringify(readJson(path.join(w.home, "layouts", "main-flat.json"))).includes('"plan-review"'));
  assert.equal(shownLayout(w), "main-flat");
  assert.match(r.text, /shift-l switches back/);

  const d = await kit(w, ["doctor"]);
  assert.equal(d.code, 0, d.text);
  assert.match(d.text, /All files are as the kit put them/);
});

test("uninstall puts the home back as it was (keys.json byte for byte) and switches to main", async () => {
  const w = world({ programs: ["python3", "git", "gh", "agent-plan-review"] });
  const before = snapshot(w.home);
  assert.equal((await kit(w, ["--yes"])).code, 0);
  const r = await kit(w, ["uninstall", "--yes"]);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(snapshot(w.home), before);
  assert.equal(shownLayout(w), "main");
  assert.ok(!fs.existsSync(path.join(w.state, "manifest.json")));
  assert.match(fs.readFileSync(path.join(w.fakeState, "apr.log"), "utf8"), /herdr uninstall\nherdr disable/);
});

test("a file the person changed is kept on update and on uninstall, and doctor names it", async () => {
  const w = world();
  assert.equal((await kit(w, ["--yes"])).code, 0);
  const mine = path.join(w.home, "mods", "viewbar", "main.js");
  fs.appendFileSync(mine, "// my change\n");
  fs.appendFileSync(path.join(w.home, "repo-worktree.json"), "\n");

  const d = await kit(w, ["doctor"]);
  assert.equal(d.code, 1);
  assert.match(d.text, /changed by you: mods\/viewbar\/main.js/);

  const u = await kit(w, ["update", "--yes"]);
  assert.equal(u.code, 0, u.text);
  assert.match(u.text, /Kept mods\/viewbar\/main.js: you changed it/);
  assert.match(fs.readFileSync(mine, "utf8"), /my change/);

  const r = await kit(w, ["uninstall", "--yes"]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Kept mods\/viewbar\/main.js: you changed it/);
  assert.match(r.text, /Kept repo-worktree.json/);
  assert.match(r.text, /Kept mods\/viewbar\/: it holds files the kit did not put there/);
  assert.deepEqual(fs.readdirSync(path.join(w.home, "mods", "viewbar")), ["main.js"]);
  assert.ok(fs.existsSync(path.join(w.home, "repo-worktree.json")));
});

test("update removes an unchanged file the new version no longer has, and rebuilds the flat sidebar", async () => {
  const w = world();
  assert.equal((await kit(w, ["--yes"])).code, 0);
  const old = path.join(w.home, "mods", "viewbar", "old.js");
  fs.writeFileSync(old, "// from an older version\n");
  const m = manifestOf(w);
  m.herdr.files["mods/viewbar/old.js"] = hashFile(old);
  fs.writeFileSync(path.join(w.state, "manifest.json"), JSON.stringify(m));
  fs.writeFileSync(path.join(w.fakeState, "layout"), "terminals");

  const u = await kit(w, ["update", "--yes"]);
  assert.equal(u.code, 0, u.text);
  assert.ok(!fs.existsSync(old));
  assert.ok(!manifestOf(w).herdr.files["mods/viewbar/old.js"]);
  assert.ok(calls(w).filter((c) => c[1] === "mod.clone").length === 2, "spaces-flat cloned again");
  assert.ok(!fs.readdirSync(path.join(w.home, "mods")).some((f) => f.includes(".old")), "no old copies left");
  assert.equal(shownLayout(w), "terminals", "the update goes back to the layout shown before");
});

test("uninstall after the person edited keys.json takes out only the kit's keys", async () => {
  const w = world();
  assert.equal((await kit(w, ["--yes"])).code, 0);
  const file = path.join(w.home, "keys.json");
  const keys = readJson(file);
  keys.global["cmd-k"] = "app.palette";
  keys.global["cmd-shift-g"] = "my.own";
  fs.writeFileSync(file, JSON.stringify(keys, null, 2));
  const r = await kit(w, ["uninstall", "--yes"]);
  assert.equal(r.code, 0, r.text);
  const after = readJson(file);
  assert.deepEqual(after, { ...DEFAULT_KEYS, global: { ...DEFAULT_KEYS.global, "cmd-k": "app.palette", "cmd-shift-g": "my.own" } });
  assert.match(r.text, /Kept key cmd-shift-g in "global": you changed it/);
});

test("a clashing key stays the person's with --yes; asked, the kit's wins and uninstall gives theirs back", async () => {
  const setKey = (w) => {
    const k = structuredClone(DEFAULT_KEYS);
    k.global["cmd-shift-n"] = "space.new";
    fs.writeFileSync(path.join(w.home, "keys.json"), JSON.stringify(k, null, 2) + "\n");
  };
  const a = world();
  setKey(a);
  const r1 = await kit(a, ["--yes"]);
  assert.match(r1.text, /clash: cmd-shift-n in "global" is yours \(space.new\)/);
  assert.equal(readJson(path.join(a.home, "keys.json")).global["cmd-shift-n"], "space.new");

  const b = world();
  setKey(b);
  const before = fs.readFileSync(path.join(b.home, "keys.json"), "utf8");
  // Pieces: Enter. Work folders: "~/work". Clash: y. Go ahead: Enter.
  const r2 = await kit(b, [], { answers: ["", "~/work", "y", ""] });
  assert.equal(r2.code, 0, r2.text);
  assert.equal(readJson(path.join(b.home, "keys.json")).global["cmd-shift-n"], "mod.open:repo-worktree");
  assert.deepEqual(readJson(path.join(b.home, "space-groups.json")).groups, [{ name: "Work", folders: ["~/work/**"] }]);
  // Change the file so the backup cannot go back whole: the kit's key still gives way to theirs.
  fs.appendFileSync(path.join(b.home, "keys.json"), " ");
  await kit(b, ["uninstall", "--yes"]);
  assert.deepEqual(readJson(path.join(b.home, "keys.json")), JSON.parse(before));
});

test("refuses a home that is a git checkout, and changes nothing", async () => {
  const w = world();
  fs.mkdirSync(path.join(w.home, ".git"));
  const before = snapshot(w.home);
  const r = await kit(w, ["--yes"]);
  assert.equal(r.code, 1);
  assert.match(r.text, /is a git checkout .*Use its install.sh/);
  assert.deepEqual(snapshot(w.home), before);
  assert.ok(!fs.existsSync(w.state));
});

test("stops when a mod folder of the same name is not the kit's, and changes nothing", async () => {
  const w = world();
  fs.mkdirSync(path.join(w.home, "mods", "viewbar"));
  fs.writeFileSync(path.join(w.home, "mods", "viewbar", "main.js"), "// someone else's\n");
  const before = snapshot(w.home);
  const r = await kit(w, ["--yes"]);
  assert.equal(r.code, 1);
  assert.match(r.text, /mods\/viewbar is already there and the kit did not put it there/);
  assert.deepEqual(snapshot(w.home), before);
});

test("a failed patch removes the half-made flat sidebar, keeps the layout, installs the rest", async () => {
  const w = world();
  fs.writeFileSync(path.join(w.fakeState, "layout"), "terminals");
  const r = await kit(w, ["--yes"], { patchFail: true });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /Herdr: herdr-app 0.1.14/);
  assert.match(r.text, /Herdr changed the code for 'imports'/);
  assert.ok(!fs.existsSync(path.join(w.home, "mods", "spaces-flat")));
  assert.ok(!fs.existsSync(path.join(w.home, "layouts", "main-flat.json")));
  assert.equal(shownLayout(w), "terminals");
  assert.ok(fs.existsSync(path.join(w.home, "mods", "viewbar", "main.js")));
  assert.ok(fs.existsSync(path.join(w.home, "mods", "prs", "main.js")));
  const m = manifestOf(w);
  assert.ok(!m.herdr.mods.includes("spaces-flat"));
  // Uninstall still cleans everything.
  assert.equal((await kit(w, ["uninstall", "--yes"])).code, 0);
  assert.deepEqual(fs.readdirSync(path.join(w.home, "mods")), ["spaces"]);
});

test("trimLayout takes out the blocks of pieces that are off", () => {
  const layout = () => ({ root: { id: "root", type: "column", children: [
    { id: "viewbar", type: "block", content: { mod: "viewbar" } },
    { id: "body", type: "row", children: [
      { id: "main-stack", type: "stack", children: [{ id: "main", type: "block", content: { tab: "active" } }, { id: "plan", type: "block", content: { mod: "plan-review" } }] },
      { id: "side", type: "column", children: [{ id: "side-stack", type: "stack", children: [{ id: "side-view", type: "block" }, { id: "side-prs", type: "block", content: { mod: "prs" } }] }] }] },
    { id: "status", type: "row", size: { px: 28 }, children: [{ id: "usage", type: "block", content: { mod: "agent-usage" } }, { id: "keys", type: "block" }] }] } });
  const ids = (n) => [n.id, ...(n.children ?? []).flatMap(ids)];

  const none = trimLayout(layout(), { viewbar: false, prs: true, plan: true });
  assert.deepEqual(ids(none.root), ["root", "body", "main", "status"]);
  assert.deepEqual(none.root.children[1], { id: "status", type: "block", size: { px: 28 }, content: { mod: "agent-usage" } });

  const some = trimLayout(layout(), { viewbar: true, prs: false, plan: false });
  assert.ok(!ids(some.root).includes("side-prs") && !ids(some.root).includes("plan"));
  assert.ok(ids(some.root).includes("viewbar") && ids(some.root).includes("side-view"));
});

test("a second setup changes nothing and makes no second backup", async () => {
  const w = world();
  assert.equal((await kit(w, ["--yes"])).code, 0);
  const keysBefore = fs.readFileSync(path.join(w.home, "keys.json"));
  const backups = () => fs.readdirSync(w.home).filter((f) => f.endsWith(".bak"));
  assert.equal(backups().length, 1);
  const r = await kit(w, ["--yes"]);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(fs.readFileSync(path.join(w.home, "keys.json")), keysBefore);
  assert.equal(backups().length, 1);
});

test("uninstall removes the kit's empty data folders; --purge removes them with what is in them", async () => {
  const w = world();
  assert.equal((await kit(w, ["--yes"])).code, 0);
  const data = (d) => path.join(w.home, "data", d);
  for (const d of ["viewbar", "spaces-flat", "prs"]) fs.mkdirSync(data(d), { recursive: true });
  fs.writeFileSync(path.join(data("prs"), "t1.json"), "{}");
  fs.mkdirSync(data("tabs"));
  await kit(w, ["uninstall", "--yes"]);
  assert.deepEqual(fs.readdirSync(path.join(w.home, "data")).sort(), ["prs", "tabs"]);

  const v = world();
  assert.equal((await kit(v, ["--yes"])).code, 0);
  fs.mkdirSync(path.join(v.home, "data", "prs"), { recursive: true });
  fs.writeFileSync(path.join(v.home, "data", "prs", "t1.json"), "{}");
  await kit(v, ["uninstall", "--yes", "--purge"]);
  assert.deepEqual(fs.readdirSync(path.join(v.home, "data")), []);
});
