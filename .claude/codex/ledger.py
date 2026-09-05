#!/usr/bin/env python3
"""Sum Codex 'tokens used' across run logs. Usage: ledger.py [outdir]"""
import re, glob, os, sys
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), 'out')
tot = 0; rows = []
for f in sorted(glob.glob(os.path.join(out, '*.log'))):
    m = re.findall(r'tokens used\n([\d\.,]+)', open(f, errors='ignore').read())
    if m:
        n = int(m[-1].replace('.', '').replace(',', '')); tot += n; rows.append((n, os.path.basename(f)))
rows.sort(reverse=True)
print(f"runs: {len(rows)}  total tokens: {tot:,}")
for n, f in rows[:10]: print(f"  {n:>12,}  {f}")
