"""Tests for the deterministic helpers in core.auth.

Out of scope (intentionally): the OS-keychain readers
(``_get_token_from_macos_keychain``, ``_get_token_from_linux_secret_service``,
``_get_token_from_windows_credential_files``) and the OAuth login triggers
(``trigger_login`` / ``ensure_authenticated``). Those depend on the host
environment and are exercised by manual / integration QA.

What we cover here are the pure routines: keychain service-name derivation,
encrypted-token detection + format validation, the ``_try_decrypt_token``
fallback path, the env-var resolver order in ``get_auth_token``, and the
SDK env-var snapshot.
"""

from __future__ import annotations

import os

import pytest
from core.auth import (
    AUTH_TOKEN_ENV_VARS,
    SDK_ENV_VARS,
    _calculate_config_dir_hash,
    _get_keychain_service_name,
    _token_presence,
    _try_decrypt_token,
    decrypt_token,
    get_auth_token,
    get_sdk_env_vars,
    is_encrypted_token,
    validate_token_not_encrypted,
)

# ---------------------------------------------------------------------------
# _token_presence — must NEVER leak token content into logs


class TestTokenPresence:
    def test_absent_for_none(self) -> None:
        assert _token_presence(None) == "absent"

    def test_absent_for_empty_string(self) -> None:
        assert _token_presence("") == "absent"

    def test_present_with_length_for_real_token(self) -> None:
        assert _token_presence("sk-ant-secret") == "present(len=13)"

    def test_does_not_include_token_bytes(self) -> None:
        # Defence in depth: even a fragment of the token must not appear.
        secret = "sk-ant-AbCdEf1234567890zzzzzzzzzz"
        out = _token_presence(secret)
        assert "AbCdEf" not in out
        assert "1234" not in out
        assert "sk-" not in out


# ---------------------------------------------------------------------------
# Keychain service name derivation


class TestKeychainServiceName:
    def test_no_config_dir_returns_legacy_name(self) -> None:
        assert _get_keychain_service_name(None) == "Claude Code-credentials"
        assert _get_keychain_service_name("") == "Claude Code-credentials"

    def test_config_dir_appends_hash_suffix(self) -> None:
        name = _get_keychain_service_name("/Users/x/.claude/profile-1")
        assert name.startswith("Claude Code-credentials-")
        # The hash is the SHA-256 prefix (8 hex chars).
        suffix = name.removeprefix("Claude Code-credentials-")
        assert len(suffix) == 8
        assert all(c in "0123456789abcdef" for c in suffix)

    def test_same_config_dir_yields_same_hash(self) -> None:
        a = _get_keychain_service_name("/foo/bar")
        b = _get_keychain_service_name("/foo/bar")
        assert a == b

    def test_tilde_expansion_is_applied(self) -> None:
        # ~/path and the explicit home/path must hash identically — must
        # match the frontend's normalisation in credential-utils.ts.
        home = os.path.expanduser("~")
        a = _get_keychain_service_name("~/x")
        b = _get_keychain_service_name(f"{home}/x")
        assert a == b


class TestCalculateConfigDirHash:
    def test_returns_eight_hex_chars(self) -> None:
        h = _calculate_config_dir_hash("/some/path")
        assert len(h) == 8
        assert all(c in "0123456789abcdef" for c in h)

    def test_distinct_paths_distinct_hashes(self) -> None:
        assert _calculate_config_dir_hash("/a") != _calculate_config_dir_hash("/b")


# ---------------------------------------------------------------------------
# Encrypted token detection


class TestIsEncryptedToken:
    @pytest.mark.parametrize("tok", [None, "", "sk-ant-plain"])
    def test_negative_cases(self, tok) -> None:
        assert is_encrypted_token(tok) is False

    def test_recognises_enc_prefix(self) -> None:
        assert is_encrypted_token("enc:abcdef1234567890") is True


class TestValidateTokenNotEncrypted:
    def test_passes_silently_for_plaintext(self) -> None:
        validate_token_not_encrypted("sk-ant-real-token")  # no exception

    def test_raises_for_encrypted(self) -> None:
        with pytest.raises(ValueError, match="encrypted format"):
            validate_token_not_encrypted("enc:wrapped")


class TestDecryptToken:
    def test_rejects_non_string(self) -> None:
        with pytest.raises(ValueError, match="Invalid token type"):
            decrypt_token(123)  # type: ignore[arg-type]

    def test_rejects_missing_prefix(self) -> None:
        with pytest.raises(ValueError, match="enc:"):
            decrypt_token("plaintext-no-prefix")

    def test_rejects_empty_payload(self) -> None:
        with pytest.raises(ValueError, match="Empty"):
            decrypt_token("enc:")

    def test_rejects_too_short_payload(self) -> None:
        with pytest.raises(ValueError, match="too short"):
            decrypt_token("enc:short")


# ---------------------------------------------------------------------------
# _try_decrypt_token (the centralised fallback)


class TestTryDecryptToken:
    def test_returns_none_for_none(self) -> None:
        assert _try_decrypt_token(None) is None

    def test_returns_none_for_empty_string(self) -> None:
        assert _try_decrypt_token("") is None

    def test_returns_plaintext_unchanged(self) -> None:
        assert _try_decrypt_token("sk-ant-real") == "sk-ant-real"

    def test_returns_encrypted_unchanged_when_decryption_fails(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Force decrypt_token to raise — _try_decrypt_token must catch the
        # ValueError and return the original encrypted token so downstream
        # validation can produce a precise error message.
        from core import auth as auth_mod

        def boom(_token: str) -> str:
            raise ValueError("simulated platform decryption failure")

        monkeypatch.setattr(auth_mod, "decrypt_token", boom)
        original = "enc:something_long_enough_to_not_be_rejected_outright"
        assert _try_decrypt_token(original) == original

    def test_returns_decrypted_when_decryption_succeeds(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from core import auth as auth_mod

        monkeypatch.setattr(auth_mod, "decrypt_token", lambda _t: "sk-ant-decrypted")
        assert _try_decrypt_token("enc:wrapped") == "sk-ant-decrypted"


# ---------------------------------------------------------------------------
# get_auth_token — env-var resolution order


class TestGetAuthTokenEnvVarOrder:
    @pytest.fixture(autouse=True)
    def _clear_auth_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Make sure the test never inherits a real token from the dev env.
        for var in AUTH_TOKEN_ENV_VARS:
            monkeypatch.delenv(var, raising=False)
        monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)

    def test_oauth_var_takes_precedence(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Force keychain lookup to return None so env-var resolution is the
        # only source of truth.
        from core import auth as auth_mod

        monkeypatch.setattr(auth_mod, "get_token_from_keychain", lambda *_a, **_k: None)
        monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "from-oauth")
        monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "from-anthropic")
        assert get_auth_token() == "from-oauth"

    def test_falls_back_to_anthropic_auth_token(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from core import auth as auth_mod

        monkeypatch.setattr(auth_mod, "get_token_from_keychain", lambda *_a, **_k: None)
        monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "ccr-token")
        assert get_auth_token() == "ccr-token"

    def test_does_not_consult_anthropic_api_key(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # ANTHROPIC_API_KEY is intentionally NOT in AUTH_TOKEN_ENV_VARS to
        # prevent silent billing — confirm the resolver still ignores it.
        from core import auth as auth_mod

        monkeypatch.setattr(auth_mod, "get_token_from_keychain", lambda *_a, **_k: None)
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-billable")
        assert get_auth_token() is None

    def test_returns_none_when_nothing_set(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from core import auth as auth_mod

        monkeypatch.setattr(auth_mod, "get_token_from_keychain", lambda *_a, **_k: None)
        assert get_auth_token() is None


# ---------------------------------------------------------------------------
# get_sdk_env_vars


class TestGetSdkEnvVars:
    @pytest.fixture(autouse=True)
    def _clear_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for var in SDK_ENV_VARS:
            monkeypatch.delenv(var, raising=False)

    def test_empty_env_yields_empty_pythonpath_only(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Even with nothing set, PYTHONPATH must be present + empty (ACS-251).
        # On Windows the function may also auto-detect git-bash; we only
        # assert the contract on PYTHONPATH to keep the test cross-platform.
        env = get_sdk_env_vars()
        assert env.get("PYTHONPATH") == ""

    def test_only_passes_through_non_empty_vars(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://x")
        monkeypatch.setenv("DISABLE_TELEMETRY", "")  # empty → must be skipped
        env = get_sdk_env_vars()
        assert env.get("ANTHROPIC_BASE_URL") == "https://x"
        assert "DISABLE_TELEMETRY" not in env

    def test_anthropic_api_key_never_leaked(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # ANTHROPIC_API_KEY is intentionally absent from SDK_ENV_VARS — make
        # sure get_sdk_env_vars never ships it to the agent subprocess.
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-billable")
        env = get_sdk_env_vars()
        assert "ANTHROPIC_API_KEY" not in env


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
