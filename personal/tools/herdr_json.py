#!/usr/bin/env python3
"""JSON chores for personal/setup.sh and personal/capture.sh.

  herdr_json.py merge-keys <personal> <target> <defaults>
      Adds personal bindings to the target keys.json, section by section. A
      missing target starts from Herdr's defaults, which is what Herdr itself
      writes on its first start.
  herdr_json.py merge-settings <personal> <target> <themes-dir>
      Sets the personal settings.json values in the target. A "theme" is only
      set when its file is in themes-dir (or is a built-in theme).
  herdr_json.py merge-programs <personal> <target>
      Adds the personal programs.json entries to the target, entry by entry
      (a personal field wins), and its shells and interpreters.
  herdr_json.py capture-keys <current> <defaults> <out>
      Updates out with the bindings in current that differ from Herdr's
      defaults. Bindings out already lists stay (with current's value), so
      ones that match this build's defaults still reach machines whose older
      keys.json lacks them.
  herdr_json.py capture-settings <current> <out>
      Writes the look settings from current (font, size, zoom, theme, ...).

An existing target is backed up as <file>.bak-<time> before it changes
(merges only: captured files live in git).
"""
import json
import pathlib
import shutil
import sys
import time

BUILT_IN_THEMES = {"graphite", "ink", "moss", "paper"}
LOOK_SETTINGS = ["theme", "font", "font_size", "ui_font", "zoom", "colors", "appearance", "minimum_contrast", "invert_selection", "bold_is_bright", "scrollback_lines"]


def load(path, default=None):
    path = pathlib.Path(path)
    if not path.exists():
        return default
    return json.loads(path.read_text())


def save(path, data, backup=True):
    path = pathlib.Path(path)
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    if path.exists():
        if path.read_text() == text:
            print(f"  unchanged: {path}")
            return
    if path.exists() and backup:
        copy = path.with_name(f"{path.name}.bak-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(path, copy)
        print(f"  backup:    {copy}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    print(f"  wrote:     {path}")


def merge_keys(personal, target, defaults):
    keys = load(target) or load(defaults, {})
    for section, bindings in load(personal, {}).items():
        keys.setdefault(section, {}).update(bindings)
    save(target, keys)


def merge_settings(personal, target, themes_dir):
    settings = load(target, {})
    for key, value in load(personal, {}).items():
        if key == "theme" and isinstance(value, str) and value not in BUILT_IN_THEMES \
                and not (pathlib.Path(themes_dir) / f"{value}.json").exists():
            print(f"  skipped:   theme {value!r} (no themes/{value}.json; run capture.sh where it exists)")
            continue
        settings[key] = value
    save(target, settings)


def merge_programs(personal, target):
    table = load(target, {})
    mine = load(personal, {})
    for key, entry in mine.get("programs", {}).items():
        programs = table.setdefault("programs", {})
        programs[key] = {**programs.get(key, {}), **entry}
    for key in ("shells", "interpreters"):
        if mine.get(key):
            table[key] = table.get(key, []) + [n for n in mine[key] if n not in table.get(key, [])]
    save(target, table)


def capture_keys(current, defaults, out):
    keys, base = load(current, {}), load(defaults, {})
    personal = load(out, {})
    for section, bindings in personal.items():
        for key in bindings:
            if key in keys.get(section, {}):
                bindings[key] = keys[section][key]
    for section, bindings in keys.items():
        changed = {k: v for k, v in bindings.items() if base.get(section, {}).get(k) != v}
        if changed:
            personal.setdefault(section, {}).update(changed)
    save(out, personal, backup=False)


def capture_settings(current, out):
    settings = load(current, {})
    save(out, {k: settings[k] for k in LOOK_SETTINGS if k in settings}, backup=False)


if __name__ == "__main__":
    commands = {
        "merge-keys": merge_keys,
        "merge-settings": merge_settings,
        "merge-programs": merge_programs,
        "capture-keys": capture_keys,
        "capture-settings": capture_settings,
    }
    if len(sys.argv) < 2 or sys.argv[1] not in commands:
        sys.exit(__doc__)
    commands[sys.argv[1]](*sys.argv[2:])
