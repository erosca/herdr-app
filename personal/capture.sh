#!/usr/bin/env bash
# Saves this machine's personal Herdr settings into personal/, so setup.sh can
# apply them on other machines: key bindings that differ from Herdr's defaults,
# the look settings (theme, font, size, zoom, ...), your own themes, and
# optionally fonts. Review with `git diff personal/`, then commit and push.
#
#   personal/capture.sh            keys, look settings, your themes
#   options:
#     --fonts    also copy the configured terminal font's files (for machines
#                that lack it, such as Ubuntu Mono outside Ubuntu)
#     --tilix    also write themes/tilix.json from this machine's Tilix profile,
#                and take Tilix's font: the same family at the same pixel size
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
config=${HERDR_APP_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app}
fonts=false tilix=false
for arg in "$@"; do
  case $arg in
    --fonts) fonts=true ;;
    --tilix) tilix=true ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option $arg (see --help)" >&2; exit 2 ;;
  esac
done
[[ -d $config ]] || { echo "no Herdr settings at $config" >&2; exit 1; }
json() { python3 -I "$here/tools/herdr_json.py" "$@"; }

echo "== From $config"
[[ -f $config/keys.json ]] && json capture-keys "$config/keys.json" "$repo/defaults/keys.json" "$here/keys.json"
[[ -f $config/settings.json ]] && json capture-settings "$config/settings.json" "$here/settings.json"

mkdir -p "$here/themes"
for theme in "$config"/themes/*.json; do
  [[ -e $theme ]] || continue
  # Herdr's own themes come with every install.
  [[ -e $repo/defaults/themes/$(basename "$theme") ]] && continue
  cp -v "$theme" "$here/themes/"
done
$tilix && python3 -I "$here/tools/tilix_theme.py" "$here/themes/tilix.json" "$here/settings.json"

if $fonts; then
  mkdir -p "$here/fonts"
  font=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("font", ""))' "$here/settings.json")
  if [[ -n $font ]] && command -v fc-list >/dev/null; then
    while IFS= read -r file; do
      [[ -f $file ]] && cp -v "$file" "$here/fonts/"
    done < <(fc-list -f '%{file}\n' ":family=$font")
  fi
  for file in "$config"/fonts/*; do
    [[ -f $file ]] && cp -v "$file" "$here/fonts/"
  done
fi

echo
echo "Review with: git -C $repo diff -- personal/   then commit and push."
