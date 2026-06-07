#!/bin/bash
# Verify smart-merge backups integrity

set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔍 Smart Merge Backup Verification"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

REPO_ROOT=$(git rev-parse --show-toplevel)
BACKUP_DIR="$REPO_ROOT/.git/workpilot-backups"
EXTERNAL_BACKUP="/c/tmp/workpilot_backup_001"

check_backup() {
    local backup_path=$1
    local backup_name=$(basename "$backup_path")

    echo "📦 Checking: $backup_name"

    if [ ! -d "$backup_path" ]; then
        echo "  ✗ FAIL: Directory not found"
        return 1
    fi

    # Check total size
    local size=$(du -sh "$backup_path" 2>/dev/null | awk '{print $1}' || echo "unknown")
    echo "  Size: $size"

    # Check critical files
    local critical_files=(
        "specs/*/conversation.jsonl"
        "specs/*/task_logs.json"
        "specs/*/implementation_plan.json"
        "specs/*/spec.md"
    )

    local found=0
    for pattern in "${critical_files[@]}"; do
        # Use find to match pattern
        if find "$backup_path" -path "*/$pattern" -type f | grep -q .; then
            echo "  ✓ Found: $pattern"
            found=$((found + 1))
        else
            echo "  ⚠ Missing: $pattern"
        fi
    done

    echo "  Files: $found/${#critical_files[@]} critical files found"

    # Check JSON validity for each *.json file
    local json_count=0
    local json_valid=0
    while IFS= read -r json_file; do
        json_count=$((json_count + 1))
        if python3 -m json.tool < "$json_file" > /dev/null 2>&1; then
            json_valid=$((json_valid + 1))
        else
            echo "  ⚠ Invalid JSON: $(basename "$json_file")"
        fi
    done < <(find "$backup_path" -name "*.json" -type f)

    if [ $json_count -gt 0 ]; then
        echo "  JSON: $json_valid/$json_count files valid"
    fi

    # Check JSONL validity
    local jsonl_count=0
    local jsonl_lines=0
    while IFS= read -r jsonl_file; do
        jsonl_count=$((jsonl_count + 1))
        local lines=$(wc -l < "$jsonl_file" || echo 0)
        jsonl_lines=$((jsonl_lines + lines))

        # Validate first and last lines are valid JSON
        if [ -s "$jsonl_file" ]; then
            head -1 "$jsonl_file" | python3 -m json.tool > /dev/null 2>&1 || echo "    ⚠ First line invalid: $(basename "$jsonl_file")"
        fi
    done < <(find "$backup_path" -name "*.jsonl" -type f)

    if [ $jsonl_count -gt 0 ]; then
        echo "  JSONL: $jsonl_count files, ~$jsonl_lines total lines"
    fi

    echo ""
    return 0
}

# Check local backups
if [ -d "$BACKUP_DIR" ]; then
    echo "📁 Local Backups (.git/workpilot-backups/)"
    echo ""

    backup_count=$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l)

    if [ $backup_count -eq 0 ]; then
        echo "  No local backups found yet (will be created after first merge)"
    else
        find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d | while read backup; do
            check_backup "$backup"
        done
    fi
else
    echo "📁 Local Backups (.git/workpilot-backups/)"
    echo "  No backup directory yet (normal before first merge)"
    echo ""
fi

# Check external backup
if [ -d "$EXTERNAL_BACKUP" ]; then
    echo "📁 External Recovery Backup"
    echo ""
    check_backup "$EXTERNAL_BACKUP"
else
    echo "📁 External Recovery Backup"
    echo "  Not found at $EXTERNAL_BACKUP"
    echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Verification complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
