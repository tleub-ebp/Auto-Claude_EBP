"""Tests for the optional Fernet encryption-at-rest layer."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from audit_trail import AuditTrail
from audit_trail.encryption import (
    ENCRYPTION_PREFIX,
    FERNET_ENV_VAR,
    encryption_enabled,
    generate_fernet_key,
    maybe_decrypt_line,
    maybe_encrypt_line,
    reset_cipher_cache,
)


@pytest.fixture(autouse=True)
def _reset_cipher() -> None:
    # Each test starts with no cached cipher so env-var changes take effect.
    reset_cipher_cache()
    yield
    reset_cipher_cache()


@pytest.fixture
def fernet_key(monkeypatch: pytest.MonkeyPatch) -> str:
    key = generate_fernet_key()
    monkeypatch.setenv(FERNET_ENV_VAR, key)
    reset_cipher_cache()
    return key


# ---------------------------------------------------------------------------
# Cipher loader


class TestCipherLoader:
    def test_disabled_when_env_var_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(FERNET_ENV_VAR, raising=False)
        assert encryption_enabled() is False

    def test_enabled_when_env_var_set(self, fernet_key: str) -> None:
        assert encryption_enabled() is True

    def test_disabled_when_env_var_blank(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(FERNET_ENV_VAR, "   ")
        assert encryption_enabled() is False

    def test_disabled_when_env_var_invalid(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(FERNET_ENV_VAR, "definitely-not-a-fernet-key")
        assert encryption_enabled() is False


# ---------------------------------------------------------------------------
# Round-trip


class TestRoundTrip:
    def test_encrypt_then_decrypt_recovers_input(self, fernet_key: str) -> None:
        original = '{"hello":"world"}'
        wrapped = maybe_encrypt_line(original)
        assert wrapped.startswith(ENCRYPTION_PREFIX)
        assert maybe_decrypt_line(wrapped) == original

    def test_no_op_when_disabled(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(FERNET_ENV_VAR, raising=False)
        original = '{"hello":"world"}'
        # Without a key, encryption is a no-op AND decryption of cleartext
        # is also a no-op.
        assert maybe_encrypt_line(original) == original
        assert maybe_decrypt_line(original) == original

    def test_idempotent_on_already_encrypted_line(self, fernet_key: str) -> None:
        once = maybe_encrypt_line('{"x":1}')
        twice = maybe_encrypt_line(once)
        assert once == twice

    def test_decrypt_without_key_raises(
        self, monkeypatch: pytest.MonkeyPatch, fernet_key: str
    ) -> None:
        # Encrypt with a key, then drop the key and try to read.
        encrypted = maybe_encrypt_line('{"x":1}')
        monkeypatch.delenv(FERNET_ENV_VAR, raising=False)
        reset_cipher_cache()
        with pytest.raises(ValueError, match="not set"):
            maybe_decrypt_line(encrypted)


# ---------------------------------------------------------------------------
# Integration with AuditTrail (the whole point)


class TestAuditTrailWithEncryption:
    def test_events_round_trip_through_encrypted_storage(
        self, fernet_key: str, tmp_path: Path
    ) -> None:
        trail = AuditTrail(storage_dir=tmp_path, name="t1")
        trail.append(
            kind="agent_invoked",
            actor="planner",
            correlation_id="spec-1",
            summary="x",
            payload={"k": "v"},
        )
        trail.append(
            kind="agent_completed",
            actor="planner",
            correlation_id="spec-1",
            summary="y",
        )
        # Reopen from disk — must decode through encryption layer.
        trail2 = AuditTrail(storage_dir=tmp_path, name="t1")
        events = trail2.all()
        assert len(events) == 2
        assert events[0].summary == "x"
        assert events[1].summary == "y"

    def test_disk_lines_are_actually_encrypted(
        self, fernet_key: str, tmp_path: Path
    ) -> None:
        trail = AuditTrail(storage_dir=tmp_path, name="t1")
        trail.append(
            kind="agent_invoked",
            actor="planner",
            correlation_id="spec-1",
            summary="topsecret",
        )
        on_disk = trail.path.read_text(encoding="utf-8").strip()
        assert on_disk.startswith(ENCRYPTION_PREFIX)
        # Plaintext leaked into the file = security failure.
        assert "topsecret" not in on_disk
        assert "planner" not in on_disk

    def test_integrity_check_still_works_when_encrypted(
        self, fernet_key: str, tmp_path: Path
    ) -> None:
        trail = AuditTrail(storage_dir=tmp_path, name="t1")
        for i in range(3):
            trail.append("agent_invoked", "a", f"s-{i}", f"x{i}")
        report = trail.verify()
        assert report.is_intact is True
        assert report.events_checked == 3

    def test_tampering_detected_through_encrypted_layer(
        self, fernet_key: str, tmp_path: Path
    ) -> None:
        trail = AuditTrail(storage_dir=tmp_path, name="t1")
        for i in range(3):
            trail.append("agent_invoked", "a", f"s-{i}", f"x{i}")
        # Tamper: re-encrypt a forged event under the same key.
        from audit_trail.encryption import maybe_encrypt_line

        lines = trail.path.read_text(encoding="utf-8").splitlines()
        # Decrypt event #1, change its summary, re-encrypt without
        # recomputing the hash → must be flagged.
        decrypted = maybe_decrypt_line(lines[1])
        evil = json.loads(decrypted)
        evil["summary"] = "I changed my mind"
        re_encrypted = maybe_encrypt_line(json.dumps(evil, separators=(",", ":")))
        lines[1] = re_encrypted
        trail.path.write_text("\n".join(lines) + "\n", encoding="utf-8")

        trail2 = AuditTrail(storage_dir=tmp_path, name="t1")
        report = trail2.verify()
        assert report.is_intact is False
        assert report.first_broken_sequence == 1

    def test_can_read_legacy_cleartext_when_key_is_set(
        self, fernet_key: str, tmp_path: Path
    ) -> None:
        # Mixed-mode: some legacy cleartext lines + new encrypted lines.
        # Simulates a project that turned encryption on after some events.
        # 1. Write one event in cleartext mode.
        import os

        from audit_trail.encryption import reset_cipher_cache as _reset

        old_key = os.environ.pop(FERNET_ENV_VAR, None)
        _reset()
        try:
            trail = AuditTrail(storage_dir=tmp_path, name="t1")
            trail.append("agent_invoked", "a", "s-0", "first")
        finally:
            if old_key:
                os.environ[FERNET_ENV_VAR] = old_key
            _reset()

        # 2. Add a second event with encryption now on.
        trail2 = AuditTrail(storage_dir=tmp_path, name="t1")
        trail2.append("agent_invoked", "a", "s-1", "second")

        # On-disk: line 1 is plain JSON, line 2 starts with fernet:.
        lines = trail2.path.read_text(encoding="utf-8").strip().splitlines()
        assert not lines[0].startswith(ENCRYPTION_PREFIX)
        assert lines[1].startswith(ENCRYPTION_PREFIX)

        # Both events must be readable.
        trail3 = AuditTrail(storage_dir=tmp_path, name="t1")
        events = trail3.all()
        assert [e.summary for e in events] == ["first", "second"]


# ---------------------------------------------------------------------------
# Key generation helper


class TestGenerateFernetKey:
    def test_returns_valid_fernet_key(self) -> None:
        # The generated key must be loadable as a real Fernet cipher.
        from cryptography.fernet import Fernet

        key = generate_fernet_key()
        # Should not raise.
        Fernet(key.encode("ascii"))

    def test_keys_are_unique_per_call(self) -> None:
        # Sanity: don't ship a function that returns the same key twice.
        assert generate_fernet_key() != generate_fernet_key()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
