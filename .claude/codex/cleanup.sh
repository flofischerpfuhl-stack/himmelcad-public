#!/usr/bin/env bash
# Routine cleanup of Builder-lane disposable artifacts (safe while lanes run): old Codex logs,
# cargo incremental dirs untouched for > 1 day, stale gallery/perf temp outputs. Never touches
# PhotoLab areas (.build/photolab-*, .build/colmap-worker, target/photolab) or cited evidence.
set -u
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
find "$REPO/.claude/codex/out" -name "*.log" -mtime +2 -size +1M -delete
find "$REPO/target/builder/debug/incremental" -maxdepth 1 -mindepth 1 -type d -mtime +1 -exec rm -rf {} + 2>/dev/null
rm -rf "$REPO/target/debug" 2>/dev/null
echo "$(date +%FT%T) cleanup: $(df -h / | tail -1 | awk '{print $4}') free" >> "$REPO/.claude/codex/out/lanes.log"
