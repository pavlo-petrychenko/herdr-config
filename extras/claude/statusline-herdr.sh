#!/bin/sh
# Claude Code status line: prints the plan's limits ("5h 42% · wk 71%") and saves them for
# Herdr's usage bar (<herdr app home>/data/agent-usage/claude.json). Claude Code passes the
# limits on stdin as rate_limits after each reply (subscription plans only).
input=$(cat)
dir="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/data/agent-usage"
limits=$(printf '%s' "$input" | jq -c '.rate_limits // empty' 2>/dev/null)
if [ -n "$limits" ] && [ "$limits" != "null" ]; then
  mkdir -p "$dir"
  printf '%s' "$limits" | jq -c --argjson at "$(date +%s)000" '{at: $at} + .' > "$dir/claude.json.tmp" 2>/dev/null && mv "$dir/claude.json.tmp" "$dir/claude.json"
  printf '%s' "$limits" | jq -r '[(if .five_hour then "5h \(.five_hour.used_percentage | floor)%" else empty end), (if .seven_day then "wk \(.seven_day.used_percentage | floor)%" else empty end)] | join(" · ")'
fi
