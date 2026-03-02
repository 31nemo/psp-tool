#!/usr/bin/env python3
"""
Generate eboot/assets.js from popstationr's data.h binary blobs.

Usage:
  1. Download data.h:
     curl -sL https://raw.githubusercontent.com/pseiler/popstationr/master/data.h -o /tmp/popstationr_data.h
  2. Run this script:
     python3 eboot/generate_assets.py /tmp/popstationr_data.h > eboot/assets.js
"""

import re
import base64
import sys

def extract_blobs(path):
    with open(path, 'r') as f:
        content = f.read()

    pattern = r'(?:unsigned\s+)?char\s+(\w+)\[[\w\d]+\]\s*=\s*\{([\s\S]*?)\};'
    results = {}
    for m in re.finditer(pattern, content):
        name = m.group(1)
        hex_str = m.group(2)
        bytes_list = re.findall(r'0x([0-9a-fA-F]{2})', hex_str)
        data = bytes(int(b, 16) for b in bytes_list)
        results[name] = base64.b64encode(data).decode()
    return results

def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    blobs = extract_blobs(sys.argv[1])
    needed = ['data1', 'data2', 'datapspbody', 'startdatheader', 'startdatfooter']

    print("// Static binary assets extracted from popstationr (GPL-2.0)")
    print("// These are firmware-compatible blobs needed for EBOOT.PBP construction")
    print("// Regenerate with: python3 eboot/generate_assets.py /tmp/popstationr_data.h > eboot/assets.js")
    print("")
    print("function b64decode(s) {")
    print("  const bin = atob(s);")
    print("  const u8 = new Uint8Array(bin.length);")
    print("  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);")
    print("  return u8;")
    print("}")
    print("")

    js_names = {
        'data1': 'data1',
        'data2': 'data2',
        'datapspbody': 'datapspbody',
        'startdatheader': 'startdatheader',
        'startdatfooter': 'startdatfooter',
    }

    for name in needed:
        b64 = blobs[name]
        size = len(base64.b64decode(b64))
        print(f"// {name}: {size} bytes")
        print(f"const {js_names[name]}B64 = '{b64}';")
        print("")

    print("const ASSETS = {")
    print("  get data1() { return b64decode(data1B64); },")
    print("  get data2() { return b64decode(data2B64); },")
    print("  get dataPsp() { return b64decode(datapspbodyB64); },")
    print("  get startdatHeader() { return b64decode(startdatheaderB64); },")
    print("  get startdatFooter() { return b64decode(startdatfooterB64); },")
    print("};")

if __name__ == '__main__':
    main()
