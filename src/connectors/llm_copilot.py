"""
GitHub Copilot Usage Connector

Fournit l'accès aux métriques d'utilisation de GitHub Copilot via l'API REST GitHub.
Nécessite une authentification via GitHub CLI (gh) ou token GitHub avec les permissions appropriées.
"""

import ipaddress
import json
import logging
import socket
import subprocess
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


def _is_safe_report_url(url: str) -> bool:
    """Validate a Copilot signed-report URL against SSRF.

    Reject any URL whose scheme isn't https, or whose host resolves to a
    private/loopback/link-local address (cloud metadata, RFC1918, etc.).
    """
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    if parsed.scheme != "https":
        return False
    host = parsed.hostname
    if not host:
        return False
    try:
        # getaddrinfo returns a list of (family, type, proto, canon, sockaddr).
        for info in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(info[4][0])
            if (
                ip.is_private
                or ip.is_loopback
                or ip.is_link_local
                or ip.is_multicast
                or ip.is_reserved
                or ip.is_unspecified
            ):
                return False
    except (socket.gaierror, ValueError):
        return False
    return True

# GitHub CLI permission scope required for Copilot usage metrics
ADMIN_ORG_PERMISSION = "admin:org"


class CopilotUsageConnector:
    """
    Connecteur pour récupérer les métriques d'utilisation GitHub Copilot.
    
    Ce connecteur utilise l'API REST GitHub pour récupérer les données d'utilisation
    Copilot au niveau de l'organisation ou de l'entreprise.
    """

    def __init__(self, gh_token: str | None = None):
        """
        Initialise le connecteur Copilot.
        
        Args:
            gh_token: Token GitHub d'authentification (optionnel, utilise gh CLI si non fourni)
        """
        self.gh_token = gh_token
        self.gh_executable = self._find_gh_executable()

    def _find_gh_executable(self) -> str:
        """Trouve l'exécutable GitHub CLI (cross-platform via shutil.which)."""
        import shutil

        resolved = shutil.which("gh")
        return resolved or "gh"

    def _run_gh_command(self, args: list[str], timeout: int = 15) -> subprocess.CompletedProcess:
        """
        Exécute une commande gh CLI avec authentification.
        
        Args:
            args: Arguments de la commande gh
            timeout: Timeout en secondes
            
        Returns:
            Résultat de la commande subprocess
            
        Raises:
            RuntimeError: Si la commande échoue
        """
        cmd = [self.gh_executable] + args
        
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=True
            )
            return result
        except subprocess.CalledProcessError as e:
            error_msg = f"Command failed: {' '.join(cmd)}\n"
            error_msg += f"Exit code: {e.returncode}\n"
            error_msg += f"stderr: {e.stderr}\n"
            error_msg += f"stdout: {e.stdout}"
            logger.error(error_msg)
            raise RuntimeError(error_msg)
        except subprocess.TimeoutExpired:
            error_msg = f"Command timed out after {timeout}s: {' '.join(cmd)}"
            logger.error(error_msg)
            raise RuntimeError(error_msg) from None
        except FileNotFoundError as e:
            error_msg = "GitHub CLI (gh) not found. Install from https://cli.github.com/"
            logger.error(error_msg)
            raise RuntimeError(error_msg)

    def _get_authenticated_user(self) -> str:
        """
        Récupère le nom d'utilisateur GitHub authentifié.
        
        Returns:
            Nom d'utilisateur GitHub
            
        Raises:
            RuntimeError: Si non authentifié
        """
        try:
            result = self._run_gh_command(["api", "user", "--jq", ".login"])
            return result.stdout.strip()
        except RuntimeError as e:
            if "not logged in" in str(e).lower():
                raise RuntimeError("GitHub CLI not authenticated. Run 'gh auth login'")
            raise

    def get_copilot_enterprise_usage(self) -> dict[str, Any]:
        """
        Récupère les métriques d'utilisation Copilot au niveau de l'entreprise.
        
        Returns:
            Dictionnaire contenant les métriques d'utilisation
            
        Raises:
            RuntimeError: Si la récupération échoue
        """
        try:
            # Vérifier l'authentification
            username = self._get_authenticated_user()
            logger.info(f"Authenticated as GitHub user: {username}")

            # Récupérer les entreprises de l'utilisateur
            enterprises_result = self._run_gh_command([
                "api",
                "user/enterprises",
                "--jq", ".[].slug"
            ])
            
            if enterprises_result.returncode != 0:
                raise RuntimeError("Failed to fetch user enterprises")
                
            enterprises = [line.strip() for line in enterprises_result.stdout.strip().split('\n') if line.strip()]
            
            if not enterprises:
                raise RuntimeError("No enterprises found for user")
            
            # Pour chaque entreprise, essayer de récupérer les métriques du jour précédent
            from datetime import date, timedelta
            yesterday = (date.today() - timedelta(days=1)).strftime("%Y-%m-%d")
            
            for enterprise in enterprises:
                try:
                    # Utiliser le bon endpoint pour les métriques d'entreprise
                    usage_result = self._run_gh_command([
                        "api",
                        f"/enterprises/{enterprise}/copilot/metrics/reports/enterprise-1-day",
                        "--method", "GET",
                        "-f", f"day={yesterday}"
                    ])
                    
                    if usage_result.returncode == 0 and usage_result.stdout.strip():
                        usage_data = json.loads(usage_result.stdout)
                        
                        # Les données retournées contiennent des liens de téléchargement
                        if "download_links" in usage_data and usage_data["download_links"]:
                            # Télécharger le premier rapport
                            report_url = usage_data["download_links"][0]
                            report_data = self._download_report(report_url)
                            return self._format_usage_data(report_data, "enterprise", enterprise)
                        else:
                            logger.warning(f"No download links found for enterprise {enterprise}")
                            continue
                        
                except RuntimeError as e:
                    logger.debug(f"No Copilot data for enterprise {enterprise}: {e}")
                    continue
            
            raise RuntimeError("No Copilot usage data found for any enterprise")
            
        except RuntimeError as e:
            logger.warning(f"Failed to get enterprise usage: {e}")
            # Fallback sur les métriques d'organisation
            return self.get_copilot_organization_usage()

    def _download_report(self, report_url: str) -> dict[str, Any]:
        """
        Télécharge et analyse un rapport Copilot depuis une URL signée.
        
        Args:
            report_url: URL signée pour télécharger le rapport
            
        Returns:
            Données du rapport analysées
            
        Raises:
            RuntimeError: Si le téléchargement échoue
        """
        if not _is_safe_report_url(report_url):
            # Refuse anything that isn't an https URL pointing at a public
            # IP. Guards against signed-URL spoofing pointing at cloud
            # metadata (169.254.169.254), localhost, RFC1918, file://, etc.
            raise RuntimeError("Refused unsafe report URL (SSRF guard)")

        try:
            import requests
            # allow_redirects=False so a 30x to an internal host can't bypass
            # the validation we just did above.
            response = requests.get(report_url, timeout=30, allow_redirects=False)
            response.raise_for_status()

            # Le rapport est généralement un fichier JSON
            if report_url.endswith('.json'):
                return response.json()
            else:
                # Pour les autres formats, essayer de parser comme JSON
                return json.loads(response.text)

        except Exception as e:
            logger.error(f"Failed to download report from {report_url}: {e}")
            raise RuntimeError(f"Failed to download report: {e}")

    def _fetch_single_organization_usage(self, org: str, yesterday: str) -> dict[str, Any] | None:
        """
        Fetch usage data for a single organization.
        
        Args:
            org: Organization name
            yesterday: Date string for yesterday in YYYY-MM-DD format
            
        Returns:
            Formatted usage data if successful, None otherwise
        """
        usage_result = self._run_gh_command([
            "api",
            f"/orgs/{org}/copilot/metrics/reports/organization-1-day",
            "--method", "GET",
            "-f", f"day={yesterday}"
        ])
        
        if usage_result.returncode == 0 and usage_result.stdout.strip():
            usage_data = json.loads(usage_result.stdout)
            
            if "download_links" in usage_data and usage_data["download_links"]:
                report_url = usage_data["download_links"][0]
                report_data = self._download_report(report_url)
                formatted_data = self._format_usage_data(report_data, "organization", org)
                logger.info(f"Successfully retrieved Copilot usage for organization: {org}")
                return formatted_data
            else:
                logger.warning(f"No download links found for organization {org}")
        
        return None

    def _categorize_organization_error(self, error: RuntimeError) -> str:
        """
        Categorize an organization fetch error.
        
        Args:
            error: The RuntimeError to categorize
            
        Returns:
            Error category: "permission", "not_found", or "other"
        """
        error_msg = str(error).lower()
        if "insufficient permissions" in error_msg or ADMIN_ORG_PERMISSION in error_msg:
            return "permission"
        elif "not found" in error_msg or "404" in error_msg:
            return "not_found"
        return "other"

    def get_copilot_organization_usage(self) -> dict[str, Any]:
        """
        Récupère les métriques d'utilisation Copilot au niveau de l'organisation.
        
        Returns:
            Dictionnaire contenant les métriques d'utilisation
            
        Raises:
            RuntimeError: Si la récupération échoue
        """
        try:
            orgs_result = self._run_gh_command([
                "api",
                "user/orgs",
                "--jq", ".[].login"
            ])
            
            if orgs_result.returncode != 0:
                raise RuntimeError("Failed to fetch user organizations")
                
            organizations = [line.strip() for line in orgs_result.stdout.strip().split('\n') if line.strip()]
            
            if not organizations:
                raise RuntimeError("No organizations found for user")
            
            from datetime import date, timedelta
            yesterday = (date.today() - timedelta(days=1)).strftime("%Y-%m-%d")
            
            permission_errors = []
            not_found_errors = []
            
            for org in organizations:
                try:
                    usage_data = self._fetch_single_organization_usage(org, yesterday)
                    if usage_data:
                        return usage_data
                except RuntimeError as e:
                    error_category = self._categorize_organization_error(e)
                    if error_category == "permission":
                        permission_errors.append(str(e))
                    elif error_category == "not_found":
                        not_found_errors.append(str(e))
                    else:
                        logger.debug(f"No Copilot data for organization {org}: {e}")
                    continue
            
            self._raise_organization_errors(permission_errors, not_found_errors)
            
        except RuntimeError as e:
            logger.error(f"Failed to get organization usage: {e}")
            raise

    def _raise_organization_errors(self, permission_errors: list[str], not_found_errors: list[str]) -> None:
        """
        Raise appropriate error based on collected organization errors.
        
        Args:
            permission_errors: List of permission-related error messages
            not_found_errors: List of not-found error messages
            
        Raises:
            RuntimeError: With appropriate error message
        """
        if permission_errors:
            raise RuntimeError(f"Insufficient permissions: {permission_errors[0]}")
        elif not_found_errors:
            raise RuntimeError("No Copilot usage data found for any organization")
        else:
            raise RuntimeError("No Copilot usage data found for any organization")

    def get_copilot_personal_quotas(self) -> dict[str, Any]:
        """
        Récupère les quotas Copilot personnels de l'utilisateur connecté.

        Utilise l'endpoint non-public `/copilot_internal/user` que la UI
        github.com appelle pour afficher la jauge "Premium requests" et le
        plan Copilot du compte. Ne nécessite pas `admin:org`, contrairement
        aux endpoints `/orgs/.../copilot/metrics`.

        Returns:
            Dict avec premium_interactions / chat / completions snapshots,
            plan, organisation, et date de reset du quota.

        Raises:
            RuntimeError: Si l'utilisateur n'a pas de siège Copilot ou si
            l'endpoint est indisponible.
        """
        result = self._run_gh_command(["api", "/copilot_internal/user"])
        data = json.loads(result.stdout)

        quotas = data.get("quota_snapshots", {}) or {}
        premium = quotas.get("premium_interactions") or {}
        chat = quotas.get("chat") or {}
        completions = quotas.get("completions") or {}

        premium_entitlement = premium.get("entitlement", 0) or 0
        premium_remaining = premium.get("remaining", 0) or 0
        premium_pct_remaining = premium.get("percent_remaining")
        premium_used = max(premium_entitlement - premium_remaining, 0)
        premium_pct_used = (
            round(100.0 - float(premium_pct_remaining), 2)
            if premium_pct_remaining is not None
            else 0.0
        )

        orgs = data.get("organization_list") or []
        org_name = None
        if orgs and isinstance(orgs, list):
            first_org = orgs[0]
            if isinstance(first_org, dict):
                org_name = first_org.get("name") or first_org.get("login")

        return {
            "provider": "copilot",
            "level": "user",
            "scope": "personal-quotas",
            "available": True,
            "plan": data.get("copilot_plan"),
            "login": data.get("login"),
            "organization": org_name,
            "premium_requests": {
                "used": premium_used,
                "entitlement": premium_entitlement,
                "remaining": premium_remaining,
                "percent_used": premium_pct_used,
                "percent_remaining": premium_pct_remaining,
                "overage_count": premium.get("overage_count", 0),
                "overage_permitted": premium.get("overage_permitted", False),
                "unlimited": premium.get("unlimited", False),
            },
            "chat": {
                "unlimited": chat.get("unlimited", False),
                "percent_remaining": chat.get("percent_remaining"),
                "remaining": chat.get("remaining"),
                "entitlement": chat.get("entitlement"),
            },
            "completions": {
                "unlimited": completions.get("unlimited", False),
                "percent_remaining": completions.get("percent_remaining"),
                "remaining": completions.get("remaining"),
                "entitlement": completions.get("entitlement"),
            },
            "quota_reset_date": data.get("quota_reset_date")
            or data.get("quota_reset_date_utc"),
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }

    def get_copilot_usage_summary(self) -> dict[str, Any]:
        """
        Récupère un résumé des métriques d'utilisation Copilot.

        Stratégie:
        1. `/copilot_internal/user` (quotas personnels: premium requests).
           Endpoint utilisé par la UI github.com — pas de droits admin requis.
        2. Fallback `enterprise` / `organization` metrics (suggestions /
           acceptances agrégées) si l'utilisateur a `admin:org`.

        Returns:
            Dictionnaire contenant le résumé des métriques
        """
        try:
            return self.get_copilot_personal_quotas()
        except RuntimeError as e:
            logger.info(f"Personal Copilot quotas unavailable, falling back: {e}")

        enterprise_error = None
        organization_error = None

        try:
            # Essayer les métriques d'entreprise (admin-only)
            return self.get_copilot_enterprise_usage()
        except RuntimeError as e:
            enterprise_error = e

        try:
            # Fallback sur les métriques d'organisation (admin-only)
            return self.get_copilot_organization_usage()
        except RuntimeError as e:
            organization_error = e
        
        # Si tout échoue, vérifier si c'est un problème de permissions
        all_errors = [str(enterprise_error or ""), str(organization_error or "")]
        combined_error_msg = " ".join(all_errors).lower()
        
        if ("insufficient permissions" in combined_error_msg or ADMIN_ORG_PERMISSION in combined_error_msg):
            return {
                "error": "INSUFFICIENT_PERMISSIONS",
                "message": "Permissions insuffisantes pour accéder aux métriques Copilot. Cette fonctionnalité nécessite des permissions d'administrateur d'organisation ou d'entreprise.",
                "suggestions": [
                    f"Exécutez: gh auth refresh -h github.com -s {ADMIN_ORG_PERMISSION}",
                    "Assurez-vous d'être administrateur de l'organisation Copilot",
                    "Contactez votre administrateur GitHub pour obtenir les permissions nécessaires"
                ],
                "provider": "copilot",
                "available": False,
                "permission_required": ADMIN_ORG_PERMISSION
            }
        else:
            logger.error(
                "Unable to retrieve Copilot usage metrics via enterprise and organization endpoints",
                exc_info=(organization_error or enterprise_error),
            )
            return {
                "error": "COPILOT_USAGE_UNAVAILABLE",
                "message": "Unable to retrieve Copilot usage metrics. Please ensure you have the necessary permissions and Copilot is enabled for your organization/enterprise.",
                "suggestions": [
                    "Verify GitHub CLI authentication: gh auth status",
                    "Ensure Copilot is enabled for your organization",
                    "Check you have 'View Enterprise Copilot Metrics' permission",
                    "For enterprise metrics: ensure you're an enterprise owner or billing manager"
                ],
                "provider": "copilot",
                "available": False
            }

    def _format_usage_data(self, raw_data: dict[str, Any], level: str, org_name: str = None) -> dict[str, Any]:
        """
        Formate les données brutes d'utilisation en un format standardisé.
        
        Args:
            raw_data: Données brutes de l'API GitHub
            level: Niveau des données ("enterprise" ou "organization")
            org_name: Nom de l'organisation (si applicable)
            
        Returns:
            Données formatées
        """
        # Extraire les métriques clés
        total_suggestions = 0
        total_acceptances = 0
        total_lines_suggested = 0
        total_lines_accepted = 0
        
        # Les données peuvent venir dans différents formats selon l'endpoint
        if "usage" in raw_data:
            usage_metrics = raw_data["usage"]
        elif "data" in raw_data:
            usage_metrics = raw_data["data"]
        else:
            usage_metrics = raw_data
        
        # Agréger les métriques
        if isinstance(usage_metrics, list):
            for metric in usage_metrics:
                if isinstance(metric, dict):
                    total_suggestions += metric.get("total_suggestions", 0)
                    total_acceptances += metric.get("total_acceptances", 0)
                    total_lines_suggested += metric.get("total_lines_suggested", 0)
                    total_lines_accepted += metric.get("total_lines_accepted", 0)
        elif isinstance(usage_metrics, dict):
            total_suggestions = usage_metrics.get("total_suggestions", 0)
            total_acceptances = usage_metrics.get("total_acceptances", 0)
            total_lines_suggested = usage_metrics.get("total_lines_suggested", 0)
            total_lines_accepted = usage_metrics.get("total_lines_accepted", 0)
        
        # Calculer les taux d'acceptation
        acceptance_rate = (total_acceptances / total_suggestions * 100) if total_suggestions > 0 else 0
        line_acceptance_rate = (total_lines_accepted / total_lines_suggested * 100) if total_lines_suggested > 0 else 0
        
        return {
            "provider": "copilot",
            "level": level,
            "organization": org_name,
            "total_suggestions": total_suggestions,
            "total_acceptances": total_acceptances,
            "total_lines_suggested": total_lines_suggested,
            "total_lines_accepted": total_lines_accepted,
            "acceptance_rate_percent": round(acceptance_rate, 2),
            "line_acceptance_rate_percent": round(line_acceptance_rate, 2),
            "total_tokens": total_suggestions + total_acceptances,  # Approximation
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "raw_data": raw_data  # Conserver les données brutes pour le débogage
        }


def get_copilot_usage_metrics() -> dict[str, Any]:
    """
    Point d'entrée principal pour récupérer les métriques d'utilisation Copilot.
    
    Returns:
        Métriques d'utilisation Copilot formatées
    """
    try:
        connector = CopilotUsageConnector()
        return connector.get_copilot_usage_summary()
    except Exception:
        logger.exception("Failed to get Copilot usage metrics")
        return {
            "error": "COPILOT_USAGE_RETRIEVAL_FAILED",
            "message": "Unable to retrieve Copilot usage metrics at this time.",
            "provider": "copilot",
            "available": False
        }
