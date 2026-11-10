#!/usr/bin/env bash
# Packs this fork's build and everything personal/setup.sh installs into one
# archive, for a machine that shouldn't clone and build (Ubuntu, same CPU type):
#
#   personal/package.sh              build as setup.sh does, then pack
#   personal/package.sh --no-build   pack the existing target/release/herdr-app
#   options:
#     -o DIR    where the archive goes (default: dist/)
#
# On the other machine (no git, Rust or root needed):
#   tar -xf herdr-app-personal-*.tar.xz
#   herdr-app-personal-*/install.sh [--nomachine] [--no-core] [--config-only]
#
# Build on the oldest Ubuntu you install to: the binary needs at least the
# glibc it was built with (the installer checks).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
build=true out="$repo/dist"
while [[ $# -gt 0 ]]; do
  case $1 in
    --no-build) build=false ;;
    -o) out=${2:?"-o needs a directory"}; shift ;;
    -h | --help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
[[ $(uname -s) == Linux ]] || { echo "personal/package.sh is for Linux." >&2; exit 1; }

# setup.sh's build is a plain cargo build. Never set HERDR_APP_RELEASE here: a
# release build updates itself to upstream's build (src/update.rs).
if $build; then "$here/setup.sh" --build-only; fi
app="$repo/target/release/herdr-app"
[[ -x $app ]] || { echo "$app isn't built (run without --no-build)" >&2; exit 1; }
if [[ $(stat -c %Y "$app") -lt $(git -C "$repo" log -1 --format=%ct 2>/dev/null || echo 0) ]]; then
  echo "warning: $app is older than the last commit; it may not be this checkout's build"
fi

version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$repo/Cargo.toml" | head -1)
commit=$(git -C "$repo" describe --always --dirty --abbrev=7 2>/dev/null || echo unknown)
# A build with uncommitted changes gets the time too, so two of them differ.
[[ $commit == *-dirty ]] && commit+=".$(date +%Y%m%d%H%M)"
arch=$(uname -m)
name="herdr-app-personal-$version-$commit-$arch"

work=$(mktemp -d)
trap 'rm -rf "${work:?}"' EXIT
root="$work/$name"
# The repository's shape that setup.sh expects, holding only what it installs.
mkdir -p "$root/target/release" "$root/assets/icons" "$root/defaults" "$root/personal/tools"
cp "$app" "$root/target/release/herdr-app"
cp "$repo/assets/icons/herdr-ui-icon-clean.svg" "$root/assets/icons/"
cp "$repo/defaults/keys.json" "$root/defaults/"
for file in LICENSE THIRD-PARTY-NOTICES; do
  [[ -f $repo/$file ]] && cp "$repo/$file" "$root/"
done
# Not capture.sh: it saves a machine's settings back into git.
for file in setup.sh herdr-app.in keys.json settings.json programs.json inputrc README.md \
  themes fonts bin hc-templates; do
  [[ -e $here/$file ]] && cp -a "$here/$file" "$root/personal/"
done
cp -a "$here/tools/herdr_json.py" "$root/personal/tools/"
find "$root/personal" \( -name '*.bak-*' -o -name __pycache__ \) -prune -exec rm -rf {} +
install -m 755 "$here/bundle-install.sh" "$root/install.sh"

# What the installer checks: the newest glibc symbol version the binary uses,
# and the Ubuntu package of each library it links, from this machine's dpkg.
glibc=$(objdump -T "$app" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -1 || true)
[[ -n $glibc ]] || glibc=$(getconf GNU_LIBC_VERSION | awk '{print $2}')
package_of() {
  local path=$1 alt
  case $path in /usr/*) alt=${path#/usr} ;; *) alt=/usr$path ;; esac
  { dpkg -S "$path" 2>/dev/null || dpkg -S "$alt" 2>/dev/null || dpkg -S "$(readlink -f "$path")" 2>/dev/null; } |
    head -1 | cut -d: -f1
}
ldd "$app" | awk '$2 == "=>" && $3 ~ /^\// {print $1, $3}' | while read -r lib path; do
  printf '%s %s\n' "$lib" "$(package_of "$path" || true)"
done >"$root/runtime-libs"
cat >"$root/BUILD-INFO" <<EOF
name=$name
version=$version
commit=$commit
branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
built=$(date -u +%Y-%m-%dT%H:%MZ)
os=$(. /etc/os-release && echo "${PRETTY_NAME:-$ID}")
arch=$arch
glibc_needed=$glibc
EOF

mkdir -p "$out"
out=$(cd "$out" && pwd)
archive="$out/$name.tar.xz"
(cd "$work" && XZ_OPT=-T0 tar -cJf "$archive" "$name")
(cd "$out" && sha256sum "$name.tar.xz" >"$name.tar.xz.sha256")
echo "Packed $archive ($(du -h "$archive" | cut -f1)), needs glibc $glibc or newer"
echo "On the other machine:"
echo "  tar -xf $name.tar.xz && $name/install.sh            # add --nomachine on a NoMachine desktop"
