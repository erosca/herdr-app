#!/usr/bin/env python3
"""Writes a Herdr theme from the default Tilix profile on this machine.

  tilix_theme.py <out.json> [<settings.json>]

With a settings.json, also sets its font, font_size and zoom to what Tilix
draws: the family that the profile's font resolves to (as fontconfig resolves
"Monospace") at the same pixel size (points * DPI / 72), at zoom 1.0.

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


def run(*cmd):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True)
    except FileNotFoundError:
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


# Words a Pango font description puts between the family and the size.
STYLE_WORDS = {
    "normal", "roman", "regular", "book", "medium", "bold", "italic", "oblique",
    "light", "thin", "heavy", "black", "semi-bold", "demi-bold", "extra-bold",
    "ultra-bold", "semi-light", "extra-light", "ultra-light", "condensed",
    "semi-condensed", "expanded", "semi-expanded", "small-caps",
}


def font(profile):
    """(family, pixels, description) of the font the Tilix profile draws."""
    if get(profile, "use-system-font") == "true":
        desc = get("org.gnome.desktop.interface", "monospace-font-name").strip("'")
    else:
        desc = get(profile, "font").strip("'")
    words = desc.replace(",", " ").split()
    size, unit = 10.0, "pt"  # Pango's default size
    if words and re.fullmatch(r"[\d.]+(px)?", words[-1]):
        last = words.pop()
        unit = "px" if last.endswith("px") else "pt"
        size = float(last.removesuffix("px"))
    while words and words[-1].lower() in STYLE_WORDS:
        words.pop()
    name = " ".join(words) or "Monospace"
    family = run("fc-match", "-f", "%{family[0]}", name) or name
    if unit == "px":
        return family, size, desc, None
    dpi = re.search(r"Xft\.dpi:\s*([\d.]+)", run("xrdb", "-query"))
    if dpi:
        dpi = float(dpi.group(1))
    else:
        scale = re.search(r"[\d.]+$", get("org.gnome.desktop.interface", "text-scaling-factor"))
        dpi = 96.0 * (float(scale.group(0)) if scale else 1.0)
    return family, size * dpi / 72.0, desc, dpi


def set_font(profile, settings_path):
    family, pixels, desc, dpi = font(profile)
    path = pathlib.Path(settings_path)
    settings = json.loads(path.read_text()) if path.exists() else {}
    settings.update({"font": family, "font_size": round(pixels, 2), "zoom": 1.0})
    path.write_text(json.dumps(settings, indent=2, ensure_ascii=False) + "\n")
    at = f" at {dpi:g} dpi" if dpi else ""
    print(f"  font:      Tilix {desc!r}{at} = {family} {pixels:g} px")
    print(f"  wrote:     {path}")


def main(out, settings=None):
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
    if settings:
        set_font(profile, settings)


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    main(*sys.argv[1:])
