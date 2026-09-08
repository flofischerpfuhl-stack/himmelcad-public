#!/usr/bin/env bash
# Verify the STAGED INDEX (not the shared working tree) before a commit on the multi-lane tree.
# Exports the index to .build/verify-staged/ (source paths only), links node_modules from the main tree,
# runs the root typecheck there; for Rust creates a detached worktree of the staged tree and runs the
# sidecar check with its own CARGO_TARGET_DIR. Never touches the working tree; never uses /tmp.
set -u
REPO="$(git rev-parse --show-toplevel)"; cd "$REPO"
OUT="$REPO/.build/verify-staged"; RS="$REPO/.build/verify-staged-rs"
FREE_GB=$(df -BG --output=avail "$REPO" | tail -1 | tr -dc 0-9); [ "${FREE_GB:-0}" -lt 20 ] && { echo "REFUSED: only ${FREE_GB} GB free"; exit 2; }
rm -rf "$OUT"; mkdir -p "$OUT"
git ls-files -z -- apps packages crates scripts schemas sdk package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json tsconfig.base.json Cargo.toml Cargo.lock eslint.config.js .prettierrc .prettierrc.json .prettierignore 2>/dev/null | git checkout-index -z --stdin --prefix="$OUT/"
ln -s "$REPO/node_modules" "$OUT/node_modules"
for d in $(cd "$REPO" && find apps packages -maxdepth 2 -name node_modules -type d 2>/dev/null); do mkdir -p "$OUT/$(dirname "$d")"; ln -s "$REPO/$d" "$OUT/$d"; done
echo "== root typecheck on the staged index"; (cd "$OUT" && pnpm typecheck >"$OUT/typecheck.log" 2>&1); TS=$?; echo "typecheck exit=$TS"; [ $TS -ne 0 ] && grep -E "error|ERR" "$OUT/typecheck.log" | head -6
if git diff --cached --name-only | grep -q "^crates/"; then
  TREE=$(git write-tree); C=$(git commit-tree "$TREE" -p HEAD -m "staged snapshot"); git worktree remove --force "$RS" 2>/dev/null; git worktree add --detach "$RS" "$C" >/dev/null 2>&1
  echo "== sidecar check on the staged snapshot"; (cd "$RS" && PATH="$HOME/.cargo/bin:$PATH" CARGO_TARGET_DIR="$REPO/target/verify" cargo check -p himmelcad-sidecar --tests --bins 2>&1 | grep -E "^error|Finished" | head -3); RSX=${PIPESTATUS[0]}
  git worktree remove --force "$RS" 2>/dev/null
else RSX=0; echo "== no crate changes staged; sidecar check skipped"; fi
cp "$OUT/typecheck.log" "$REPO/.build/verify-staged.log" 2>/dev/null; rm -rf "$OUT"
[ $TS -eq 0 ] && [ "${RSX:-1}" -eq 0 ] && echo "STAGED SNAPSHOT GREEN" || { echo "STAGED SNAPSHOT RED"; exit 1; }
