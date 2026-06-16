"""
Encoding Repair
===============

Repairs Unicode *replacement characters* (``U+FFFD`` ``�``) that get baked into
files when an encoding-unsafe edit mangles accented text.

Symptom (seen on Windows with UTF-8 ``.resx`` files): a valid byte sequence such
as ``é`` (UTF-8 ``C3 A9``) is decoded with ``errors="replace"`` somewhere in a
tool chain, turning it into ``�``, then written back. The character is then lost
— a plain ``�`` carries no information about the original letter.

We recover it from a **known-good base version** of the file (its content on the
branch the task started from, which still has the correct accents). The repair
is line-oriented and conservative: a corrupted line is only restored when it
matches *exactly one* base line where every ``�`` stands for a single character.
Lines with no unique base match are left untouched and reported, so genuinely
new corrupted content (which has no base source) is never silently mangled
further.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

REPLACEMENT_CHAR = "�"  # '�'


def has_replacement_chars(text: str) -> bool:
    """True if ``text`` contains at least one ``U+FFFD`` replacement char."""
    return REPLACEMENT_CHAR in text


def repair_line_from_base(corrupted_line: str, base_lines: list[str]) -> str | None:
    """
    Restore a single ``�``-corrupted line from the base lines.

    Each ``�`` is treated as exactly one unknown character (one mangled accent →
    one replacement char). The corrupted line is turned into a regex and matched
    against the base lines; the original is returned only when **exactly one**
    clean base line matches, so ambiguous cases are never guessed.

    Returns the restored line, or ``None`` if no unique clean match exists.
    """
    if REPLACEMENT_CHAR not in corrupted_line:
        return corrupted_line

    # Each '�' → '.' (any single char); everything else is matched literally.
    pattern = (
        "^"
        + ".".join(re.escape(part) for part in corrupted_line.split(REPLACEMENT_CHAR))
        + "$"
    )
    regex = re.compile(pattern)

    matches = [
        line
        for line in base_lines
        if REPLACEMENT_CHAR not in line and regex.match(line)
    ]
    unique = list(dict.fromkeys(matches))
    return unique[0] if len(unique) == 1 else None


def repair_text(current: str, base: str) -> tuple[str, list[str]]:
    """
    Repair every ``�``-corrupted line in ``current`` using ``base``.

    Returns ``(repaired_text, unrepaired_lines)``. ``unrepaired_lines`` lists the
    corrupted lines that could not be uniquely restored (e.g. agent-authored new
    content, for which there is no base source). Line endings are preserved.
    """
    if REPLACEMENT_CHAR not in current:
        return current, []

    base_lines = base.split("\n")
    repaired: list[str] = []
    unrepaired: list[str] = []

    for line in current.split("\n"):
        if REPLACEMENT_CHAR not in line:
            repaired.append(line)
            continue
        fixed = repair_line_from_base(line, base_lines)
        if fixed is not None:
            repaired.append(fixed)
        else:
            repaired.append(line)
            unrepaired.append(line)

    return "\n".join(repaired), unrepaired


def decode_preserving_bom(data: bytes) -> tuple[str, bool]:
    """
    Decode bytes as UTF-8, reporting whether a UTF-8 BOM was present.

    ``.resx`` and many .NET text files are UTF-8 *with* BOM; we must round-trip
    that BOM so the repaired file keeps its original byte signature.
    """
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8"), True
    return data.decode("utf-8"), False


def encode_preserving_bom(text: str, had_bom: bool) -> bytes:
    """Inverse of :func:`decode_preserving_bom`."""
    body = text.encode("utf-8")
    return b"\xef\xbb\xbf" + body if had_bom else body


def _git(args: list[str], cwd: Path) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", *args], cwd=str(cwd), capture_output=True, check=False
    )


def repair_worktree_changed_files(
    worktree_dir: str | Path,
    base_ref: str,
    *,
    commit: bool = True,
) -> dict[str, object]:
    """
    Scan the files a task changed in its worktree and repair any ``U+FFFD``
    corruption, restoring the original characters from the pristine base version.

    "Changed" is computed against the merge-base of ``base_ref`` and ``HEAD`` so
    only this task's edits are considered, and it covers committed *and*
    working-tree changes. UTF-8 BOMs are preserved. When ``commit`` is true and
    any file was repaired, the fixes are committed onto the worktree branch (so
    they reach the diff view and the eventual merge).

    Returns ``{"repaired": [paths], "unrepaired": {path: [lines]}, "base": ref}``.
    Never raises — encoding repair must not break the build pipeline.
    """
    worktree = Path(worktree_dir)
    result: dict[str, object] = {"repaired": [], "unrepaired": {}, "base": base_ref}
    repaired_files: list[str] = []
    unrepaired: dict[str, list[str]] = {}

    try:
        merge_base = subprocess.run(
            ["git", "merge-base", base_ref, "HEAD"],
            cwd=str(worktree),
            capture_output=True,
            text=True,
            check=False,
        )
        base = (
            merge_base.stdout.strip()
            if merge_base.returncode == 0 and merge_base.stdout.strip()
            else base_ref
        )
        result["base"] = base

        diff = subprocess.run(
            ["git", "diff", "--name-only", base],
            cwd=str(worktree),
            capture_output=True,
            text=True,
            check=False,
        )
        if diff.returncode != 0:
            result["error"] = diff.stderr.strip()
            return result

        for rel in (line for line in diff.stdout.splitlines() if line.strip()):
            fpath = worktree / rel
            if not fpath.is_file():
                continue
            try:
                data = fpath.read_bytes()
            except OSError:
                continue
            try:
                text, _ = decode_preserving_bom(data)
            except UnicodeDecodeError:
                continue  # binary / non-UTF-8: leave it alone
            if REPLACEMENT_CHAR not in text:
                continue

            show = _git(["show", f"{base}:{rel}"], worktree)
            if show.returncode != 0:
                # No base version (file added this task): cannot recover.
                unrepaired[rel] = ["<no base version to restore from>"]
                continue
            try:
                base_text, base_had_bom = decode_preserving_bom(show.stdout)
            except UnicodeDecodeError:
                continue

            fixed, bad = repair_text(text, base_text)
            # Restore the file toward its pristine encoding: repaired text AND the
            # base BOM (an edit that mangles accents often also drops the UTF-8
            # BOM .resx/.NET files carry, which would otherwise show as a diff).
            new_bytes = encode_preserving_bom(fixed, base_had_bom)
            if new_bytes != data:
                try:
                    fpath.write_bytes(new_bytes)
                    repaired_files.append(rel)
                except OSError:
                    continue
            if bad:
                unrepaired[rel] = bad

        if commit and repaired_files:
            _git(["add", "--", *repaired_files], worktree)
            _git(
                [
                    "commit",
                    "-m",
                    "fix(encoding): restore non-ASCII characters mangled during edit",
                ],
                worktree,
            )
    except Exception as exc:  # noqa: BLE001 - never break the pipeline
        result["error"] = str(exc)

    result["repaired"] = repaired_files
    result["unrepaired"] = unrepaired
    return result
