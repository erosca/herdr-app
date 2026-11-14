# Personal setup (this fork only)

Not for upstream: keep `personal/` out of pull requests to herdrdev/herdr-app.

This branch carries local patches (partial redraw for software rendering, the
GPU backend switches, Shift+PageUp/PageDown scrolling, VTE-style terminal
cells) and the settings below.

## A new machine

```sh
git clone --branch claude/charming-sagan-deb1x6 https://github.com/erosca/herdr-app
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

## Another Ubuntu machine, without building

On a machine that has the build:

```sh
personal/package.sh --no-build   # packs target/release/herdr-app; without --no-build it builds first
```

It writes `dist/herdr-app-personal-<version>-<commit>-<cpu>.tar.xz` and a
`.sha256` beside it: the app, the launcher template and everything in the
table below. Copy the archive to the other machine, then:

```sh
tar -xf herdr-app-personal-*.tar.xz
herdr-app-personal-*/install.sh   # add --nomachine on a NoMachine desktop
```

The installer needs no git, Rust or root.

- **Checks first:** the CPU type, the glibc version, and the libraries the app
  links. For missing ones it prints the `sudo apt install` line and stops.
- **Then installs:** it copies the build to `~/.local/opt/herdr-app-personal/`
  and runs the bundled `setup.sh --no-build`. That gives the same launcher,
  menu entry, settings, agents and `~/.inputrc` lines as `setup.sh` does here.
- **herdr-core** still comes from releases.herdr.dev. `--no-core` skips it,
  and Herdr offers it when it opens.
- **Older builds:** it keeps the two newest, so a Herdr that's still running
  keeps working until you reopen it. The unpacked folder can be deleted.

Pack on the oldest Ubuntu you install to, because the app needs at least the
glibc it was built with. The archive holds a plain build, so it never updates
itself to upstream's release.

## What it applies

| File | Goes to | Notes |
|---|---|---|
| `keys.json` | merged into `keys.json` | Shift+Insert/Ctrl+Insert paste and copy, Shift+PageUp/PageDown scroll, Ctrl+Shift+arrows move between panes, Ctrl+Left/Right reach programs as in xterm (Herdr's default sends Alt+B/F, which takes vim out of Insert mode) |
| `settings.json` | merged into `settings.json` | font, size, zoom, theme |
| `themes/*.json` | copied to `themes/` | e.g. `tilix.json` |
| `fonts/*` | copied to `fonts/` | for machines that lack the font |
| `inputrc` | added to `~/.inputrc` (bash), when missing | Shift+Enter runs the command line instead of printing `;2;13~`; Ctrl+Left/Right move by word |
| `bin/*` | `~/.local/bin/` | agents' programs, e.g. `dummy-agent` |
| `hc-templates/*.md` | `~/.config/herdr-core/templates/` | agents `hc run` starts by name |
| `programs.json` | merged into `programs.json` | agents' names and tiles in Herdr, and its menu of agents to start |
| `herdr-app.in` | `~/.local/bin/herdr-app-personal`, which `herdr-app` points at | `ZED_FONTS_GAMMA=1.0` and `HERDR_VTE_COMPAT=1` everywhere; with `--nomachine` also GL, `HERDR_RENDER_PARTIAL=cpu` and the `WAYLAND_DISPLAY=no` fix |

## Saving changes from a machine

```sh
personal/capture.sh --fonts --tilix   # then review, commit and push
```

`capture.sh` saves the key bindings that differ from Herdr's defaults, the look
settings, your own themes, the terminal font's files (`--fonts`) and a theme
and the font from this machine's Tilix (`--tilix`).

## Text like Tilix

`HERDR_VTE_COMPAT=1` (set by the launcher) makes Herdr lay out terminal text
as Tilix does: cells of whole pixels, every character exactly on its cell, rows
as tall as the font without Herdr's 15% extra, regular text at regular weight.
With the same font at the same pixel size (`capture.sh --tilix` takes both
from Tilix), characters and rows land on the same pixels as in Tilix. The
glyph shapes can still differ by a shade per pixel: Tilix draws them with
FreeType, Herdr with its own rasterizer. To compare unhinted glyphs, start
Herdr with `HERDR_FONT_HINTING=0`.

## Checking the agents list's conversation window

`personal/tools/agents-mod-test/check.py` runs the `agents` mod's conversation
window (what a sub-agent opens as, finished or still working) in Herdr's own
engine, with `herdr-app check`: on made-up codex and Kimi Code logs in their real
formats, one of them growing between looks as a log does while it is written, or
with `--real <address>...` on runs of this machine's herdr-core. It needs
`python3` and `herdr-app`, nothing else. Run it after changing
`defaults/mods/agents/thread.js` or `conversation.js`:

```sh
personal/tools/agents-mod-test/check.py                       # the fixture cases
personal/tools/agents-mod-test/check.py --real t1g t1h --as vm   # real runs, as seen from another computer
personal/tools/agents-mod-test/check.py --real t6m --as vm --looks 3   # one still going, read on twice
```

## Dummy agent

`dummy-agent` is the smallest agent, to try Herdr's agent features with: every
question takes 10 seconds (`DUMMY_AGENT_DELAY`), then the answer is `done`. It
reports its state through OSC 7501, so Herdr treats it like Claude or Codex:

- **Start it** from Herdr's new-agent menu (**Dummy agent**), or run
  `dummy-agent` in a terminal pane. Type a question and press Enter.
- **Watch it:** the sidebar and tab show it working, then done.
- **Notifications:** switch to another tab while it works. When it answers,
  Herdr plays the "done" sound and posts a "dummy finished" toast; click it to
  go back. While you look at it, there is no toast.
- **From a shell or another agent** (`hc`, herdr-core's command):

  ```sh
  hc run --bg --name d dummy "Is it done?"   # starts it, sends the question
  hc wait d                                  # returns once it answered
  hc read d --lines 5                        # its screen: the answer
  hc send d "Another one"; hc wait d
  hc kill d
  ```

  An agent that starts it this way becomes its parent and gets its news.
- **Stop an answer** with Ctrl+C (or `hc interrupt d`); Ctrl+D quits.
