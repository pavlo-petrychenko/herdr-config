#!/bin/sh
# Re-makes the flat sidebar from Herdr's current `spaces` mod and `main` layout.
# Run it after a Herdr update: copies never get Herdr's fixes on their own.
#   mods/spaces-flat, layouts/main-flat: Herdr's spaces and main, changed by spaces-flat-patch.py
set -eu
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
stamp=$(date +%Y%m%d-%H%M%S)
herdr-app do layout.switch '{"name":"main"}' >/dev/null
[ -d "$home/mods/spaces-flat" ] && mv "$home/mods/spaces-flat" "$home/mods/.spaces-flat.old-$stamp"
[ -f "$home/layouts/main-flat.json" ] && mv "$home/layouts/main-flat.json" "$home/layouts/.main-flat.json.old-$stamp"
herdr-app do mod.clone '{"name":"spaces","as":"spaces-flat"}' >/dev/null
herdr-app check "$home/mods/spaces-flat" >/dev/null
herdr-app do layout.clone '{"name":"main","as":"main-flat"}' >/dev/null
python3 "$home/spaces-flat-patch.py" "$home"
herdr-app check "$home/mods/spaces-flat"
echo "Flat sidebar re-made from Herdr's current spaces mod. Old copies: *.old-$stamp"
