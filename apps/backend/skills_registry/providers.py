"""What each LLM provider can do, read from capabilities/providers.yaml.

Used at client-creation time to answer two questions honestly:

* Does this provider run subagents? If not, passing an ``agents`` dict is
  dead weight — the workflow should run its phases sequentially with a context
  reset instead of pretending to dispatch them in parallel.
* Does this provider have an agentic adapter at all? Five of them do not, and
  selecting one silently ran the task on Claude. The degradation still happens
  (writing five adapters is a separate piece of work) but it is now stated in
  the task feed rather than buried in a log line.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import yaml

logger = logging.getLogger(__name__)

__all__ = ["ProviderCapabilities", "load_providers", "get_provider_capabilities"]

PROVIDERS_RELPATH = Path("capabilities") / "providers.yaml"

# capabilities/ sits at the repo root, two levels above apps/backend/.
_REPO_ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class ProviderCapabilities:
    name: str
    adapter: str | None
    subagents: str
    effort: str
    degrades_to: str | None
    note: str = ""

    @property
    def supports_subagents(self) -> bool:
        return self.subagents == "native"

    @property
    def has_adapter(self) -> bool:
        return bool(self.adapter)


_UNKNOWN = ProviderCapabilities(
    name="unknown",
    adapter=None,
    subagents="none",
    effort="none",
    degrades_to="claude",
    note="Not listed in capabilities/providers.yaml.",
)


def load_providers(repo_root: Path | None = None) -> dict[str, ProviderCapabilities]:
    path = (repo_root or _REPO_ROOT) / PROVIDERS_RELPATH
    if not path.is_file():
        logger.warning("provider capability matrix not found at %s", path)
        return {}
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    out: dict[str, ProviderCapabilities] = {}
    for name, cfg in raw.items():
        cfg = cfg or {}
        out[name] = ProviderCapabilities(
            name=name,
            adapter=cfg.get("adapter"),
            subagents=str(cfg.get("subagents", "none")),
            effort=str(cfg.get("effort", "none")),
            degrades_to=cfg.get("degrades_to"),
            note=str(cfg.get("note", "") or ""),
        )
    return out


@lru_cache(maxsize=1)
def _cached() -> dict[str, ProviderCapabilities]:
    return load_providers()


def get_provider_capabilities(provider: str) -> ProviderCapabilities:
    """Capabilities for ``provider``.

    An unlisted provider gets the conservative answer — no subagents, no
    adapter — rather than an optimistic default. Assuming capability a provider
    does not have fails at run time in a confusing way; assuming the opposite
    only costs some parallelism.
    """
    caps = _cached().get(provider)
    if caps is None:
        logger.debug("provider %r not in the capability matrix", provider)
        return ProviderCapabilities(
            name=provider,
            adapter=_UNKNOWN.adapter,
            subagents=_UNKNOWN.subagents,
            effort=_UNKNOWN.effort,
            degrades_to=_UNKNOWN.degrades_to,
            note=_UNKNOWN.note,
        )
    return caps
