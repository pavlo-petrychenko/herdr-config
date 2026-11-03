#!/bin/sh
# A second Herdr window with its own home (~/.hrt/app) and its own herdr-core (session "t"),
# for testing mods without touching the main window. Mods are symlinks to ~/.config/herdr-app.
#   start:  ~/.hrt/start.sh
#   drive:  HERDR_APP_HOME=~/.hrt/app herdr-app do ...   (hc: HC_SESSION=t XDG_STATE_HOME=~/.hrt/state hc ...)
#   stop:   ~/.hrt/start.sh stop
# Paths stay short on purpose: macOS sockets allow 103 bytes.
T="$HOME/.hrt"
running() { for p in $(pgrep -f "Herdr.app/Contents/MacOS/Herdr"); do [ "$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$T" ] && echo "$p"; done; }
if [ "${1:-}" = stop ]; then
  pid=$(running); [ -n "$pid" ] && kill $pid
  HC_SESSION=t XDG_STATE_HOME="$T/state" hc server stop >/dev/null 2>&1 || true
  echo stopped; exit 0
fi
[ -n "$(running)" ] && { echo "already running"; exit 0; }
cd "$T" && HERDR_APP_HOME="$T/app" HC_SESSION=t XDG_STATE_HOME="$T/state" nohup /Applications/Herdr.app/Contents/MacOS/Herdr > "$T/app.log" 2>&1 &
echo started
