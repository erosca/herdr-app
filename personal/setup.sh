#!/usr/bin/env bash
# Sets up Herdr on this machine from this fork: builds the patched app, points the
# launcher at it, and merges the personal settings in personal/ (keys, look,
# themes, fonts, the shell's keys in inputrc) and installs the personal agents
# (bin/, hc-templates/, programs.json). Linux only. Safe to re-run: changed
# files are backed up first.
#
#   personal/setup.sh                 build, launcher, settings
#   personal/setup.sh --nomachine     the same, plus the NoMachine lines in the
#                                     launcher (WAYLAND_DISPLAY=no unset; partial
#                                     redraw if it ever falls back to llvmpipe)
#   options:
#     --no-build      use the existing target/release/herdr-app
#     --no-core       don't install herdr-core when it's missing
#     --config-only   only the settings and agents (no build, core or launcher)
#     --build-only    only the build (personal/package.sh uses it)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
nomachine=false build=true core=true launcher=true build_only=false
for arg in "$@"; do
  case $arg in
    --nomachine) nomachine=true ;;
    --no-build) build=false ;;
    --no-core) core=false ;;
    --config-only) build=false core=false launcher=false ;;
    --build-only) build_only=true ;;
    -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option $arg (see --help)" >&2; exit 2 ;;
  esac
done

[[ $(uname -s) == Linux ]] || { echo "personal/setup.sh is for Linux." >&2; exit 1; }
command -v python3 >/dev/null || { echo "needs python3" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }
bin="$HOME/.local/bin"
data=${XDG_DATA_HOME:-$HOME/.local/share}
config=${HERDR_APP_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app}
app="$repo/target/release/herdr-app"
json() { python3 -I "$here/tools/herdr_json.py" "$@"; }

# Zig 0.16, as CI builds with: $ZIG, PATH, or ~/.local/opt (downloaded there if missing).
find_zig() {
  local z
  for z in "${ZIG:-}" "$(command -v zig 2>/dev/null || true)" "$HOME"/.local/opt/zig-*-0.16.*/zig; do
    if [[ -n $z && -x $z && $("$z" version 2>/dev/null) == 0.16.* ]]; then
      echo "$z"
      return 0
    fi
  done
  return 1
}

if $build; then
  say "Building herdr-app (release)"
  command -v cargo >/dev/null || {
    echo "needs Rust (CI uses 1.95.0): https://rustup.rs" >&2
    exit 1
  }
  if ! zig=$(find_zig); then
    arch=$(uname -m)
    [[ $arch == aarch64 || $arch == arm64 ]] && arch=aarch64 || arch=x86_64
    name="zig-$arch-linux-0.16.0"
    echo "Zig 0.16 not found; downloading $name to ~/.local/opt"
    mkdir -p "$HOME/.local/opt"
    curl -fsSL "https://ziglang.org/download/0.16.0/$name.tar.xz" | tar -xJ -C "$HOME/.local/opt"
    zig=$(find_zig) || { echo "Zig download failed; install Zig 0.16.0 and set ZIG" >&2; exit 1; }
  fi
  echo "Zig: $zig"
  git -C "$repo" submodule update --init --depth 1
  if ! (cd "$repo" && ZIG="$zig" cargo build --release --locked); then
    cat >&2 <<'EOF'

The build failed. On Debian/Ubuntu these packages are what CI installs:
  sudo apt-get install pkg-config clang libclang-dev libxcb1-dev libxkbcommon-dev \
    libxkbcommon-x11-dev libwayland-dev libvulkan-dev mesa-vulkan-drivers \
    libfontconfig-dev libfreetype-dev
EOF
    exit 1
  fi
fi
if $build_only; then
  $build || { echo "--build-only and --no-build: nothing to do" >&2; exit 2; }
  say "Built $app"
  exit 0
fi

if $core; then
  say "herdr-core"
  if [[ -e $bin/herdr-core ]] || command -v herdr-core >/dev/null 2>&1; then
    echo "already installed (Herdr keeps it up to date)"
  else
    curl -fsSL https://releases.herdr.dev/core/install.sh | HC_INSTALL_DIR="$bin" sh ||
      echo "herdr-core didn't install; Herdr offers it when it opens."
  fi
fi

if $launcher; then
  say "Launcher"
  [[ -x $app ]] || echo "warning: $app isn't built yet (run without --no-build)"
  mkdir -p "$bin" "$data/applications" "$data/icons/hicolor/scalable/apps"
  # The launcher sets the render settings on every machine; --nomachine keeps its
  # #NOMACHINE lines, other machines drop them.
  if $nomachine; then keep='s/^#NOMACHINE //'; else keep='/^#NOMACHINE /d'; fi
  sed -e "s|@REPO@|$repo|g" -e "$keep" "$here/herdr-app.in" >"$bin/herdr-app-personal"
  chmod +x "$bin/herdr-app-personal"
  ln -sfn "$bin/herdr-app-personal" "$bin/herdr-app"
  # The earlier NoMachine-only launcher, if one of these scripts (or the hand-made
  # first version) wrote it.
  if [[ -f $bin/herdr-app-nx ]] && grep -q 'Herdr source build tuned for' "$bin/herdr-app-nx"; then
    rm "$bin/herdr-app-nx"
  fi
  echo "herdr-app -> herdr-app-personal$($nomachine && echo ' (with the NoMachine lines)') -> $app"
  cp "$repo/assets/icons/herdr-ui-icon-clean.svg" "$data/icons/hicolor/scalable/apps/herdr-app.svg"
  cat >"$data/applications/herdr-app.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Herdr
Comment=Terminals and coding agents that keep running
Exec=$bin/herdr-app
Icon=herdr-app
Terminal=false
Categories=Development;
StartupWMClass=herdr-app
EOF
  command -v update-desktop-database >/dev/null && update-desktop-database "$data/applications" 2>/dev/null || true
  case ":$PATH:" in *":$bin:"*) ;; *) echo "note: add $bin to PATH to run herdr-app from a terminal" ;; esac
fi

say "Settings in $config"
mkdir -p "$config/themes" "$config/fonts"
if compgen -G "$here/themes/*.json" >/dev/null; then
  cp -v "$here"/themes/*.json "$config/themes/"
fi
if compgen -G "$here/fonts/*" >/dev/null; then
  cp -v "$here"/fonts/* "$config/fonts/"
fi
json merge-keys "$here/keys.json" "$config/keys.json" "$repo/defaults/keys.json"
json merge-settings "$here/settings.json" "$config/settings.json" "$config/themes"
font=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("font", ""))' "$here/settings.json")
if [[ -n $font ]] && command -v fc-list >/dev/null && [[ -z $(fc-list "$font" family) ]] &&
  ! compgen -G "$here/fonts/*" >/dev/null; then
  echo "warning: font \"$font\" isn't installed here; Herdr falls back to JetBrains Mono."
  echo "         On a machine that has it: personal/capture.sh --fonts, then commit personal/fonts."
fi

# Agents: their programs on PATH, their herdr-core templates (`hc run NAME`), and
# their programs.json entries (Herdr's name and tile, and its menu of agents).
say "Agents"
templates=${XDG_CONFIG_HOME:-$HOME/.config}/herdr-core/templates
for file in "$here"/bin/*; do
  [[ -f $file ]] || continue
  mkdir -p "$bin"
  install -m 755 "$file" "$bin/$(basename "$file")"   # edit them in personal/bin
  echo "  wrote:     $bin/$(basename "$file")"
done
for file in "$here"/hc-templates/*.md; do
  [[ -f $file ]] || continue
  target="$templates/$(basename "$file")"
  if [[ -f $target ]] && cmp -s "$file" "$target"; then
    echo "  unchanged: $target"
    continue
  fi
  if [[ -f $target ]]; then
    backup="$target.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$target" "$backup"
    echo "  backup:    $backup"
  fi
  mkdir -p "$templates"
  cp "$file" "$target"
  echo "  wrote:     $target"
done
if [[ -f $here/programs.json ]]; then
  json merge-programs "$here/programs.json" "$config/programs.json"
fi
case ":$PATH:" in *":$bin:"*) ;; *) echo "note: the agents need $bin on PATH" ;; esac

# Bash reads its keys from ~/.inputrc (or $INPUTRC): add the bindings it lacks.
inputrc=${INPUTRC:-$HOME/.inputrc}
say "Shell keys in $inputrc"
missing=$(grep '^"' "$here/inputrc" | while IFS= read -r line; do
  grep -qxF -- "$line" "$inputrc" 2>/dev/null || printf '%s\n' "$line"
done)
if [[ -z $missing ]]; then
  echo "  unchanged: $inputrc"
else
  if [[ -f $inputrc ]]; then
    backup="$inputrc.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$inputrc" "$backup"
    echo "  backup:    $backup"
  elif [[ -f /etc/inputrc ]]; then
    # A new ~/.inputrc replaces the system's, so it keeps those bindings (Home, End, ...).
    echo '$include /etc/inputrc' >"$inputrc"
  fi
  { echo; grep '^#' "$here/inputrc"; printf '%s\n' "$missing"; } >>"$inputrc"
  echo "  wrote:     $inputrc"
  echo "Shells already open (Herdr keeps them across restarts) need: bind -f $inputrc"
fi
[[ ${SHELL##*/} == zsh ]] && echo "note: your shell is zsh; add to ~/.zshrc: bindkey '^[[27;2;13~' accept-line"

say "Done"
echo "Quit Herdr completely and open it again to use the new build and settings."
