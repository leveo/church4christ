#!/usr/bin/env bash
# Produce a clean, publishable export of Church4Christ with a fresh, single-commit
# history — ready to push to a brand-new public GitHub repo.
#
#   scripts/export-public.sh <target-dir>
#
# What it guarantees:
#   * Only files tracked at HEAD ship (git archive), so gitignored/untracked local
#     state — node_modules/, dist/, .wrangler/, .dev.vars, .superpowers/ — never
#     leaks into the export.
#   * docs/superpowers/ (internal design history, which IS tracked in this repo) is
#     stripped from the export.
#   * The export is a standalone git repo with exactly one commit and no upstream
#     history or session metadata.
#
# The local repo keeps its full history untouched; this only writes to <target-dir>.
set -euo pipefail

TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: scripts/export-public.sh <target-dir>" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Refuse to clobber an existing non-empty directory.
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "error: target '$TARGET' already exists and is not empty" >&2
  exit 1
fi
mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"

# 1. Export tracked files at HEAD only.
git archive --format=tar HEAD | tar -x -C "$TARGET"

# 2. Strip internal design history (tracked, so it rode along in the archive).
rm -rf "$TARGET/docs/superpowers"

# 3. Fresh single-commit history — no upstream metadata, no session trailers.
cd "$TARGET"
git init -q -b main
git add -A
git commit -q -F - <<'MSG'
Initial release: Church4Christ open-source church CMS

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
MSG

echo "Clean export ready at: $TARGET"
echo "  files:   $(git ls-files | wc -l | tr -d ' ')"
echo "  commits: $(git rev-list --count HEAD)"
echo "Next: git -C \"$TARGET\" remote add origin <url> && git -C \"$TARGET\" push -u origin main"
