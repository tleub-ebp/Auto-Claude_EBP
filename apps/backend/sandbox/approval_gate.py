"""
Approval Gate — Human-in-the-loop for sandbox results.

After a dry-run, the user reviews the predicted diff and either
approves (apply to real working tree), rejects, or partially approves
specific files.

Not to be confused with ``core.governance.approval_gate``: that module
gates *policy-flagged* actions (persistent request queue, deny/approve
by approver), while this module tracks per-file approval of a sandbox
diff prediction and physically applies it to the working tree.
"""

from __future__ import annotations

import logging
import shutil
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from .diff_predictor import DiffPrediction

logger = logging.getLogger(__name__)


def _safe_join(root: Path, rel: str) -> Path:
    """Join `rel` onto `root` and refuse paths that escape the root.

    Refuses absolute paths, `..` traversal, and symlink targets that resolve
    outside `root`. `root` MUST already be resolved by the caller.
    """
    if not rel:
        raise ValueError("Empty path")
    rel_path = Path(rel)
    if rel_path.is_absolute():
        raise ValueError(f"Absolute path not allowed: {rel}")
    candidate = (root / rel_path).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError(f"Path escapes root {root}: {rel}")
    return candidate


class ApprovalDecision(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    PARTIAL = "partial"


@dataclass
class FileApproval:
    """Per-file approval decision."""

    path: str
    approved: bool = False
    comment: str = ""


@dataclass
class ApprovalRequest:
    """A request for the user to approve sandbox results."""

    id: str
    prediction: DiffPrediction
    decision: ApprovalDecision = ApprovalDecision.PENDING
    file_approvals: list[FileApproval] = field(default_factory=list)
    reviewer: str = ""
    created_at: float = field(default_factory=time.time)
    decided_at: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class ApprovalGate:
    """Manage user approval for sandbox dry-run results.

    Usage::

        gate = ApprovalGate()
        req = gate.create_request("run-001", prediction)
        # ... user reviews ...
        gate.approve(req)
        gate.apply(req, sandbox_root, target_root)
    """

    def __init__(self) -> None:
        self._requests: dict[str, ApprovalRequest] = {}

    def create_request(
        self,
        request_id: str,
        prediction: DiffPrediction,
    ) -> ApprovalRequest:
        """Create an approval request for a sandbox prediction."""
        req = ApprovalRequest(
            id=request_id,
            prediction=prediction,
            file_approvals=[FileApproval(path=f.path) for f in prediction.files],
        )
        self._requests[request_id] = req
        return req

    def approve(self, request: ApprovalRequest) -> None:
        """Mark the request as fully approved."""
        request.decision = ApprovalDecision.APPROVED
        request.decided_at = time.time()
        for fa in request.file_approvals:
            fa.approved = True
        logger.info("Approval request %s: APPROVED", request.id)

    def reject(self, request: ApprovalRequest, reason: str = "") -> None:
        """Reject the request."""
        request.decision = ApprovalDecision.REJECTED
        request.decided_at = time.time()
        for fa in request.file_approvals:
            fa.approved = False
            fa.comment = reason
        logger.info("Approval request %s: REJECTED (%s)", request.id, reason)

    def partial_approve(
        self, request: ApprovalRequest, approved_paths: set[str]
    ) -> None:
        """Approve only the specified file paths."""
        request.decision = ApprovalDecision.PARTIAL
        request.decided_at = time.time()
        for fa in request.file_approvals:
            fa.approved = fa.path in approved_paths
        count = sum(1 for fa in request.file_approvals if fa.approved)
        logger.info(
            "Approval request %s: PARTIAL (%d/%d files)",
            request.id,
            count,
            len(request.file_approvals),
        )

    def apply(
        self,
        request: ApprovalRequest,
        sandbox_root: Path,
        target_root: Path,
    ) -> list[str]:
        """Apply approved files from the sandbox to the real working tree.

        Returns the list of file paths that were applied.
        """
        if request.decision == ApprovalDecision.REJECTED:
            logger.warning("Cannot apply rejected request %s", request.id)
            return []

        if request.decision == ApprovalDecision.PENDING:
            logger.warning("Cannot apply pending request %s", request.id)
            return []

        sandbox_root_resolved = sandbox_root.resolve()
        target_root_resolved = target_root.resolve()

        applied: list[str] = []
        for fa in request.file_approvals:
            if not fa.approved:
                continue

            try:
                src = _safe_join(sandbox_root_resolved, fa.path)
                dst = _safe_join(target_root_resolved, fa.path)
            except ValueError as exc:
                # Path escapes the sandbox/target — refuse to apply.
                # This guards against malicious diff entries with `..` or
                # absolute paths that would let an approve click overwrite
                # arbitrary host files.
                logger.error(
                    "Refused to apply path %r in request %s: %s",
                    fa.path,
                    request.id,
                    exc,
                )
                continue

            if src.exists():
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                applied.append(fa.path)
            else:
                # File was deleted in sandbox
                if dst.exists():
                    dst.unlink()
                    applied.append(fa.path)

        logger.info(
            "Applied %d files from sandbox %s to %s",
            len(applied),
            sandbox_root,
            target_root,
        )
        return applied

    def get_request(self, request_id: str) -> ApprovalRequest | None:
        return self._requests.get(request_id)

    @property
    def pending_requests(self) -> list[ApprovalRequest]:
        return [
            r for r in self._requests.values() if r.decision == ApprovalDecision.PENDING
        ]
