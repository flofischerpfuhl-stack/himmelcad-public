#!/usr/bin/env bash
# Every lane runs in its own user systemd scope with a hard memory cap (LANE_MEM, default 16G): an OOM then kills only the lane,
# never the T3 Code / Claude process tree (2026-09-09: a 26 GB colmap in the A7c smoke OOM-killed the whole UI cgroup twice).
# Usage: run.sh <name> <prompt-file>
# Runs Codex CLI non-interactively in the repo, logs to .claude/codex/out/<name>.{log,last.md,exit}
set -u
# disk guard: never start a run below 15 GB free (owner 2026-09-08); warn below 25 GB
FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
if [ "${FREE_GB:-0}" -lt 15 ]; then echo "$(date +%FT%T) REFUSED $1: only ${FREE_GB} GB free" >> "$(dirname "$0")/out/lanes.log"; echo 1 > "$(dirname "$0")/out/$1.exit"; exit 1; fi
[ "${FREE_GB:-0}" -lt 25 ] && echo "$(date +%FT%T) WARN $1: ${FREE_GB} GB free" >> "$(dirname "$0")/out/lanes.log"
NAME="$1"; PROMPT="$2"
REPO="/home/oem/Dokumente/003_Projekte/10_himmelcad"
OUT="$REPO/.claude/codex/out"
export CARGO_TARGET_DIR="$REPO/target/builder"
: > "$OUT/$NAME.log"; rm -f "$OUT/$NAME.exit" "$OUT/$NAME.last.md"
EFFORT="${EFFORT:-medium}"; MODEL="${MODEL:-gpt-5.6-sol}"
IMGARGS=""; for i in ${IMAGES:-}; do IMGARGS="$IMGARGS -i $i"; done
systemd-run --user --scope --quiet -p MemoryMax="${LANE_MEM:-16G}" -p MemorySwapMax=0 -- codex exec $IMGARGS -C "$REPO" -m "$MODEL" -c model_reasoning_effort="$EFFORT" -c shell_environment_policy.inherit=all \
  --color never -o "$OUT/$NAME.last.md" - < "$PROMPT" >> "$OUT/$NAME.log" 2>&1
echo $? > "$OUT/$NAME.exit"
