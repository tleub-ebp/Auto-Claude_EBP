#!/usr/bin/env python3
"""
Compliance Analyzer Module
===========================

Analyzes code for compliance with various security and privacy standards:
- GDPR (General Data Protection Regulation)
- SOC 2 (System and Organization Controls)
- HIPAA (Health Insurance Portability and Accountability Act)
- PCI-DSS (Payment Card Industry Data Security Standard)
- ISO 27001
- CCPA (California Consumer Privacy Act)

This module provides:
1. Pattern detection for sensitive data handling
2. Compliance rule checking
3. Automated compliance reports
4. Remediation suggestions
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any


class ComplianceFramework(Enum):
    """Supported compliance frameworks."""

    GDPR = "GDPR"
    SOC2 = "SOC2"
    HIPAA = "HIPAA"
    PCI_DSS = "PCI-DSS"
    ISO_27001 = "ISO-27001"
    CCPA = "CCPA"


class ComplianceSeverity(Enum):
    """Severity of compliance violations."""

    CRITICAL = "critical"  # Regulatory violation
    HIGH = "high"  # Best practice violation
    MEDIUM = "medium"  # Recommendation
    LOW = "low"  # Informational


@dataclass
class ComplianceViolation:
    """Represents a compliance violation."""

    framework: ComplianceFramework
    rule_id: str
    severity: ComplianceSeverity
    title: str
    description: str
    file: str
    line: int | None = None
    remediation: str = ""
    references: list[str] = field(default_factory=list)
    detected_at: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "framework": self.framework.value,
            "rule_id": self.rule_id,
            "severity": self.severity.value,
            "title": self.title,
            "description": self.description,
            "file": self.file,
            "line": self.line,
            "remediation": self.remediation,
            "references": self.references,
            "detected_at": self.detected_at.isoformat(),
        }


@dataclass
class ComplianceReport:
    """Complete compliance analysis report."""

    project_path: Path
    frameworks: list[ComplianceFramework]
    violations: list[ComplianceViolation] = field(default_factory=list)
    scan_timestamp: datetime = field(default_factory=datetime.now)
    files_scanned: int = 0

    @property
    def critical_count(self) -> int:
        """Count of critical violations."""
        return sum(
            1 for v in self.violations if v.severity == ComplianceSeverity.CRITICAL
        )

    @property
    def high_count(self) -> int:
        """Count of high severity violations."""
        return sum(1 for v in self.violations if v.severity == ComplianceSeverity.HIGH)

    @property
    def is_compliant(self) -> bool:
        """Whether the project is compliant (no critical violations)."""
        return self.critical_count == 0

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "project_path": str(self.project_path),
            "frameworks": [f.value for f in self.frameworks],
            "violations": [v.to_dict() for v in self.violations],
            "scan_timestamp": self.scan_timestamp.isoformat(),
            "files_scanned": self.files_scanned,
            "summary": {
                "critical": self.critical_count,
                "high": self.high_count,
                "total": len(self.violations),
                "is_compliant": self.is_compliant,
            },
        }


class ComplianceAnalyzer:
    """
    Analyzes code for compliance with various security standards.

    This analyzer detects:
    - Personal data handling (GDPR, CCPA)
    - Healthcare data (HIPAA)
    - Payment card data (PCI-DSS)
    - Security controls (SOC2, ISO 27001)
    - Data retention and deletion
    - Encryption requirements
    - Audit logging requirements
    """

    # GDPR patterns
    PERSONAL_DATA_PATTERNS = [
        (r"\b(?:email|e-mail)\b.*?=", "Email address handling"),
        (r"\b(?:phone|telephone|mobile)\b.*?=", "Phone number handling"),
        (r"\baddress\b.*?=", "Physical address handling"),
        (r"\b(?:ssn|social.security)\b", "Social Security Number"),
        (r"\b(?:passport|driver.license)\b", "Government ID"),
        (r"\b(?:birthdate|birth.date|dob)\b", "Date of birth"),
        (r"\bip.address\b", "IP address tracking"),
        (r"\bcookie", "Cookie usage"),
        (r"\bgeolocation\b", "Geolocation tracking"),
    ]

    # HIPAA patterns
    HEALTH_DATA_PATTERNS = [
        (r"\b(?:patient|medical.record)\b", "Patient data"),
        (r"\b(?:diagnosis|treatment|prescription)\b", "Medical information"),
        (r"\b(?:health.insurance|insurance.number)\b", "Health insurance data"),
        (r"\bmedical.history\b", "Medical history"),
    ]

    # PCI-DSS patterns
    PAYMENT_DATA_PATTERNS = [
        (r"\b(?:credit.card|card.number|pan)\b", "Credit card data"),
        (r"\bcvv\b", "Card verification value"),
        (r"\b(?:card.holder|cardholder)\b", "Cardholder data"),
        (r"\b(?:payment|billing)\b.*?(?:info|data)", "Payment information"),
    ]

    # Security control patterns
    SECURITY_PATTERNS = [
        (r"(?:password|passwd|pwd)\s*=\s*['\"]", "Hardcoded password"),
        (r"TODO.*?security", "Security TODO item"),
        (r"FIXME.*?security", "Security FIXME item"),
        (r"eval\(", "Dangerous eval() usage"),
        (r"exec\(", "Dangerous exec() usage"),
        (r"pickle\.loads", "Unsafe deserialization"),
        (r"yaml\.load\(", "Unsafe YAML loading"),
    ]

    def __init__(self, project_path: Path | str):
        """
        Initialize compliance analyzer.

        Args:
            project_path: Path to the project to analyze
        """
        self.project_path = Path(project_path)

    def analyze(
        self, frameworks: list[ComplianceFramework] | None = None
    ) -> ComplianceReport:
        """
        Analyze project for compliance violations.

        Args:
            frameworks: List of frameworks to check (defaults to all)

        Returns:
            Compliance report
        """
        if frameworks is None:
            frameworks = list(ComplianceFramework)

        report = ComplianceReport(project_path=self.project_path, frameworks=frameworks)

        # Get all source files
        source_files = self._get_source_files()
        report.files_scanned = len(source_files)

        # Analyze each file
        for file_path in source_files:
            self._analyze_file(file_path, frameworks, report)

        # Check for missing security controls
        self._check_security_controls(frameworks, report)

        return report

    def _analyze_file(
        self,
        file_path: Path,
        frameworks: list[ComplianceFramework],
        report: ComplianceReport,
    ) -> None:
        """Analyze a single file for compliance issues."""
        try:
            content = file_path.read_text(encoding="utf-8", errors="ignore")
            lines = content.split("\n")

            # GDPR/CCPA - Personal data handling
            if (
                ComplianceFramework.GDPR in frameworks
                or ComplianceFramework.CCPA in frameworks
            ):
                self._check_personal_data(file_path, lines, report)

            # HIPAA - Health data
            if ComplianceFramework.HIPAA in frameworks:
                self._check_health_data(file_path, lines, report)

            # PCI-DSS - Payment data
            if ComplianceFramework.PCI_DSS in frameworks:
                self._check_payment_data(file_path, lines, report)

            # SOC2/ISO 27001 - Security controls
            if (
                ComplianceFramework.SOC2 in frameworks
                or ComplianceFramework.ISO_27001 in frameworks
            ):
                self._check_security_controls_in_file(file_path, lines, report)

        except Exception:
            # Skip files that can't be read
            pass

    def _check_personal_data(
        self, file_path: Path, lines: list[str], report: ComplianceReport
    ) -> None:
        """Check for GDPR/CCPA personal data handling issues."""
        for line_num, line in enumerate(lines, 1):
            for pattern, description in self.PERSONAL_DATA_PATTERNS:
                if re.search(pattern, line, re.IGNORECASE):
                    # Check if there's consent or purpose limitation
                    has_consent = any(
                        re.search(
                            r"\b(?:consent|permission|agree)\b", line, re.IGNORECASE
                        )
                        for line in lines[max(0, line_num - 5) : line_num + 5]
                    )

                    has_encryption = any(
                        re.search(r"\b(?:encrypt|hash|secure)\b", line, re.IGNORECASE)
                        for line in lines[max(0, line_num - 5) : line_num + 5]
                    )

                    if not has_consent:
                        report.violations.append(
                            ComplianceViolation(
                                framework=ComplianceFramework.GDPR,
                                rule_id="GDPR-ART6",
                                severity=ComplianceSeverity.HIGH,
                                title=f"Personal data without consent: {description}",
                                description=f"Found {description.lower()} without explicit consent mechanism",
                                file=str(file_path.relative_to(self.project_path)),
                                line=line_num,
                                remediation="Implement explicit user consent before collecting personal data (GDPR Article 6)",
                                references=[
                                    "https://gdpr-info.eu/art-6-gdpr/",
                                    "https://gdpr.eu/article-6-how-to-process-personal-data-legally/",
                                ],
                            )
                        )

                    if not has_encryption and "password" not in line.lower():
                        report.violations.append(
                            ComplianceViolation(
                                framework=ComplianceFramework.GDPR,
                                rule_id="GDPR-ART32",
                                severity=ComplianceSeverity.MEDIUM,
                                title=f"Unencrypted personal data: {description}",
                                description=f"Found {description.lower()} without encryption",
                                file=str(file_path.relative_to(self.project_path)),
                                line=line_num,
                                remediation="Implement encryption for personal data at rest and in transit (GDPR Article 32)",
                                references=["https://gdpr-info.eu/art-32-gdpr/"],
                            )
                        )

    def _check_health_data(
        self, file_path: Path, lines: list[str], report: ComplianceReport
    ) -> None:
        """Check for HIPAA health data handling issues."""
        for line_num, line in enumerate(lines, 1):
            for pattern, description in self.HEALTH_DATA_PATTERNS:
                if re.search(pattern, line, re.IGNORECASE):
                    # HIPAA requires encryption and access controls
                    has_encryption = any(
                        re.search(r"\b(?:encrypt|aes|rsa)\b", line, re.IGNORECASE)
                        for line in lines[max(0, line_num - 5) : line_num + 5]
                    )

                    has_access_control = any(
                        re.search(
                            r"\b(?:auth|permission|access.control|rbac)\b",
                            line,
                            re.IGNORECASE,
                        )
                        for line in lines[max(0, line_num - 5) : line_num + 5]
                    )

                    if not has_encryption:
                        report.violations.append(
                            ComplianceViolation(
                                framework=ComplianceFramework.HIPAA,
                                rule_id="HIPAA-164.312",
                                severity=ComplianceSeverity.CRITICAL,
                                title=f"Unencrypted PHI: {description}",
                                description=f"Protected Health Information ({description}) must be encrypted",
                                file=str(file_path.relative_to(self.project_path)),
                                line=line_num,
                                remediation="Implement HIPAA-compliant encryption (AES-256) for PHI",
                                references=[
                                    "https://www.hhs.gov/hipaa/for-professionals/security/index.html"
                                ],
                            )
                        )

                    if not has_access_control:
                        report.violations.append(
                            ComplianceViolation(
                                framework=ComplianceFramework.HIPAA,
                                rule_id="HIPAA-164.308",
                                severity=ComplianceSeverity.HIGH,
                                title="Missing access controls for PHI",
                                description="Protected Health Information requires role-based access controls",
                                file=str(file_path.relative_to(self.project_path)),
                                line=line_num,
                                remediation="Implement role-based access control (RBAC) for PHI access",
                                references=[
                                    "https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html"
                                ],
                            )
                        )

    def _check_payment_data(
        self, file_path: Path, lines: list[str], report: ComplianceReport
    ) -> None:
        """Check for PCI-DSS payment data handling issues."""
        for line_num, line in enumerate(lines, 1):
            for pattern, description in self.PAYMENT_DATA_PATTERNS:
                if re.search(pattern, line, re.IGNORECASE):
                    # PCI-DSS prohibits storing certain data
                    if "cvv" in line.lower() or "cvc" in line.lower():
                        report.violations.append(
                            ComplianceViolation(
                                framework=ComplianceFramework.PCI_DSS,
                                rule_id="PCI-DSS-3.2",
                                severity=ComplianceSeverity.CRITICAL,
                                title="Prohibited storage of CVV/CVC",
                                description="PCI-DSS strictly prohibits storing CVV/CVC data after authorization",
                                file=str(file_path.relative_to(self.project_path)),
                                line=line_num,
                                remediation="Remove all CVV/CVC storage. Use tokenization for card data.",
                                references=[
                                    "https://www.pcisecuritystandards.org/document_library"
                                ],
                            )
                        )

                    # Check for encryption
                    has_encryption = any(
                        re.search(
                            r"\b(?:encrypt|tokenize|vault)\b", line, re.IGNORECASE
                        )
                        for line in lines[max(0, line_num - 5) : line_num + 5]
                    )

                    if not has_encryption:
                        report.violations.append(
                            ComplianceViolation(
                                framework=ComplianceFramework.PCI_DSS,
                                rule_id="PCI-DSS-3.4",
                                severity=ComplianceSeverity.CRITICAL,
                                title=f"Unencrypted cardholder data: {description}",
                                description="All cardholder data must be encrypted or tokenized",
                                file=str(file_path.relative_to(self.project_path)),
                                line=line_num,
                                remediation="Use strong encryption (AES-256) or tokenization for all cardholder data",
                                references=[
                                    "https://www.pcisecuritystandards.org/pci_security/"
                                ],
                            )
                        )

    def _check_security_controls_in_file(
        self, file_path: Path, lines: list[str], report: ComplianceReport
    ) -> None:
        """Check for SOC2/ISO 27001 security control issues."""
        for line_num, line in enumerate(lines, 1):
            for pattern, description in self.SECURITY_PATTERNS:
                if re.search(pattern, line, re.IGNORECASE):
                    severity = ComplianceSeverity.CRITICAL
                    if "TODO" in line or "FIXME" in line:
                        severity = ComplianceSeverity.MEDIUM

                    report.violations.append(
                        ComplianceViolation(
                            framework=ComplianceFramework.SOC2,
                            rule_id="SOC2-CC6.1",
                            severity=severity,
                            title=f"Security control issue: {description}",
                            description=f"Found {description} which violates security best practices",
                            file=str(file_path.relative_to(self.project_path)),
                            line=line_num,
                            remediation=self._get_remediation_for_pattern(description),
                            references=[
                                "https://www.aicpa.org/interestareas/frc/assuranceadvisoryservices/sorhome.html"
                            ],
                        )
                    )

    def _check_security_controls(
        self, frameworks: list[ComplianceFramework], report: ComplianceReport
    ) -> None:
        """Check for missing security controls at project level."""
        # Check for audit logging
        has_logging = any(
            (self.project_path / f).exists()
            for f in ["logging.py", "audit.py", "logger.py"]
        )

        if not has_logging and ComplianceFramework.SOC2 in frameworks:
            report.violations.append(
                ComplianceViolation(
                    framework=ComplianceFramework.SOC2,
                    rule_id="SOC2-CC7.2",
                    severity=ComplianceSeverity.HIGH,
                    title="Missing audit logging",
                    description="No audit logging implementation found",
                    file="project-level",
                    remediation="Implement comprehensive audit logging for all security-relevant events",
                    references=[
                        "https://www.aicpa.org/interestareas/frc/assuranceadvisoryservices/sorhome.html"
                    ],
                )
            )

        # Check for authentication
        has_auth = any(
            (self.project_path / f).exists()
            for f in ["auth.py", "authentication.py", "security.py"]
        )

        if not has_auth and (
            ComplianceFramework.SOC2 in frameworks
            or ComplianceFramework.ISO_27001 in frameworks
        ):
            report.violations.append(
                ComplianceViolation(
                    framework=ComplianceFramework.SOC2,
                    rule_id="SOC2-CC6.1",
                    severity=ComplianceSeverity.HIGH,
                    title="Missing authentication module",
                    description="No authentication implementation found",
                    file="project-level",
                    remediation="Implement robust authentication and authorization",
                    references=["https://owasp.org/www-project-top-ten/"],
                )
            )

        # Check for encryption utilities
        has_crypto = any(
            (self.project_path / f).exists()
            for f in ["crypto.py", "encryption.py", "cipher.py"]
        )

        if not has_crypto and ComplianceFramework.GDPR in frameworks:
            report.violations.append(
                ComplianceViolation(
                    framework=ComplianceFramework.GDPR,
                    rule_id="GDPR-ART32",
                    severity=ComplianceSeverity.MEDIUM,
                    title="Missing encryption module",
                    description="No encryption utilities found for data protection",
                    file="project-level",
                    remediation="Implement encryption utilities for personal data protection",
                    references=["https://gdpr-info.eu/art-32-gdpr/"],
                )
            )

    def _get_source_files(self) -> list[Path]:
        """Get all source code files to analyze."""
        extensions = {".py", ".js", ".ts", ".java", ".go", ".rb", ".php", ".cs"}
        source_files = []

        for ext in extensions:
            source_files.extend(self.project_path.rglob(f"*{ext}"))

        # Filter out common ignore patterns
        ignore_patterns = {
            "node_modules",
            "venv",
            ".venv",
            "env",
            "__pycache__",
            ".git",
            "dist",
            "build",
            "target",
        }

        return [
            f
            for f in source_files
            if not any(pattern in f.parts for pattern in ignore_patterns)
        ]

    def _get_remediation_for_pattern(self, description: str) -> str:
        """Get remediation advice for a security pattern."""
        remediations = {
            "Hardcoded password": "Use environment variables or secret management service (e.g., AWS Secrets Manager, Azure Key Vault)",
            "Dangerous eval() usage": "Avoid eval(). Use safer alternatives like ast.literal_eval() or json.loads()",
            "Dangerous exec() usage": "Avoid exec(). Use safer alternatives or restrict to known safe inputs",
            "Unsafe deserialization": "Use pickle.loads() only with trusted data. Consider JSON for untrusted input",
            "Unsafe YAML loading": "Use yaml.safe_load() instead of yaml.load() to prevent arbitrary code execution",
        }

        return remediations.get(description, "Review and remediate this security issue")
