#!/usr/bin/env bash
# Usage: run.sh <name> <prompt-file>
# Runs Codex CLI non-interactively in the repo, logs to .claude/codex/out/<name>.{log,last.md,exit}
set -u
NAME="$1"; PROMPT="$2"
REPO="/home/oem/Dokumente/003_Projekte/10_himmelcad"
OUT="$REPO/.claude/codex/out"
export CARGO_TARGET_DIR="$REPO/target/builder"
: > "$OUT/$NAME.log"; rm -f "$OUT/$NAME.exit" "$OUT/$NAME.last.md"
EFFORT="${EFFORT:-medium}"; MODEL="${MODEL:-gpt-5.6-sol}"
IMGARGS=""; for i in ${IMAGES:-}; do IMGARGS="$IMGARGS -i $i"; done
codex exec $IMGARGS -C "$REPO" -m "$MODEL" -c model_reasoning_effort="$EFFORT" -c shell_environment_policy.inherit=all \
  --color never -o "$OUT/$NAME.last.md" - < "$PROMPT" >> "$OUT/$NAME.log" 2>&1
echo $? > "$OUT/$NAME.exit"
