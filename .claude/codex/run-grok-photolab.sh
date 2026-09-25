#!/usr/bin/env bash
# Usage: run-grok-photolab.sh <name> <prompt-file>  (headless Grok Build; PhotoLab lane)
set -u
NAME="photolab-$1"; PROMPT="$2"
REPO="/home/oem/Dokumente/003_Projekte/10_himmelcad"
OUT="$REPO/.claude/codex/out"
export CARGO_TARGET_DIR="$REPO/target/photolab"
: > "$OUT/$NAME.log"; rm -f "$OUT/$NAME.exit" "$OUT/$NAME.last.md"
grok --cwd "$REPO" --prompt-file "$PROMPT" --output-format plain \
  --permission-mode bypassPermissions --always-approve --no-alt-screen \
  ${GROK_MODEL:+-m "$GROK_MODEL"} ${GROK_EFFORT:+--reasoning-effort "$GROK_EFFORT"} \
  > "$OUT/$NAME.last.md" 2>> "$OUT/$NAME.log"
echo $? > "$OUT/$NAME.exit"
