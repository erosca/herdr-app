#!/usr/bin/env python3
"""Writes a Herdr theme from the default Tilix profile on this machine.

  tilix_theme.py <out.json>

Tilix stores some colors with 16 bits per channel (#RRRRGGGGBBBB); those are
read as 8 bits. With "Use theme colors" on, Tilix keeps no background or text
color, so the measured #181818 / #ffffff are used. With "Show bold text in
bright colors" on, normal blue takes bright blue (`ls` directories are bold),
since Herdr has no such option.
"""
import json
import pathlib
import re
import subprocess
import sys


def get(schema, key):
    r = subprocess.run(["gsettings", "get", schema, key], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ""


def colors(text):
    out = []
    pattern = r"rgba?\((\d+),\s*(\d+),\s*(\d+)|#([0-9a-fA-F]{12}|[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])"
    for m in re.finditer(pattern, text):
        if m.group(1):
            out.append("#%02x%02x%02x" % tuple(int(m.group(i)) for i in (1, 2, 3)))
            continue
        h = m.group(4).lower()
        h = {12: h[0:2] + h[4:6] + h[8:10], 8: h[:6], 3: "".join(c * 2 for c in h)}.get(len(h), h)
        out.append("#" + h)
    return out


def main(out):
    uuid = get("com.gexperts.Tilix.ProfilesList", "default").strip("'")
    profile = f"com.gexperts.Tilix.Profile:/com/gexperts/Tilix/profiles/{uuid}/"
    ansi = colors(get(profile, "palette"))
    if len(ansi) != 16:
        sys.exit("could not read the Tilix palette (is Tilix installed here?)")
    own = get(profile, "use-theme-colors") == "false"
    theme = {
        "background": colors(get(profile, "background-color"))[0] if own else "#181818",
        "foreground": colors(get(profile, "foreground-color"))[0] if own else "#ffffff",
        "selection": colors(get(profile, "highlight-background-color"))[0]
        if get(profile, "use-highlight-color") == "true" else "#3d4f6a",
        "ansi": ansi,
    }
    if get(profile, "use-cursor-color") == "true":
        theme["cursor"] = colors(get(profile, "cursor-background-color"))[0]
    if get(profile, "bold-is-bright") == "true":
        theme["ansi"][4] = theme["ansi"][12]
    path = pathlib.Path(out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(theme, indent=2) + "\n")
    print(f"  wrote:     {path}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
