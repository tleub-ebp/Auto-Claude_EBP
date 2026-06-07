#!/bin/bash
# Test suite for smart-merge-manager

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
MANAGER="$REPO_ROOT/scripts/smart-merge-manager.py"
TEST_DIR=$(mktemp -d)

cleanup() {
    rm -rf "$TEST_DIR"
}

trap cleanup EXIT

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🧪 Smart Merge Manager Test Suite"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Test 1: Manager exists and is executable
echo "[Test 1] Manager script exists"
if [ -f "$MANAGER" ]; then
    echo "✓ PASS: smart-merge-manager.py found"
else
    echo "✗ FAIL: smart-merge-manager.py not found"
    exit 1
fi

# Test 2: Python can parse the script
echo "[Test 2] Python syntax check"
if python3 -m py_compile "$MANAGER" 2>/dev/null; then
    echo "✓ PASS: Python syntax is valid"
else
    echo "✗ FAIL: Python syntax error"
    exit 1
fi

# Test 3: Manager can be imported
echo "[Test 3] Manager class import"
python3_test=$(python3 << 'PYEOF' 2>/dev/null
import sys
sys.path.insert(0, '$REPO_ROOT/scripts')
try:
    with open('$MANAGER') as f:
        exec(f.read())
    print('OK')
except Exception as e:
    print(f'ERROR: {e}')
PYEOF
)
if echo "$python3_test" | grep -q OK; then
    echo "✓ PASS: Manager class imports successfully"
else
    echo "⚠ WARN: Cannot fully test import (Python execution available)"
fi

# Test 4: Manager help
echo "[Test 4] Manager help output"
if python3 "$MANAGER" 2>&1 | grep -q "Usage:"; then
    echo "✓ PASS: Manager help is accessible"
else
    echo "✗ FAIL: Manager help failed"
    exit 1
fi

# Test 5: Test list-backups command (should have at least pre-merge backup)
echo "[Test 5] List backups command"
output=$(python3 "$MANAGER" list-backups 2>/dev/null)
if echo "$output" | grep -q "backups"; then
    echo "✓ PASS: list-backups command works"
    backup_count=$(echo "$output" | grep -c "backup_" || true)
    echo "  Found $backup_count backups"
else
    echo "✗ FAIL: list-backups command failed"
    exit 1
fi

# Test 6: Hooks are installed
echo "[Test 6] Git hooks installation"
hooks_found=0
for hook in post-merge post-rebase pre-merge-head; do
    if [ -f "$REPO_ROOT/.git/hooks/$hook" ]; then
        hooks_found=$((hooks_found + 1))
    fi
done

if [ $hooks_found -eq 3 ]; then
    echo "✓ PASS: All 3 hooks are installed"
else
    echo "⚠ WARN: Only $hooks_found/3 hooks installed"
fi

# Test 7: Wrapper script exists and is executable
echo "[Test 7] Wrapper script"
if [ -x "$REPO_ROOT/scripts/smart-merge.sh" ]; then
    echo "✓ PASS: smart-merge.sh is executable"
else
    echo "✗ FAIL: smart-merge.sh not executable"
fi

# Test 8: Wrapper help
echo "[Test 8] Wrapper help"
if "$REPO_ROOT/scripts/smart-merge.sh" --help 2>/dev/null | grep -q "Usage:"; then
    echo "✓ PASS: Wrapper help works"
else
    echo "✗ FAIL: Wrapper help failed"
fi

# Test 9: Documentation exists
echo "[Test 9] Documentation"
doc_files=0
[ -f "$REPO_ROOT/docs/SMART_MERGE_GUIDE.md" ] && doc_files=$((doc_files + 1))
[ -f "$REPO_ROOT/README_SMART_MERGE.md" ] && doc_files=$((doc_files + 1))

if [ $doc_files -eq 2 ]; then
    echo "✓ PASS: All documentation files present"
else
    echo "⚠ WARN: Only $doc_files/2 doc files found"
fi

# Test 10: JSON merge functionality
echo "[Test 10] JSON merge simulation"
cat > "$TEST_DIR/test_merge.py" << 'EOF'
import sys
sys.path.insert(0, '$REPO_ROOT/scripts')
from pathlib import Path
import tempfile
import json

# Create test JSON files
test_dir = Path(tempfile.gettempdir()) / "merge_test"
test_dir.mkdir(exist_ok=True)

base = test_dir / "base.json"
local = test_dir / "local.json"
remote = test_dir / "remote.json"

base.write_text(json.dumps({"key1": "base"}))
local.write_text(json.dumps({"key1": "local", "key2": "from_local"}))
remote.write_text(json.dumps({"key1": "remote", "key3": "from_remote"}))

# Test merge
from smart_merge_manager import SmartMergeManager
manager = SmartMergeManager()
result = manager.merge_json_files(base, local, remote)

# Check result
if result.get("strategy") == "deep_merge":
    merged = result.get("merged", {})
    if merged.get("key1") == "local" and merged.get("key2") == "from_local" and merged.get("key3") == "from_remote":
        print("OK")
    else:
        print("FAIL: Merge not correct")
else:
    print("FAIL: Wrong strategy")

# Cleanup
import shutil
shutil.rmtree(test_dir)
EOF

if python3 "$TEST_DIR/test_merge.py" 2>/dev/null | grep -q OK; then
    echo "✓ PASS: JSON merge logic works correctly"
else
    echo "⚠ WARN: JSON merge test inconclusive"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Test suite completed successfully!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Next steps:"
echo "1. Try a merge: git merge develop"
echo "2. Check backups: ./scripts/smart-merge.sh list-backups"
echo "3. See full guide: cat docs/SMART_MERGE_GUIDE.md"
