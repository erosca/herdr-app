# Personal setup (this fork only)

Not for upstream: keep `personal/` out of pull requests to herdrdev/herdr-app.

This branch carries local patches (partial redraw for software rendering, the
GPU backend switches, Shift+PageUp/PageDown scrolling) and the settings below.

## A new machine

```sh
git clone --branch claude/admiring-tesla-qdekso https://github.com/erosca/herdr-app
cd herdr-app
personal/setup.sh              # a machine with a GPU
personal/setup.sh --nomachine  # a NoMachine desktop (software rendering)
```

It builds the app (Rust 1.95+, Zig 0.16, downloaded to `~/.local/opt` if
missing), installs herdr-core if there's none, points `~/.local/bin/herdr-app`
and the Herdr menu entry at this build, and merges the files below into
`~/.config/herdr-app`. Re-run it after pulling to rebuild; changed settings
files are backed up first. Then quit Herdr and open it again.

A server you only reach through Herdr's SSH machines needs nothing from here:
just herdr-core, which Herdr sets up when you add the machine.

## What it applies

| File | Goes to | Notes |
|---|---|---|
| `keys.json` | merged into `keys.json` | Shift+Insert/Ctrl+Insert paste and copy, Shift+PageUp/PageDown scroll, Ctrl+Shift+arrows move between panes |
| `settings.json` | merged into `settings.json` | font, size, zoom, theme |
| `themes/*.json` | copied to `themes/` | e.g. `tilix.json` |
| `fonts/*` | copied to `fonts/` | for machines that lack the font |
| `herdr-app.in` | `~/.local/bin/herdr-app-personal`, which `herdr-app` points at | `ZED_FONTS_GAMMA=1.0` everywhere; with `--nomachine` also GL, `HERDR_RENDER_PARTIAL=cpu` and the `WAYLAND_DISPLAY=no` fix |

## Saving changes from a machine

```sh
personal/capture.sh --fonts --tilix   # then review, commit and push
```

`capture.sh` saves the key bindings that differ from Herdr's defaults, the look
settings, your own themes, the terminal font's files (`--fonts`) and a theme
made from this machine's Tilix (`--tilix`).
