# herdr-config

My Herdr customizations. This repo is the Herdr home, `~/.config/herdr-app`.
`.gitignore` is an allowlist: Herdr's shipped mods, layouts, themes and runtime state are not tracked.

## What is here

- `mods/`: my mods
  - `repo-worktree`: worktrees popup (cmd-shift-n), with per-repo strategies
  - `agent-queue`: agents that wait for me
  - `agent-usage`: usage bar for Claude and OpenCode
  - `file-viewer`: viewer pane for `herdr-show`
  - `space-groups`: sidebar groups
  - `spaces-flat`: patched copy of the shipped `spaces` mod
- `layouts/main-flat.json`: patched copy of the shipped `main` layout
- `keys.json`, `settings.json`, `repo-worktree.json`, `space-groups.json`: config
- `spaces-flat-sync.sh`, `spaces-flat-patch.py`: re-make `spaces-flat` and `main-flat` after a Herdr update
- `extras/`: files that run from outside the Herdr home. `install.sh` symlinks them into place:
  - `extras/bin/herdr-show`, `extras/bin/herdr-status` → `~/.local/bin/`
  - `extras/claude/hooks/herdr-status.mjs` → `~/.claude/hooks/`
  - `extras/claude/statusline-herdr.sh` → `~/.claude/`
  - `extras/hrt/start.sh` → `~/.hrt/`: second Herdr window for testing mods

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
