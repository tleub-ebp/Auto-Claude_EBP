"""
Approval Gate — Suspend agent actions that require human approval.

When a policy rule has ``action: require_approval``, the agent action is
parked until a designated approver grants or denies it.

The gate stores pending requests in-memory (with optional persistence via
JSON) and exposes a simple API for the frontend to list / approve / deny.

Not to be confused with ``sandbox.approval_gate``: that module reviews
sandbox dry-run diffs file-by-file and applies them to the working tree.
This module is purely a request queue for policy-gated actions.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class ApprovalStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"
    EXPIRED = "expired"


@dataclass
class ApprovalRequest:
    """A pending approval request for a policy-gated action."""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    rule_id: str = ""
    rule_description: str = ""
    action_summary: str = ""
    file_path: str | None = None
    approvers: list[str] = field(default_factory=list)
    status: ApprovalStatus = ApprovalStatus.PENDING
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    resolved_at: str | None = None
    resolved_by: str | None = None
    denial_reason: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["status"] = self.status.value
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ApprovalRequest:
        data = dict(data)
        data["status"] = ApprovalStatus(data.get("status", "pending"))
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


class ApprovalGate:
    """Manage approval requests for policy-gated agent actions.

    Usage::

        gate = ApprovalGate()
        req = gate.create_request(rule_id="dep-review", ...)
        # ... frontend shows the request ...
        gate.approve(req.id, approved_by="tech-lead")
        # or
        gate.deny(req.id, denied_by="tech-lead", reason="Not needed")
    """

    def __init__(self, persistence_path: Path | None = None) -> None:
        self._requests: dict[str, ApprovalRequest] = {}
        self._persistence_path = persistence_path
        if persistence_path and persistence_path.exists():
            self._load_from_disk()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def create_request(
        self,
        rule_id: str,
        rule_description: str = "",
        action_summary: str = "",
        file_path: str | None = None,
        approvers: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ApprovalRequest:
        """Create a new pending approval request."""
        req = ApprovalRequest(
            rule_id=rule_id,
            rule_description=rule_description,
            action_summary=action_summary,
            file_path=file_path,
            approvers=approvers or [],
            metadata=metadata or {},
        )
        self._requests[req.id] = req
        self._persist()
        logger.info("Approval request created: %s (rule=%s)", req.id, rule_id)
        return req

    def approve(self, request_id: str, approved_by: str = "") -> ApprovalRequest:
        """Approve a pending request."""
        req = self._get_or_raise(request_id)
        if req.status != ApprovalStatus.PENDING:
            raise ValueError(
                f"Request {request_id} is already {req.status.value}, cannot approve."
            )
        req.status = ApprovalStatus.APPROVED
        req.resolved_at = datetime.now(timezone.utc).isoformat()
        req.resolved_by = approved_by
        self._persist()
        logger.info("Approval request approved: %s by %s", request_id, approved_by)
        return req

    def deny(
        self, request_id: str, denied_by: str = "", reason: str = ""
    ) -> ApprovalRequest:
        """Deny a pending request."""
        req = self._get_or_raise(request_id)
        if req.status != ApprovalStatus.PENDING:
            raise ValueError(
                f"Request {request_id} is already {req.status.value}, cannot deny."
            )
        req.status = ApprovalStatus.DENIED
        req.resolved_at = datetime.now(timezone.utc).isoformat()
        req.resolved_by = denied_by
        req.denial_reason = reason
        self._persist()
        logger.info("Approval request denied: %s by %s", request_id, denied_by)
        return req

    def get_request(self, request_id: str) -> ApprovalRequest | None:
        return self._requests.get(request_id)

    def list_pending(self) -> list[ApprovalRequest]:
        """Return all pending requests."""
        return [
            r for r in self._requests.values() if r.status == ApprovalStatus.PENDING
        ]

    def list_all(self) -> list[ApprovalRequest]:
        return list(self._requests.values())

    def is_approved(self, request_id: str) -> bool:
        req = self._requests.get(request_id)
        return req is not None and req.status == ApprovalStatus.APPROVED

    def is_denied(self, request_id: str) -> bool:
        req = self._requests.get(request_id)
        return req is not None and req.status == ApprovalStatus.DENIED

    def clear_resolved(self) -> int:
        """Remove all resolved (approved/denied) requests. Return count removed."""
        to_remove = [
            rid
            for rid, r in self._requests.items()
            if r.status
            in (ApprovalStatus.APPROVED, ApprovalStatus.DENIED, ApprovalStatus.EXPIRED)
        ]
        for rid in to_remove:
            del self._requests[rid]
        self._persist()
        return len(to_remove)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _get_or_raise(self, request_id: str) -> ApprovalRequest:
        req = self._requests.get(request_id)
        if req is None:
            raise KeyError(f"Approval request '{request_id}' not found.")
        return req

    def _persist(self) -> None:
        if self._persistence_path is None:
            return
        try:
            data = [r.to_dict() for r in self._requests.values()]
            self._persistence_path.parent.mkdir(parents=True, exist_ok=True)
            self._persistence_path.write_text(
                json.dumps(data, indent=2), encoding="utf-8"
            )
        except Exception:
            logger.exception("Failed to persist approval requests")

    def _load_from_disk(self) -> None:
        if self._persistence_path is None or not self._persistence_path.exists():
            return
        try:
            raw = json.loads(self._persistence_path.read_text(encoding="utf-8"))
            for item in raw:
                req = ApprovalRequest.from_dict(item)
                self._requests[req.id] = req
            logger.info("Loaded %d approval requests from disk", len(self._requests))
        except Exception:
            logger.exception("Failed to load approval requests from disk")
