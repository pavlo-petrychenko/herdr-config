// manifest.json in the state folder (~/.local/share/herdr-kit): what the kit put where, so
// `update`, `doctor` and `uninstall` act only on the kit's own files.
//
// {
//   kit: "herdr-kit", version, home, installedAt, updatedAt, pieces: [id],
//   herdr: {
//     mods: [name],                       mod folders the kit owns (spaces-flat too, when built)
//     layouts: [name],                    layouts the kit owns (main-flat)
//     files: { "<path in home>": sha256 },
//     dirs: ["<path in home>"],           folders the kit made (removed when empty)
//     keys: { added: [{ section, key, action, newSection, replaced? }],
//             backup, after, restorable }, keys.json backup, its hash after the kit wrote it, and
//                                          whether the backup can still go back whole
//     backups: [{ file, backup }],        every backup the kit made (absolute paths)
//     plan: { installedMod, enabled } | null   what `agent-plan-review herdr ...` changed
//   }
//   (later steps add `claude` and `tools` blocks)
// }
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./util.mjs";

export const manifestPath = (stateDir) => path.join(stateDir, "manifest.json");

export const loadManifest = (stateDir) => readJson(manifestPath(stateDir), null);

export function saveManifest(stateDir, m) {
  m.updatedAt = new Date().toISOString();
  writeJson(manifestPath(stateDir), m);
}

export function removeManifest(stateDir) {
  fs.rmSync(manifestPath(stateDir), { force: true });
}

export function newManifest(version, home) {
  const now = new Date().toISOString();
  return {
    kit: "herdr-kit", version, home, installedAt: now, updatedAt: now, pieces: [],
    herdr: {
      mods: [], layouts: [], files: {}, dirs: [],
      keys: { added: [], backup: null, after: null, restorable: false },
      backups: [], plan: null,
    },
  };
}

/** Copies a file to "<file>.herdr-kit-<stamp>.bak" and returns that path. */
export function backupFile(file, when) {
  let backup = `${file}.herdr-kit-${when}.bak`;
  for (let n = 2; fs.existsSync(backup); n++) backup = `${file}.herdr-kit-${when}-${n}.bak`;
  fs.copyFileSync(file, backup);
  return backup;
}
