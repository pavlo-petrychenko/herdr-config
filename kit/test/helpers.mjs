// Temporary Herdr homes, a fake PATH and a runner for the kit's tests. Nothing here touches
// a real Herdr home or the real state folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../cli.mjs";
import { hashFile, walk, which } from "../util.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_PATCH = path.join(here, "fake", "patch.py");

// A small stand-in for Herdr's default keys.json.
export const DEFAULT_KEYS = {
  global: { "cmd-t": "tab.new", "cmd-w": "tab.close", "cmd-shift-w": "pane.close", "cmd-shift-l": "layout.switch" },
  terminal: { "cmd-c": "terminal.copy", "cmd-f": "terminal.search" },
};

/**
 * A temporary world: { root, home, state, fakeState, bin, env }.
 * programs: which programs exist on the fake PATH (herdr-app always does).
 */
export function world({ programs = ["python3", "git", "gh", "claude"], window = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-kit-test-"));
  const home = path.join(root, "home");
  const state = path.join(root, "kit-state");
  const fakeState = path.join(root, "fake");
  const bin = path.join(root, "bin");
  for (const d of [home, fakeState, bin, path.join(home, "mods", "spaces"), path.join(home, "layouts")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, "installed.json"), JSON.stringify({ spaces: {}, agents: {}, "layout:main": {} }));
  fs.writeFileSync(path.join(home, "keys.json"), JSON.stringify(DEFAULT_KEYS, null, 2) + "\n");
  fs.writeFileSync(path.join(home, "mods", "spaces", "main.js"), "export default class Spaces {}\n");
  fs.writeFileSync(path.join(home, "mods", "spaces", "mod.json"), '{ "place": "left" }\n');
  fs.writeFileSync(path.join(home, "layouts", "main.json"), '{ "root": { "id": "root", "type": "row", "children": [] } }\n');
  if (!window) fs.writeFileSync(path.join(fakeState, "no-window"), "");

  const shim = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`); fs.chmodSync(path.join(bin, name), 0o755); };
  shim("herdr-app", `exec "${process.execPath}" "${path.join(here, "fake", "herdr-app.mjs")}" "$@"`);
  const real = { python3: which("python3"), git: which("git") };
  for (const p of programs) {
    if (p === "python3" || p === "git") shim(p, `exec "${real[p]}" "$@"`);
    else if (p === "gh") shim("gh", "exit 0");
    else if (p === "gh-logged-out") shim("gh", '[ "$1" = auth ] && exit 1; exit 0');
    else if (p === "agent-plan-review") shim("agent-plan-review", `echo "$@" >> "${fakeState}/apr.log"; [ "$2" = install ] && /bin/mkdir -p "$HERDR_APP_HOME/mods/plan-review" && echo x > "$HERDR_APP_HOME/mods/plan-review/main.js"; [ "$2" = uninstall ] && /bin/rm -rf "$HERDR_APP_HOME/mods/plan-review"; [ "$2" = status ] && echo "Herdr integration: disabled"; exit 0`);
    else shim(p, "exit 0");
  }
  const env = { HOME: root, PATH: bin, FAKE_STATE: fakeState };
  return { root, home, state, fakeState, bin, env };
}

/** Runs the kit in a world. Returns { code, text }. */
export async function kit(w, args, { answers = null, patchFail = false } = {}) {
  const lines = [];
  const queue = answers ? [...answers] : null;
  const code = await main([...args, "--home", w.home, "--state-dir", w.state], {
    env: { ...w.env, ...(patchFail ? { FAKE_PATCH_FAIL: "1" } : {}) },
    out: (s = "") => lines.push(s),
    ask: async () => {
      if (!queue) throw new Error("the kit asked a question in --yes mode");
      return queue.length ? queue.shift() : "";
    },
    patchScript: FAKE_PATCH,
  });
  return { code, text: lines.join("\n") };
}

/** { "<path>": sha256 } of every file in a folder. */
export function snapshot(dir) {
  return Object.fromEntries(walk(dir).map((f) => [f, hashFile(path.join(dir, f))]));
}

export const calls = (w) => fs.readFileSync(path.join(w.fakeState, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
export const shownLayout = (w) => { try { return fs.readFileSync(path.join(w.fakeState, "layout"), "utf8"); } catch { return "main"; } };
export const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
