#!/usr/bin/env python3
"""Render the HimmelCAD opencascade.js consumer YAML.

usage: render-config.py <replicad custom_build_single.yml> <extra-bindings.yml> <out.yml>

Takes replicad's rendered single-threaded build configuration unchanged and
appends the HimmelCAD bindings and C++ wrapper files. Pure text processing on
purpose (no PyYAML needed): replicad's file is a flat, ytt-rendered YAML with
`mainBuild.name`, `mainBuild.bindings`, `mainBuild.emccFlags` and a top-level
`additionalCppFiles` list.
"""

import re
import sys


def parse_extra(path):
    name = None
    bindings, files = [], []
    section = None
    for raw in open(path, encoding="utf-8"):
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        if line.startswith("name:"):
            name = line.split(":", 1)[1].strip()
        elif line.startswith("bindings:"):
            section = bindings
        elif line.startswith("additionalCppFiles:"):
            section = files
        elif line.lstrip().startswith("- ") and section is not None:
            item = line.lstrip()[2:].strip()
            if item.startswith("symbol:"):
                item = item.split(":", 1)[1].strip()
            section.append(item)
    if not name:
        raise SystemExit("extra-bindings.yml: missing name")
    return name, bindings, files


def main():
    base_path, extra_path, out_path = sys.argv[1:4]
    name, bindings, files = parse_extra(extra_path)
    text = open(base_path, encoding="utf-8").read()
    text, n = re.subn(r"^(  name: )replicad_single\.js$", r"\g<1>" + name, text, flags=re.M)
    if n != 1:
        raise SystemExit("base config: mainBuild.name replicad_single.js not found")
    existing = set(re.findall(r"^  - symbol: (\S+)$", text, flags=re.M))
    added = "".join(f"  - symbol: {b}\n" for b in bindings if b not in existing)
    marker = "  emccFlags:\n"
    if marker not in text:
        raise SystemExit("base config: emccFlags not found")
    text = text.replace(marker, added + marker, 1)
    if not text.endswith("\n"):
        text += "\n"
    if "\nadditionalCppFiles:\n" not in text:
        raise SystemExit("base config: additionalCppFiles not found")
    text += "".join(f"- {f}\n" for f in files)
    open(out_path, "w", encoding="utf-8", newline="\n").write(text)
    print(f"{out_path}: {name}, +{len(bindings)} bindings, +{len(files)} C++ files")


if __name__ == "__main__":
    main()
