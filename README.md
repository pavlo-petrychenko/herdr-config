# herdr-config

My Herdr customizations. This repo is the Herdr home, `~/.config/herdr-app`.
`.gitignore` is an allowlist: Herdr's shipped mods, layouts, themes and runtime state are not tracked.

## What is here

- `mods/`: my mods
  - `repo-worktree`: worktrees popup (cmd-shift-n), with per-repo strategies
  - `agent-queue`: agents that wait for me; a plan chip on the rows of agents that have a plan
  - `viewbar`: the bar under the tabs (Agent | Plan flip, panels for the second view) and the hotkeys map
  - `agent-usage`: usage bar for Claude and OpenCode
  - `file-viewer`: viewer pane for `herdr-show`
  - `space-groups`: sidebar groups
  - `spaces-flat`: patched copy of the shipped `spaces` mod
- `layouts/main-flat.json`: patched copy of the shipped `main` layout
- `keys.json`, `settings.json`, `repo-worktree.json`, `space-groups.json`: config
- `spaces-flat-sync.sh`, `spaces-flat-patch.py`: re-make `spaces-flat` and `main-flat` after a Herdr update (the view bar, `main-stack` and the second view column are part of the patch)
- `extras/`: files that run from outside the Herdr home. `install.sh` symlinks them into place:
  - `extras/bin/herdr-show`, `extras/bin/herdr-status`, `extras/bin/herdr-prs` → `~/.local/bin/`
  - `extras/claude/hooks/herdr-status.mjs` → `~/.claude/hooks/`
  - `extras/claude/statusline-herdr.sh` → `~/.claude/`
  - `extras/hrt/start.sh` → `~/.hrt/`: second Herdr window for testing mods
- `extras/prs/`: `herdr-prs`, a node command (no dependencies) that finds an agent's pull requests (Claude Code transcripts + GitHub through `gh`) and writes `data/prs/<terminal>.json` for the PRs view. Data format: `extras/prs/FORMAT.md`. Tests: `node --test extras/prs/test/`

## The view bar and plans

`main-flat` has a bar under the tabs: `Agent | Plan` flips the main area (stack `main-stack`) between the agent
and the `plan-review` mod. The mod is not in this repo: it comes from agent-plan-review
(`agent-plan-review herdr enable` and `agent-plan-review herdr install`). Plans are found through its pointer files,
`data/plan-review/<terminal>.json`. Keys: `cmd-shift-r` flips, `cmd-w` goes back to the agent while the plan shows.
Panels for the second view (PRs, workflow, memory, TODOs) are providers in `mods/viewbar/providers.js`; none ship yet.
`mods/agent-queue/pointers.js` is a copy of `mods/viewbar/pointers.js` (a mod imports only its own files; a test checks that they match).

## Install on a new machine

Install and start Herdr once, so that it creates its home. Quit Herdr. Then:

```sh
cd ~/.config/herdr-app
git init -b main
git remote add origin git@github.com:pavlo-petrychenko/herdr-config.git
git fetch origin
git checkout -f -B main origin/main
./install.sh
```

`install.sh` does not edit `~/.claude/settings.json`. The hooks and the status line are registered there.
`mods/repo-worktree` reads `repo-worktree.json`; its repo paths are for this machine.
