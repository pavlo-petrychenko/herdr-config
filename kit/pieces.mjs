// The pieces a person can pick (plan page "what-it-installs").
//
// A piece holds one block of actions per kind. Step 1 has only `herdr` (files in the Herdr home);
// later steps add `claude` (hooks in ~/.claude/settings.json) and `tools` (programs in
// ~/.local/share/herdr-kit). Each kind is handled by its own module (see KINDS in cli.mjs).
//
//   needs:    programs (see checkPrograms in home.mjs); a missing one switches the piece off
//   requires: other pieces it builds on
//   herdr.mods:   mod folders copied from this package's mods/
//   herdr.build:  build spaces-flat and main-flat from the person's own Herdr (layout.mjs)
//   herdr.config: starter files from kit/defaults/, written only when absent
//   herdr.keys:   [section, key] pairs from kit/keys.json
//   herdr.data:   folders under <home>/data/ the mods write (removed only by `uninstall --purge`)
//   herdr.planView: run `agent-plan-review herdr enable` and `herdr install`

export const PIECES = [
  {
    id: "core",
    title: "Flat sidebar",
    about: "spaces-flat sidebar with groups, the agent queue, the usage bar, the main-flat layout",
    needs: ["window", "python3"],
    herdr: {
      mods: ["space-groups", "agent-queue", "agent-usage"],
      build: true,
      config: ["space-groups.json"],
      data: ["agent-status", "agent-usage"],
    },
  },
  {
    id: "viewbar",
    title: "View bar",
    about: "Agent / Plan / PRs bar under the tabs, and the hotkeys map",
    requires: ["core"],
    herdr: {
      mods: ["viewbar"],
      keys: [["global", "cmd-shift-r"], ["global", "cmd-shift-g"], ["layout:main-flat", "cmd-w"]],
    },
  },
  {
    id: "prs",
    title: "PRs view",
    about: "the pull requests of the agent in the focused tab (the herdr-prs tool comes later)",
    needs: ["node20", "gh"],
    herdr: { mods: ["prs"], data: ["prs"] },
  },
  {
    id: "repo-worktree",
    title: "Worktrees popup",
    about: "make, open and remove git worktrees (cmd-shift-n)",
    needs: ["git"],
    herdr: { mods: ["repo-worktree"], config: ["repo-worktree.json"], keys: [["global", "cmd-shift-n"]] },
  },
  {
    id: "file-viewer",
    title: "File viewer",
    about: "a read-only viewer pane for files an agent shows you",
    herdr: { mods: ["file-viewer"], data: ["file-viewer"] },
  },
  {
    id: "plan",
    title: "Plan view",
    about: "plans from agent-plan-review inside Herdr",
    needs: ["agent-plan-review"],
    herdr: { planView: true, keys: [["mod:plan-review", "cmd-w"]] },
  },
];

export const byId = (id) => PIECES.find((p) => p.id === id);

/**
 * Which pieces can be installed. checks: { <need>: { ok, why } }.
 * Returns { on: [id], off: [{ id, why }] }; `wanted` (ids) limits the result, else every piece.
 * `have`: pieces already installed (they count as a base for `requires`).
 */
export function choosePieces(checks, wanted = null, have = []) {
  const on = [];
  const off = [];
  for (const p of PIECES) {
    if (wanted && !wanted.includes(p.id)) continue;
    const missing = (p.needs ?? []).find((n) => !checks[n]?.ok);
    if (missing) { off.push({ id: p.id, why: checks[missing]?.why ?? `needs ${missing}` }); continue; }
    on.push(p.id);
  }
  // A piece whose base piece is off is off too.
  for (const p of PIECES) {
    if (!on.includes(p.id)) continue;
    const base = (p.requires ?? []).find((r) => !on.includes(r) && !have.includes(r));
    if (base) {
      on.splice(on.indexOf(p.id), 1);
      off.push({ id: p.id, why: `needs the ${byId(base).title} piece (${base})` });
    }
  }
  return { on, off };
}
