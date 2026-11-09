#!/bin/sh
# Symlinks extras/ into place. Safe to run again. A different file at a target goes to <target>.bak.
set -eu
repo=$(cd "$(dirname "$0")" && pwd)
link() {
  src="$repo/extras/$1"; dst="$2"
  mkdir -p "$(dirname "$dst")"
  [ "$(readlink "$dst" 2>/dev/null || true)" = "$src" ] && return 0
  [ -e "$dst" ] && [ ! -L "$dst" ] && cp -p "$dst" "$dst.bak"
  ln -s "$src" "$dst.tmp.$$"
  mv -f "$dst.tmp.$$" "$dst"
  echo "linked $dst"
}
link bin/herdr-prs "$HOME/.local/bin/herdr-prs"
link bin/herdr-show "$HOME/.local/bin/herdr-show"
link bin/herdr-status "$HOME/.local/bin/herdr-status"
link claude/hooks/herdr-status.mjs "$HOME/.claude/hooks/herdr-status.mjs"
link claude/statusline-herdr.sh "$HOME/.claude/statusline-herdr.sh"
link hrt/start.sh "$HOME/.hrt/start.sh"
