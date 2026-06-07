#!/bin/bash
# Uninstall smart merge/rebase hooks

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
HOOKS_DIR="$REPO_ROOT/.git/hooks"

echo "[Smart Merge] Uninstalling git hooks..."

for hook in pre-merge-head post-merge post-rebase; do
    hook_path="$HOOKS_DIR/$hook"
    bak_path="$hook_path.bak"

    if [ -f "$hook_path" ]; then
        if grep -q "Smart Merge" "$hook_path" 2>/dev/null; then
            rm "$hook_path"
            echo "✓ Removed $hook hook"

            # Restore backup if exists
            if [ -f "$bak_path" ]; then
                mv "$bak_path" "$hook_path"
                echo "  Restored previous $hook hook"
            fi
        fi
    fi
done

echo "✓ Git hooks uninstalled successfully!"
