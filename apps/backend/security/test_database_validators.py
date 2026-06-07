"""Regression tests for security/database_validators.py.

Covers bug #22 (DELETE WHERE 1=1 bypass + SQL comment splice) and the
hardening of `_is_safe_database_name`.
"""

from __future__ import annotations

import sys
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from security.database_validators import (  # noqa: E402
    _contains_destructive_sql,
    _is_safe_database_name,
    _strip_sql_comments,
    validate_dropdb_command,
    validate_psql_command,
)

# ─────────────────────────────────────────────────────────────────────
# Bug #22: tautological WHERE clauses
# ─────────────────────────────────────────────────────────────────────


class TestDestructiveSQLDetection:
    def test_delete_no_where_caught(self) -> None:
        # Pre-existing rule, sanity check.
        ok, m = _contains_destructive_sql("DELETE FROM users")
        assert ok and "DELETE" in m.upper()

    def test_delete_where_1_eq_1_caught(self) -> None:
        # Pre-fix: this passed (regex required `;` or end after table name).
        ok, _ = _contains_destructive_sql("DELETE FROM users WHERE 1=1")
        assert ok, "DELETE WHERE 1=1 must be flagged as destructive"

    def test_delete_where_1_eq_1_with_spaces(self) -> None:
        ok, _ = _contains_destructive_sql("DELETE FROM users WHERE 1 = 1")
        assert ok

    def test_delete_where_true_caught(self) -> None:
        ok, _ = _contains_destructive_sql("DELETE FROM users WHERE TRUE")
        assert ok

    def test_delete_where_id_not_null_caught(self) -> None:
        ok, _ = _contains_destructive_sql("DELETE FROM users WHERE id IS NOT NULL")
        assert ok

    def test_legitimate_delete_with_predicate_allowed(self) -> None:
        # A real WHERE on a real predicate must NOT be flagged — otherwise
        # the validator becomes useless for ordinary DELETE statements.
        ok, _ = _contains_destructive_sql(
            "DELETE FROM sessions WHERE expires_at < NOW()"
        )
        assert not ok

    def test_select_not_destructive(self) -> None:
        ok, _ = _contains_destructive_sql("SELECT * FROM users")
        assert not ok


class TestCommentSpliceBypass:
    """Bug #22: PostgreSQL/MySQL splice tokens across `/* */`."""

    def test_strip_comments_collapses_keyword(self) -> None:
        # `DR/**/OP` becomes `DROP` after stripping (NOT `DR  OP`).
        assert _strip_sql_comments("DR/**/OP TABLE x") == "DROP TABLE x"

    def test_drop_with_inline_comment_caught(self) -> None:
        ok, m = _contains_destructive_sql("DR/**/OP TABLE users")
        assert ok
        assert "DROP" in m.upper()

    def test_truncate_with_inline_comment_caught(self) -> None:
        ok, _ = _contains_destructive_sql("TRUNC/**/ATE TABLE sessions")
        assert ok

    def test_multiline_comment_caught(self) -> None:
        ok, _ = _contains_destructive_sql(
            "DROP/* this kills everything\nbe careful */ DATABASE prod"
        )
        assert ok


# ─────────────────────────────────────────────────────────────────────
# `_is_safe_database_name` anchoring
# ─────────────────────────────────────────────────────────────────────


class TestSafeDatabaseName:
    def test_test_prefix_safe(self) -> None:
        assert _is_safe_database_name("test_orders")

    def test_test_suffix_safe(self) -> None:
        assert _is_safe_database_name("orders_test")

    def test_dev_prefix_safe(self) -> None:
        assert _is_safe_database_name("dev_app")

    def test_production_unsafe(self) -> None:
        # Real production DBs must not match.
        assert not _is_safe_database_name("production")
        assert not _is_safe_database_name("orders_prod")
        assert not _is_safe_database_name("customer_data")

    def test_substring_pattern_does_not_leak(self) -> None:
        # Pre-fix bug: `re.search(r"^mock", "mockingbird_prod")` matched
        # because `^mock` anchors at start of string and "mock" appears
        # at start. Anchoring fix should keep this unsafe... actually
        # `^mock.*` matches ANY string starting with mock, which is the
        # original intent. The real bug was for substring patterns like
        # `_test$` matching strings ending in `_test`. Verify both.
        assert _is_safe_database_name("mockingbird")  # starts with mock
        # Strings that merely CONTAIN "mock" mid-word should NOT match.
        assert not _is_safe_database_name("smockery_data")

    def test_empty_name(self) -> None:
        assert not _is_safe_database_name("")


# ─────────────────────────────────────────────────────────────────────
# psql validator surface checks
# ─────────────────────────────────────────────────────────────────────


class TestPsqlValidator:
    def test_drop_via_dash_c_rejected(self) -> None:
        ok, _ = validate_psql_command('psql -c "DROP TABLE users" mydb')
        assert not ok

    def test_delete_where_1_eq_1_via_dash_c_rejected(self) -> None:
        ok, _ = validate_psql_command('psql -c "DELETE FROM users WHERE 1=1" mydb')
        assert not ok

    def test_long_command_form_rejected(self) -> None:
        # Bug fix: `--command=` long form was missed pre-fix.
        ok, _ = validate_psql_command('psql --command="TRUNCATE TABLE sessions" mydb')
        assert not ok

    def test_dash_f_rejected(self) -> None:
        # `-f file.sql` cannot be statically scanned — must reject.
        ok, _ = validate_psql_command("psql -f /tmp/migrate.sql mydb")
        assert not ok

    def test_safe_select_allowed(self) -> None:
        ok, _ = validate_psql_command('psql -c "SELECT 1" mydb')
        assert ok


class TestDropdbValidator:
    def test_dropdb_test_db_allowed(self) -> None:
        ok, _ = validate_dropdb_command("dropdb test_orders")
        assert ok

    def test_dropdb_production_rejected(self) -> None:
        ok, _ = validate_dropdb_command("dropdb production")
        assert not ok

    def test_dropdb_with_host_flag(self) -> None:
        # Skip-next-token logic for `-h hostname`.
        ok, _ = validate_dropdb_command("dropdb -h db.example.com test_db")
        assert ok
