#!/usr/bin/env bash
# Installs this Herdr build and its personal setup for the current user, from
# the archive personal/package.sh made. No git, Rust or root needed:
#
#   ./install.sh               the app, its launcher and menu entry, settings, agents
#   ./install.sh --nomachine   the same, plus the NoMachine lines in the launcher
#   options, as personal/setup.sh: --no-core, --config-only
#
# The build is copied to ~/.local/opt/herdr-app-personal/<build>, so this folder
# can be deleted afterwards. The two newest builds there are kept.
# (In the repository this is personal/bundle-install.sh.)
set -euo pipefail

src=$(cd "$(dirname "$0")" && pwd)
info() { sed -n "s/^$1=//p" "$src/BUILD-INFO"; }
config_only=false
for arg in "$@"; do
  case $arg in
    --config-only) config_only=true ;;
    --nomachine | --no-core) ;;
    -h | --help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option $arg (see --help)" >&2; exit 2 ;;
  esac
done
[[ $(uname -s) == Linux ]] || { echo "this build is for Linux." >&2; exit 1; }
[[ -f $src/BUILD-INFO ]] || { echo "no BUILD-INFO next to $0: run it from the unpacked archive" >&2; exit 1; }
name=$(info name)
[[ $name == herdr-app-personal-* && $name != */* ]] || { echo "BUILD-INFO has no valid name" >&2; exit 1; }
echo "Herdr build $name (built $(info built) on $(info os))"

if ! $config_only; then
  arch=$(info arch)
  [[ $(uname -m) == "$arch" ]] || { echo "this build is for $arch; this machine is $(uname -m)." >&2; exit 1; }
  need=$(info glibc_needed)
  have=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')
  if [[ -n $need && -n $have && $(printf '%s\n' "$need" "$have" | sort -V | head -1) != "$need" ]]; then
    echo "this build needs glibc $need; this machine has $have." >&2
    echo "Make the archive on the oldest Ubuntu you install to." >&2
    exit 1
  fi
  missing=$(ldd "$src/target/release/herdr-app" 2>/dev/null | awk '/not found/ {print $1}' || true)
  if [[ -n $missing ]]; then
    echo "Herdr needs libraries this machine lacks: $(echo $missing)" >&2
    packages=$(for lib in $missing; do awk -v lib="$lib" '$1 == lib && $2 != "" {print $2}' "$src/runtime-libs"; done | sort -u)
    [[ -n $packages ]] && echo "Install them, then run this again: sudo apt install $(echo $packages)" >&2
    echo "(apt-file search <library> finds a package for one this list doesn't name)" >&2
    exit 1
  fi
  # Herdr draws with Vulkan or OpenGL (EGL); both are loaded at run time, so ldd can't see them.
  if ! ldconfig -p 2>/dev/null | grep -q 'libvulkan\.so\.1\|libEGL\.so\.1'; then
    echo "warning: neither Vulkan nor EGL is installed; Herdr can't draw without one:"
    echo "  sudo apt install libvulkan1 mesa-vulkan-drivers libegl1 libgl1-mesa-dri"
  fi
fi

opt="${HOME:?}/.local/opt/herdr-app-personal"
dest="$opt/$name"
if [[ $src != "$dest" ]]; then
  # A new folder per build: a running Herdr keeps using its own files.
  mkdir -p "$opt"
  rm -rf "${dest:?}.new"
  cp -a "$src" "$dest.new"
  rm -rf "${dest:?}"
  mv "$dest.new" "$dest"
  echo "Copied to $dest"
fi
touch "$dest"   # the newest install, for the cleanup below

"$dest/personal/setup.sh" --no-build "$@"

# Keep the two newest builds: Herdr may still run the previous one until it's reopened.
find "$opt" -mindepth 1 -maxdepth 1 -type d -name 'herdr-app-personal-*' ! -name '*.new' -printf '%T@ %p\n' |
  sort -rn | tail -n +3 | cut -d' ' -f2- | while IFS= read -r old; do
    [[ $old != "$dest" && -f $old/BUILD-INFO ]] || continue
    rm -rf "${old:?}"
    echo "Removed the older build $old"
  done
