# Personal setup (this fork only)

Not for upstream: keep `personal/` out of pull requests to herdrdev/herdr-app.

This branch carries local patches (partial redraw for software rendering, the
GPU backend switches, Shift+PageUp/PageDown scrolling, VTE-style terminal
cells) and the settings below.

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
`~/.config/herdr-app` (and `~/.inputrc`). Re-run it after pulling to rebuild;
changed settings files are backed up first. Then quit Herdr and open it again.

A server you only reach through Herdr's SSH machines needs nothing from here:
just herdr-core, which Herdr sets up when you add the machine.

## What it applies

| File | Goes to | Notes |
|---|---|---|
| `keys.json` | merged into `keys.json` | Shift+Insert/Ctrl+Insert paste and copy, Shift+PageUp/PageDown scroll, Ctrl+Shift+arrows move between panes |
| `settings.json` | merged into `settings.json` | font, size, zoom, theme |
| `themes/*.json` | copied to `themes/` | e.g. `tilix.json` |
| `fonts/*` | copied to `fonts/` | for machines that lack the font |
| `inputrc` | added to `~/.inputrc` (bash), when missing | Shift+Enter runs the command line instead of printing `;2;13~` |
| `herdr-app.in` | `~/.local/bin/herdr-app-personal`, which `herdr-app` points at | `ZED_FONTS_GAMMA=1.0` everywhere; with `--nomachine` also GL, `HERDR_RENDER_PARTIAL=cpu` and the `WAYLAND_DISPLAY=no` fix |

## Saving changes from a machine

```sh
personal/capture.sh --fonts --tilix   # then review, commit and push
```

`capture.sh` saves the key bindings that differ from Herdr's defaults, the look
settings, your own themes, the terminal font's files (`--fonts`) and a theme
and the font from this machine's Tilix (`--tilix`).

## Text like Tilix

Herdr lays out terminal text as Ghostty does: cells of whole pixels, every
character exactly on its cell, rows as tall as the font. Two settings in
`settings.json` make it measure as Tilix does. `font_weight: 400` draws regular
text at the regular weight (Herdr's default is 500). `terminal_line_height:
1.05` gives Tilix's rows: VTE stacks the rounded-up ascent and descent, so
DejaVu Sans Mono at 12 px gets 15 px rows with the baseline 12 px down (29 and
23 at 2x), where Herdr's own measure gives 14. With the same font at the same
pixel size (`capture.sh --tilix` takes both from Tilix), characters and rows
land on the same pixels as in Tilix. The glyph shapes can still differ by a
shade per pixel: Tilix draws them with FreeType, Herdr with its own rasterizer.
To compare unhinted glyphs, start Herdr with `HERDR_FONT_HINTING=0`.
