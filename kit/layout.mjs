// The flat sidebar: mods/spaces-flat and layouts/main-flat.json, built from the person's own
// Herdr (its shipped `spaces` mod and `main` layout) and changed by spaces-flat-patch.py.
// The same steps as spaces-flat-sync.sh, with a way back when the patch fails.
import fs from "node:fs";
import path from "node:path";
import { herdrApp, windowStatus } from "./home.mjs";
import { readJson, run, stamp, writeJson } from "./util.mjs";

export const FLAT_MOD = "spaces-flat";
export const FLAT_LAYOUT = "main-flat";
/** Files Herdr itself writes into every mod folder: never the kit's. */
export const HERDR_WRITTEN = ["gpui-kit.d.ts", "herdr.d.ts"];

/** Finds the first node (depth first) for which pred holds: { node, parent } or null. */
function find(node, pred, parent = null) {
  if (!node || typeof node !== "object") return null;
  if (pred(node)) return { node, parent };
  for (const k of node.children ?? []) {
    const r = find(k, pred, node);
    if (r) return r;
  }
  return null;
}

const byId = (id) => (n) => n.id === id;

function removeNode(root, id) {
  const r = find(root, byId(id));
  if (r?.parent) r.parent.children = r.parent.children.filter((k) => k !== r.node);
}

/**
 * Takes out of a patched main-flat layout the blocks of pieces that are not installed, so the
 * window never shows "mod did not load". on: { viewbar, prs, plan }.
 */
export function trimLayout(layout, on) {
  const root = layout.root ?? layout;
  if (!on.viewbar) {
    // The bar, the second view column, the hotkeys button; the stack goes back to the tab area alone.
    removeNode(root, "viewbar");
    removeNode(root, "side");
    const stack = find(root, byId("main-stack"));
    if (stack?.parent) {
      const main = stack.node.children[0];
      stack.parent.children[stack.parent.children.indexOf(stack.node)] = main;
    }
    const usage = find(root, byId("usage"));
    if (usage?.parent && find(usage.parent, byId("keys"))) {
      const row = usage.parent;
      const owner = find(root, (n) => (n.children ?? []).includes(row));
      if (owner) {
        const block = { id: row.id, type: "block", size: row.size, content: usage.node.content };
        owner.node.children[owner.node.children.indexOf(row)] = block;
      }
    }
    return layout;
  }
  if (!on.prs) removeNode(root, "side-prs");
  if (!on.plan) removeNode(root, "plan");
  return layout;
}

/** Every file of the flat sidebar, as paths in the home. */
export function flatFiles(home) {
  const dir = path.join(home, "mods", FLAT_MOD);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((f) => `mods/${FLAT_MOD}/${f}`)
    .filter((f) => fs.statSync(path.join(home, f)).isFile() && !HERDR_WRITTEN.includes(path.basename(f))) : [];
  const layout = `layouts/${FLAT_LAYOUT}.json`;
  if (fs.existsSync(path.join(home, layout))) files.push(layout);
  return files;
}

/**
 * Builds spaces-flat and main-flat. The old copies (the kit's own, from an earlier run) are set
 * aside first and put back when the build fails; a half-made new copy is removed.
 * on: { viewbar, prs, plan } for trimLayout. Returns { ok: true } or { ok: false, error, version }.
 */
export function buildFlat(ctx, on) {
  const home = ctx.home;
  const mod = path.join(home, "mods", FLAT_MOD);
  const layout = path.join(home, "layouts", `${FLAT_LAYOUT}.json`);
  const when = stamp();
  const asideMod = path.join(home, "mods", `.${FLAT_MOD}.herdr-kit-${when}.old`);
  const asideLayout = path.join(home, "layouts", `.${FLAT_LAYOUT}.json.herdr-kit-${when}.old`);
  const before = windowStatus(ctx)?.layout ?? "main";

  // Herdr must not show main-flat while it is replaced.
  if (before === FLAT_LAYOUT) herdrApp(ctx, ["do", "layout.switch", JSON.stringify({ name: "main" })]);
  const hadMod = fs.existsSync(mod);
  const hadLayout = fs.existsSync(layout);
  if (hadMod) fs.renameSync(mod, asideMod);
  if (hadLayout) fs.renameSync(layout, asideLayout);

  const step = (what, r) => {
    if (r.code !== 0) throw new Error(`${what}: ${(r.err || r.out).trim() || `exit ${r.code}`}`);
    return r;
  };
  try {
    step("mod.clone", herdrApp(ctx, ["do", "mod.clone", JSON.stringify({ name: "spaces", as: FLAT_MOD })]));
    step("check", herdrApp(ctx, ["check", mod]));
    // layout.clone also shows the new layout.
    step("layout.clone", herdrApp(ctx, ["do", "layout.clone", JSON.stringify({ name: "main", as: FLAT_LAYOUT })]));
    step("spaces-flat-patch.py", run("python3", [ctx.patchScript, home], { env: ctx.env }));
    const d = readJson(layout);
    if (!d) throw new Error(`main-flat: ${layout} is not valid JSON after the patch`);
    writeJson(layout, trimLayout(d, on));
    step("check", herdrApp(ctx, ["check", mod]));
  } catch (e) {
    // Take the half-made copies out, put the old ones back, show the layout from before.
    fs.rmSync(mod, { recursive: true, force: true });
    fs.rmSync(layout, { force: true });
    if (hadMod) fs.renameSync(asideMod, mod);
    if (hadLayout) fs.renameSync(asideLayout, layout);
    const back = before === FLAT_LAYOUT && !hadLayout ? "main" : before;
    herdrApp(ctx, ["do", "layout.switch", JSON.stringify({ name: back })]);
    const version = herdrApp(ctx, ["--version"]).out.trim();
    return { ok: false, error: String(e.message ?? e), version };
  }
  fs.rmSync(asideMod, { recursive: true, force: true });
  fs.rmSync(asideLayout, { force: true });
  return { ok: true };
}
