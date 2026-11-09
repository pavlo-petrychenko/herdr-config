#!/bin/sh
# A fresh Herdr test window with its own empty home (~/.hk/app) and its own herdr-core
# (session "k"), for trying the kit on a clean Herdr. It never touches ~/.config/herdr-app or ~/.hrt.
#   start:  kit/dev/fresh-window.sh start
#   drive:  HERDR_APP_HOME=~/.hk/app herdr-app do ...   (hc: HC_SESSION=k XDG_STATE_HOME=~/.hk/state hc ...)
#   stop:   kit/dev/fresh-window.sh stop     (only this window: matched by its folder, ~/.hk)
#   reset:  kit/dev/fresh-window.sh reset    (stop, then delete ~/.hk)
# Paths stay short on purpose: macOS sockets allow 103 bytes.
set -eu
T="$HOME/.hk"
running() { for p in $(pgrep -f "Herdr.app/Contents/MacOS/Herdr" || true); do [ "$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$T" ] && echo "$p"; done; return 0; }
stop() {
  pid=$(running); [ -n "$pid" ] && kill $pid
  [ -d "$T" ] && HC_SESSION=k XDG_STATE_HOME="$T/state" hc server stop >/dev/null 2>&1 || true
}
case "${1:-start}" in
  start)
    [ -n "$(running)" ] && { echo "already running"; exit 0; }
    mkdir -p "$T/app" "$T/state"
    cd "$T" && HERDR_APP_HOME="$T/app" HC_SESSION=k XDG_STATE_HOME="$T/state" nohup /Applications/Herdr.app/Contents/MacOS/Herdr > "$T/app.log" 2>&1 &
    echo started ;;
  stop) stop; echo stopped ;;
  reset) stop; sleep 1; rm -rf "$T"; echo "reset: $T removed" ;;
  *) echo "usage: $0 start|stop|reset" >&2; exit 2 ;;
esac
