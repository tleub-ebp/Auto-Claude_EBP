"""Audit Trail & Compliance Replay.

Append-only event log with hash chaining (a la Git/blockchain) so any
tampering is detectable. Captures every agent action (who, when, what,
why, what-was-the-input, what-was-the-output) and lets compliance
auditors replay any past decision.

Different from `compliance_collector/` which gathers evidence artefacts
for audit reports — this module is the **immutable source of truth** that
the collector (and anyone else) can consume.
"""

from .encryption import (
    FERNET_ENV_VAR,
    encryption_enabled,
    generate_fernet_key,
)
from .exports import (
    DSARBundle,
    build_dsar_bundle,
    export_gdpr_dsar,
    export_soc2_csv,
    render_soc2_csv,
)
from .trail import (
    AuditEvent,
    AuditEventKind,
    AuditTrail,
    Decision,
    IntegrityReport,
    ReplayBundle,
)

__all__ = [
    "FERNET_ENV_VAR",
    "AuditEvent",
    "AuditEventKind",
    "AuditTrail",
    "DSARBundle",
    "Decision",
    "IntegrityReport",
    "ReplayBundle",
    "build_dsar_bundle",
    "encryption_enabled",
    "export_gdpr_dsar",
    "export_soc2_csv",
    "generate_fernet_key",
    "render_soc2_csv",
]
