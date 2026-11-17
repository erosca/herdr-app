#!/usr/bin/env bash
# Installs what building and testing herdr-app needs on Ubuntu or Debian, as CI
# has it (.github/workflows/ci.yml): the build packages, Rust, Zig and Bun at
# CI's versions, just, and the vendor/ghostty submodule. What's there already is
# left alone, so it's safe to re-run (after a pull that bumps a version, too).
#
#   personal/install-prereqs.sh             everything; sudo only if packages are missing
#   personal/install-prereqs.sh --check     only say what's missing
#   personal/install-prereqs.sh --no-apt    only what goes in your home (no sudo)
#   personal/install-prereqs.sh --apt-only  only the system packages
#   options:
#     --sandbox   also weston and python3-xlib, for scripts/sandbox (UI tests)
#
# Where things go: Rust in ~/.cargo and ~/.rustup (rustup adds ~/.cargo/bin to
# PATH in ~/.profile and ~/.bashrc), Zig in ~/.local/opt (where personal/setup.sh
# looks for it), Bun in ~/.bun (its installer adds it to ~/.bashrc); zig, bun
# and just are in ~/.local/bin.
set -euo pipefail
# Pipes into grep read all their input (no grep -q): under pipefail, a writer cut
# off by grep -q's early exit would fail the test.

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
check=false apt=true home=true sandbox=false
for arg in "$@"; do
  case $arg in
    --check) check=true ;;
    --no-apt) apt=false ;;
    --apt-only) home=false ;;
    --sandbox) sandbox=true ;;
    -h | --help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option $arg (see --help)" >&2; exit 2 ;;
  esac
done
[[ $(uname -s) == Linux ]] || { echo "personal/install-prereqs.sh is for Linux." >&2; exit 1; }

say() { printf '\n== %s\n' "$*"; }
bin="$HOME/.local/bin"
opt="$HOME/.local/opt"
export PATH="$bin:$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"

# CI's versions, so a local build and test run is the one CI makes.
ci="$repo/.github/workflows/ci.yml"
pin() { sed -n "s/^ *$1: *\"\{0,1\}\([0-9.]*\)\"\{0,1\} *$/\1/p" "$ci" 2>/dev/null | head -1; }
rust=$(pin RUST_TOOLCHAIN) zig=$(pin ZIG_VERSION)
bun=$(grep -o 'bun-v[0-9.]*' "$ci" 2>/dev/null | head -1 | sed 's/^bun-v//' || true)
rust=${rust:-1.95.0} zig=${zig:-0.16.0} bun=${bun:-1.4.4}

missing=()
note() { missing+=("$1"); echo "missing: $1"; }

# What CI's Linux job installs ("Linux build dependencies"). mesa-vulkan-drivers
# runs the tests' headless Vulkan; the rest are headers and libraries the build links.
packages=(pkg-config clang libclang-dev libxcb1-dev libxkbcommon-dev libxkbcommon-x11-dev
  libwayland-dev libvulkan-dev mesa-vulkan-drivers libfontconfig-dev libfreetype-dev
  curl xz-utils git python3)
$sandbox && packages+=(weston xwayland python3-xlib)

if $apt; then
  say "System packages"
  need=()
  for p in "${packages[@]}"; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep 'install ok installed' >/dev/null || need+=("$p")
  done
  if ((${#need[@]} == 0)); then
    echo "all there"
  elif $check; then
    note "packages: ${need[*]}"
  else
    echo "installing: ${need[*]}"
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends "${need[@]}"
  fi
fi

if $home; then
  say "Rust $rust"
  if command -v rustup >/dev/null 2>&1; then
    if rustup toolchain list | grep "^$rust" >/dev/null; then
      echo "already installed"
    elif $check; then
      note "rust $rust (rustup is there)"
    else
      rustup toolchain install "$rust" --profile minimal
    fi
    # The repository has no rust-toolchain file: when the default is another
    # toolchain, this checkout's folder is pinned to CI's (others keep theirs).
    if ! $check && [[ $(rustup default 2>/dev/null) != "$rust"* ]]; then
      rustup override set "$rust" --path "$repo"
    fi
  elif command -v cargo >/dev/null 2>&1; then
    echo "cargo without rustup: $(cargo --version) (CI uses $rust; install rustup to match it)"
  elif $check; then
    note "rust $rust"
  else
    curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs |
      sh -s -- -y --profile minimal --default-toolchain "$rust"
  fi

  say "Zig $zig"
  find_zig() {
    local z
    for z in "${ZIG:-}" "$(command -v zig 2>/dev/null || true)" "$opt"/zig-*-"$zig"/zig; do
      if [[ -n $z && -x $z && $("$z" version 2>/dev/null) == "$zig" ]]; then
        echo "$z"
        return 0
      fi
    done
    return 1
  }
  if z=$(find_zig); then
    echo "already installed: $z"
  elif $check; then
    note "zig $zig"
  else
    case $(uname -m) in aarch64 | arm64) arch=aarch64 ;; *) arch=x86_64 ;; esac
    # The tarball and its checksum from ziglang.org's own index.
    read -r url sum < <(curl -fsSL https://ziglang.org/download/index.json | python3 -I -c '
import json, sys
release = json.load(sys.stdin)[sys.argv[1]][sys.argv[2] + "-linux"]
print(release["tarball"], release["shasum"])' "$zig" "$arch")
    tmp=$(mktemp -d)
    trap 'rm -rf "${tmp:?}"' EXIT
    echo "downloading $url"
    curl -fsSL "$url" -o "$tmp/zig.tar.xz"
    echo "$sum  $tmp/zig.tar.xz" | sha256sum -c --quiet
    mkdir -p "$opt" "$bin"
    tar -xJf "$tmp/zig.tar.xz" -C "$opt"
    z=$(find_zig) || { echo "Zig unpacked but not found in $opt" >&2; exit 1; }
    echo "installed: $z"
  fi
  # On PATH for ghostty-sys's build script, which runs `zig`.
  if ! $check && [[ -n ${z:-} && $(readlink -f "$(command -v zig 2>/dev/null || echo none)") != "$(readlink -f "$z")" ]]; then
    mkdir -p "$bin"
    ln -sfn "$z" "$bin/zig"
  fi

  say "Bun $bun"
  b=$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")
  if [[ -x $b && $("$b" --version 2>/dev/null) == "$bun" ]]; then
    echo "already installed: $b"
  elif $check; then
    note "bun $bun"
  else
    curl -fsSL https://bun.sh/install | bash -s "bun-v$bun"
    mkdir -p "$bin"
    ln -sfn "$HOME/.bun/bin/bun" "$bin/bun"
  fi

  say "just"
  if command -v just >/dev/null 2>&1; then
    echo "already installed: $(just --version)"
  elif $check; then
    note "just"
  else
    mkdir -p "$bin"
    curl --proto '=https' --tlsv1.2 -fsSL https://just.systems/install.sh | bash -s -- --to "$bin"
  fi

  say "vendor/ghostty"
  if git -C "$repo" submodule status vendor/ghostty | grep '^[-+]' >/dev/null; then
    if $check; then
      note "the vendor/ghostty submodule (not checked out at this commit)"
    else
      git -C "$repo" submodule update --init --depth 1 vendor/ghostty
    fi
  else
    echo "checked out"
  fi
fi

if $check; then
  ((${#missing[@]} == 0)) && echo && echo "Nothing is missing." && exit 0
  echo
  echo "${#missing[@]} missing: personal/install-prereqs.sh installs them."
  exit 1
fi
say "Done"
echo "Open a new shell for PATH (or: . ~/.cargo/env), then: just test"
