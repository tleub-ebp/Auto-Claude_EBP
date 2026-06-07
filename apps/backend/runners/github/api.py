"""GitHub-related HTTP endpoints.

Extracted from provider_api.py. Mounted via app.include_router(router).
"""

from __future__ import annotations

from typing import Annotated
from urllib.parse import urlparse

from fastapi import APIRouter, Query

try:
    from provider_api import _safe_error_message
except ImportError:
    from apps.backend.provider_api import _safe_error_message  # type: ignore[no-redef]

router = APIRouter()


@router.get("/api/github/pr-details")
def get_pr_details(pr_url: Annotated[str, Query(...)]):
    """Get PR details (files, diffs, metadata) from GitHub."""
    try:
        from runners.github.providers.github_provider import GitHubProvider

        # Expected: https://github.com/<owner>/<repo>/pull/<number>
        # urlparse handles the schema correctly so we don't index into a
        # mangled split of the full URL (the old inline parsing had a
        # latent off-by-two bug from splitting "https://..." by "/").
        parsed = urlparse(pr_url)
        if parsed.netloc != "github.com":
            return {"success": False, "error": "Invalid GitHub PR URL format"}

        path_parts = [p for p in parsed.path.split("/") if p]
        # path_parts == ["<owner>", "<repo>", "pull", "<number>"]
        if len(path_parts) < 4 or path_parts[2] != "pull":
            return {"success": False, "error": "Invalid GitHub PR URL format"}

        owner, repo, _, pr_number = path_parts[:4]
        if not pr_number.isdigit():
            return {"success": False, "error": "Invalid GitHub PR URL format"}

        provider = GitHubProvider()
        pr_data = provider.fetch_pr(owner, repo, int(pr_number))

        if not pr_data:
            return {"success": False, "error": "Failed to fetch PR data"}

        return {
            "success": True,
            "data": {
                "number": pr_data.number,
                "title": pr_data.title,
                "body": pr_data.body,
                "state": pr_data.state,
                "author": pr_data.author,
                "createdAt": pr_data.created_at,
                "updatedAt": pr_data.updated_at,
                "url": pr_data.url,
                "baseBranch": pr_data.base_branch,
                "headBranch": pr_data.head_branch,
                "mergeable": pr_data.mergeable,
                "additions": pr_data.additions,
                "deletions": pr_data.deletions,
                "changedFiles": pr_data.changed_files,
                "files": pr_data.files,
                "diff": pr_data.diff,
            },
        }
    except Exception as e:
        return {"success": False, "error": _safe_error_message(e)}
