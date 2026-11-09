// A stand-in for herdr-app in the kit's tests. State (the shown layout, the calls) lives in
// FAKE_STATE, never in the home, so a test can compare the home before and after.
import fs from "node:fs";
import path from "node:path";

// `node --test kit/test/` loads this file too: without FAKE_STATE it does nothing.
if (!process.env.FAKE_STATE) process.exit(0);
const home = process.env.HERDR_APP_HOME;
const state = process.env.FAKE_STATE;
const [cmd, ...rest] = process.argv.slice(2);
fs.appendFileSync(path.join(state, "calls.log"), JSON.stringify([cmd, ...rest]) + "\n");
const layoutFile = path.join(state, "layout");
const shown = () => (fs.existsSync(layoutFile) ? fs.readFileSync(layoutFile, "utf8") : "main");
const fail = (msg) => { process.stderr.write(msg + "\n"); process.exit(1); };

if (cmd === "--version") console.log("herdr-app 0.1.14");
else if (cmd === "status") {
  if (fs.existsSync(path.join(state, "no-window"))) fail("no window is open");
  console.log(JSON.stringify({ layout: shown(), errors: [] }));
} else if (cmd === "check") {
  if (!fs.existsSync(path.join(rest[0], "main.js"))) fail(`no main.js in ${rest[0]}`);
  console.log(`check passed: ${rest[0]}`);
} else if (cmd === "do") {
  const [name, json] = rest;
  const a = JSON.parse(json ?? "{}");
  if (name === "layout.switch") fs.writeFileSync(layoutFile, a.name);
  else if (name === "mod.clone") {
    const to = path.join(home, "mods", a.as);
    if (fs.existsSync(to)) fail(`mod ${a.as} exists`);
    fs.cpSync(path.join(home, "mods", a.name), to, { recursive: true });
  } else if (name === "layout.clone") {
    const to = path.join(home, "layouts", `${a.as}.json`);
    if (fs.existsSync(to)) fail(`layout ${a.as} exists`);
    fs.copyFileSync(path.join(home, "layouts", `${a.name}.json`), to);
    fs.writeFileSync(layoutFile, a.as);
  } else fail(`unknown command ${name}`);
  console.log('{"ok": true}');
} else fail(`unknown ${cmd}`);
