#!/bin/bash
# Smart merge/rebase wrapper with automatic .workpilot preservation

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
MANAGER="$REPO_ROOT/scripts/smart-merge-manager.py"

if [ ! -f "$MANAGER" ]; then
    echo "Error: smart-merge-manager.py not found!"
    exit 1
fi

show_help() {
    cat <<EOF
Smart Merge/Rebase Manager

Usage: smart-merge.sh <command> [options]

Commands:
  merge <branch>              - Merge branch with .workpilot preservation
  rebase <branch>             - Rebase on branch with .workpilot preservation
  list-backups                - List available .workpilot backups
  restore <backup-name>       - Restore .workpilot from backup
  status                      - Show merge/rebase status

Examples:
  smart-merge.sh merge develop
  smart-merge.sh rebase origin/develop
  smart-merge.sh list-backups
  smart-merge.sh restore backup_20240602_120000_develop

Options:
  -h, --help                  - Show this help message
  --no-hooks                  - Skip automatic hook setup
EOF
}

if [ $# -eq 0 ]; then
    show_help
    exit 0
fi

command=$1
shift

case "$command" in
    merge)
        if [ $# -eq 0 ]; then
            echo "Error: merge requires a branch name"
            echo "Usage: smart-merge.sh merge <branch>"
            exit 1
        fi
        branch=$1

        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "🔄 Smart Merge: $branch"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        # Prepare
        python3 "$MANAGER" prepare "$branch"

        # Perform merge
        echo ""
        echo "[Git] Merging $branch..."
        git merge "$branch" || {
            echo "⚠ Merge conflict detected. Resolve manually and continue."
            exit 1
        }

        # Complete
        echo ""
        python3 "$MANAGER" complete "$branch"
        echo ""
        echo "✓ Smart merge completed successfully!"
        ;;

    rebase)
        if [ $# -eq 0 ]; then
            echo "Error: rebase requires a branch name"
            echo "Usage: smart-merge.sh rebase <branch>"
            exit 1
        fi
        branch=$1

        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "🔄 Smart Rebase: $branch"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        # Prepare
        python3 "$MANAGER" prepare "$branch"

        # Perform rebase
        echo ""
        echo "[Git] Rebasing on $branch..."
        git rebase "$branch" || {
            echo "⚠ Rebase conflict detected. Resolve manually with: git rebase --continue"
            exit 1
        }

        # Complete
        echo ""
        python3 "$MANAGER" complete "$branch"
        echo ""
        echo "✓ Smart rebase completed successfully!"
        ;;

    list-backups)
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "📦 Available .workpilot Backups"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        python3 "$MANAGER" list-backups | python3 -m json.tool
        ;;

    restore)
        if [ $# -eq 0 ]; then
            echo "Error: restore requires a backup name"
            echo "Usage: smart-merge.sh restore <backup-name>"
            exit 1
        fi
        backup=$1

        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "♻️  Restoring backup: $backup"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        python3 "$MANAGER" restore "$backup"
        echo "✓ Backup restored!"
        ;;

    status)
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "📊 Merge/Rebase Status"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        if [ -f ".git/MERGE_HEAD" ]; then
            echo "Status: MERGING"
            echo "Target: $(cat .git/MERGE_HEAD)"
        elif [ -f ".git/rebase-merge/head-name" ]; then
            echo "Status: REBASING"
            echo "Target: $(cat .git/rebase-merge/head-name)"
        else
            echo "Status: No merge or rebase in progress"
        fi

        if [ -f ".git/merge-state.json" ]; then
            echo ""
            echo "Merge State:"
            python3 -m json.tool < ".git/merge-state.json"
        fi
        ;;

    -h|--help|help)
        show_help
        ;;

    *)
        echo "Error: Unknown command '$command'"
        show_help
        exit 1
        ;;
esac
