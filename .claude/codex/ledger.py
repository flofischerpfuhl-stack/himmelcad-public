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


# --- rollout-based totals (Codex >= 0.15x no longer prints "tokens used") ---
if __name__ == "__main__":
    import json, glob, os, sys
    rows = []
    for path in sorted(glob.glob(os.path.expanduser("~/.codex/sessions/*/*/*/rollout-*.jsonl"))):
        last = None
        with open(path, errors="ignore") as fh:
            for line in fh:
                if "total_token_usage" in line:
                    last = line
        if not last:
            continue
        try:
            o = json.loads(last)
        except Exception:
            continue
        txt = json.dumps(o)
        i = txt.find('"total_tokens":', txt.find("total_token_usage"))
        total = int(txt[i + 15 : txt.find(",", i)].strip().rstrip("}")) if i >= 0 else 0
        rows.append((os.path.basename(path)[8:27], total))
    if rows:
        print("\nrollout totals (session start -> total tokens):")
        for ts, total in rows[-12:]:
            print(f"  {ts}  {total:>14,}")
        pass  # cumulative sum omitted: older rollouts carry non-additive counters
