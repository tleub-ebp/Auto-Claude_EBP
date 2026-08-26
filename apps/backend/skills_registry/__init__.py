"""Skills registry — one parser, one resolver, one source of truth.

See docs/skills.md for the architecture. This package deliberately owns the
*reading* side of skills; writing the materialised outputs is the job of
scripts/skills-cli.js.
"""

from .frontmatter import parse_frontmatter, split_frontmatter, workpilot_meta

__all__ = ["parse_frontmatter", "split_frontmatter", "workpilot_meta"]
