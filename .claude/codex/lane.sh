#!/usr/bin/env bash
# Usage: setsid nohup .claude/codex/lane.sh <lane-name> <brief-name>... > /dev/null 2>&1 &
# Runs the given briefs (.claude/codex/prompts/full/<name>.md) strictly one after another,
# each via run.sh; stops the lane on the first nonzero exit. Survives the architect session.
# MODEL/EFFORT env apply to all briefs unless a brief name is given as name:effort.
set -u
LANE="$1"; shift
REPO="/home/oem/Dokumente/003_Projekte/10_himmelcad"; OUT="$REPO/.claude/codex/out"
echo "$(date +%FT%T) lane $LANE start: $*" >> "$OUT/lanes.log"
for spec in "$@"; do
  name="${spec%%:*}"; eff="${spec#*:}"; [ "$eff" = "$spec" ] && eff="${EFFORT:-medium}"
  echo "$(date +%FT%T) lane $LANE -> $name ($eff)" >> "$OUT/lanes.log"
  EFFORT="$eff" "$REPO/.claude/codex/run.sh" "$name" "$REPO/.claude/codex/prompts/full/$name.md"
  code="$(cat "$OUT/$name.exit" 2>/dev/null || echo 1)"
  echo "$(date +%FT%T) lane $LANE <- $name exit=$code" >> "$OUT/lanes.log"
  [ "$code" = "0" ] || { echo "$(date +%FT%T) lane $LANE STOPPED at $name" >> "$OUT/lanes.log"; exit "$code"; }
done
echo "$(date +%FT%T) lane $LANE done" >> "$OUT/lanes.log"
