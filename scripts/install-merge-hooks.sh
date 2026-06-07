#!/bin/bash
# Install smart merge/rebase hooks

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
HOOKS_DIR="$REPO_ROOT/.git/hooks"
SCRIPT_HOOKS_DIR="$REPO_ROOT/scripts/git-hooks"

echo "[Smart Merge] Installing git hooks..."

# Create hooks directory if needed
mkdir -p "$HOOKS_DIR"

# Copy hooks
for hook in pre-merge-head post-merge post-rebase; do
    source="$SCRIPT_HOOKS_DIR/$hook"
    dest="$HOOKS_DIR/$hook"

    if [ ! -f "$source" ]; then
        echo "⚠ Warning: Hook file not found: $source"
        continue
    fi

    # Backup existing hook if any
    if [ -f "$dest" ] && ! grep -q "Smart Merge" "$dest" 2>/dev/null; then
        echo "  Backing up existing $hook hook"
        cp "$dest" "$dest.bak"
    fi

    # Copy and make executable
    cp "$source" "$dest"
    chmod +x "$dest"
    echo "✓ Installed $hook hook"
done

echo "✓ Git hooks installed successfully!"
echo ""
echo "The following hooks are now active:"
echo "  - pre-merge-head: Backs up .workpilot before merge"
echo "  - post-merge: Restores and merges .workpilot after merge"
echo "  - post-rebase: Restores and merges .workpilot after rebase"
echo ""
echo "To uninstall, run: scripts/uninstall-merge-hooks.sh"
