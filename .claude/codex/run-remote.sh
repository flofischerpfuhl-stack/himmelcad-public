#!/usr/bin/env bash
# Usage: run-remote.sh <name> <brief-file>   (env: REMOTE=user@100.100.224.9  MODEL=gpt-5.6-sol  EFFORT=high  RWORKDIR='C:\himmelcad')
# Prompts the Codex CLI installed on the Windows PC (authenticated there) over SSH/Tailscale;
# the brief is piped to `codex exec -` on the remote; logs land in .claude/codex/out/remote-<name>.*
set -u
NAME="$1"; BRIEF="$2"
REMOTE="${REMOTE:-win-himmelcad}"; MODEL="${MODEL:-gpt-5.6-sol}"; EFFORT="${EFFORT:-high}"
RWORKDIR="${RWORKDIR:-C:\\Users\\flori}"
OUT="$(git rev-parse --show-toplevel)/.claude/codex/out"; mkdir -p "$OUT"
: > "$OUT/remote-$NAME.log"; rm -f "$OUT/remote-$NAME.exit"
ssh -o BatchMode=yes -o ServerAliveInterval=30 "$REMOTE" \
  "codex exec -C \"$RWORKDIR\" -m $MODEL -c model_reasoning_effort=$EFFORT --color never --skip-git-repo-check -" \
  < "$BRIEF" >> "$OUT/remote-$NAME.log" 2>&1
echo $? > "$OUT/remote-$NAME.exit"
