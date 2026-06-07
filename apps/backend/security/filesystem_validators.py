"""
File System Validators
=======================

Validators for file system operations (chmod, rm, init scripts).
"""

import re
import shlex

from .validation_models import ValidationResult

# Safe chmod modes
SAFE_CHMOD_MODES = {
    "+x",
    "a+x",
    "u+x",
    "g+x",
    "o+x",
    "ug+x",
    "755",
    "644",
    "700",
    "600",
    "775",
    "664",
}

# Dangerous rm patterns
DANGEROUS_RM_PATTERNS = [
    r"^/$",  # Root
    r"^\.\.$",  # Parent directory
    r"^~$",  # Home directory
    r"^\*$",  # Wildcard only
    r"^/\*$",  # Root wildcard
    r"^\.\./",  # Escaping current directory
    r"^/home$",  # /home
    r"^/usr$",  # /usr
    r"^/etc$",  # /etc
    r"^/var$",  # /var
    r"^/bin$",  # /bin
    r"^/lib$",  # /lib
    r"^/opt$",  # /opt
]


def validate_chmod_command(command_string: str) -> ValidationResult:
    """
    Validate chmod commands - only allow making files executable with +x.

    Args:
        command_string: The full chmod command string

    Returns:
        Tuple of (is_valid, error_message)
    """
    try:
        tokens = shlex.split(command_string)
    except ValueError:
        return False, "Could not parse chmod command"

    if not tokens or tokens[0] != "chmod":
        return False, "Not a chmod command"

    mode = None
    files = []
    skip_next = False

    for token in tokens[1:]:
        if skip_next:
            skip_next = False
            continue

        if token in ("-R", "--recursive"):
            # Allow recursive for +x
            continue
        elif token.startswith("-"):
            return False, f"chmod flag '{token}' is not allowed"
        elif mode is None:
            mode = token
        else:
            files.append(token)

    if mode is None:
        return False, "chmod requires a mode"

    if not files:
        return False, "chmod requires at least one file"

    # Only allow +x variants (making files executable)
    # Also allow common safe modes like 755, 644
    if mode not in SAFE_CHMOD_MODES and not re.match(r"^[ugoa]*\+x$", mode):
        return (
            False,
            f"chmod only allowed with executable modes (+x, 755, etc.), got: {mode}",
        )

    return True, ""


def validate_rm_command(command_string: str) -> ValidationResult:
    """
    Validate rm commands - prevent dangerous deletions.

    Policy: only relative paths under the current working directory may be
    deleted. Anything starting with `/`, `~`, `$`, `..`, a Windows drive
    letter, or containing wildcards near the root is rejected. The previous
    static-pattern allowlist let `rm -rf /home/user`, `rm -rf ~/.ssh`, and
    `rm -rf ./*` through.

    Args:
        command_string: The full rm command string

    Returns:
        Tuple of (is_valid, error_message)
    """
    try:
        tokens = shlex.split(command_string)
    except ValueError:
        return False, "Could not parse rm command"

    if not tokens:
        return False, "Empty rm command"

    saw_target = False
    for token in tokens[1:]:
        if token.startswith("-") and token != "--":
            # Allow -r, -f, -rf, -fr, -v, -i
            continue
        if token == "--":
            continue

        saw_target = True

        # Reject any path that escapes the current working directory or
        # references a system / home location.
        if not _is_safe_relative_target(token):
            return (
                False,
                (
                    f"rm target '{token}' is not allowed for safety: only "
                    "relative paths under the current working directory may "
                    "be removed (no '/', '~', '$', '..', wildcards near root, "
                    "or drive letters)."
                ),
            )

        # Legacy explicit blocklist as a second layer of defense.
        for pattern in DANGEROUS_RM_PATTERNS:
            if re.match(pattern, token):
                return False, f"rm target '{token}' is not allowed for safety"

    if not saw_target:
        return False, "rm requires at least one target"

    return True, ""


_WINDOWS_DRIVE_RE = re.compile(r"^[A-Za-z]:[\\/]")


def _is_safe_relative_target(token: str) -> bool:
    """Return True only for relative paths that stay under cwd."""
    if not token:
        return False
    # Absolute POSIX path or root-rooted glob
    if token.startswith("/"):
        return False
    # Home-relative
    if token.startswith("~"):
        return False
    # Env-var expansion (treated as opaque, may resolve to anywhere)
    if token.startswith("$") or "${" in token:
        return False
    # Windows drive-letter root (`C:\…`, `c:/…`)
    if _WINDOWS_DRIVE_RE.match(token):
        return False
    # Windows UNC path (`\\server\share`)
    if token.startswith("\\\\"):
        return False
    # Parent-directory escape, including `./..` and trailing `/..`.
    # We treat any path that contains a `..` segment as unsafe — even if it
    # ultimately resolves under cwd, it's almost never what an agent intends.
    parts = re.split(r"[\\/]+", token)
    if any(part == ".." for part in parts):
        return False
    # Bare wildcards / brace expansions adjacent to root-ish paths
    if token in {"*", ".", "./", ".\\"}:
        return False
    return True


def validate_init_script(command_string: str) -> ValidationResult:
    """
    Validate init.sh script execution - only allow ./init.sh.

    Args:
        command_string: The full init script command string

    Returns:
        Tuple of (is_valid, error_message)
    """
    try:
        tokens = shlex.split(command_string)
    except ValueError:
        return False, "Could not parse init script command"

    if not tokens:
        return False, "Empty command"

    script = tokens[0]

    # Allow only ./init.sh in the current working directory. Allowing any
    # path ending in `/init.sh` lets an agent stage `evil/init.sh` and
    # invoke it, defeating the validator.
    if script == "./init.sh":
        return True, ""

    return False, f"Only ./init.sh is allowed, got: {script}"
