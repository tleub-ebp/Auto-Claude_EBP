#!/usr/bin/env python3
"""
Intent Recognition Data Models
==============================

Data structures for intent recognition and analysis.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from implementation_plan import WorkflowType


class IntentCategory(str, Enum):
    """Granular intent categories beyond workflow types."""

    # Feature Development
    NEW_FEATURE = "new_feature"
    ENHANCEMENT = "enhancement"
    API_DESIGN = "api_design"
    UI_UX = "ui_ux"

    # Fixes & Maintenance
    BUG_FIX = "bug_fix"
    HOTFIX = "hotfix"
    SECURITY_FIX = "security_fix"

    # Quality & Performance
    REFACTORING = "refactoring"
    PERFORMANCE = "performance"
    CODE_QUALITY = "code_quality"

    # Infrastructure & Operations
    INFRASTRUCTURE = "infrastructure"
    DEPLOYMENT = "deployment"
    MONITORING = "monitoring"

    # Research & Analysis
    INVESTIGATION = "investigation"
    SPIKE = "spike"
    RESEARCH = "research"

    # Data & Migration
    DATA_MIGRATION = "data_migration"
    SCHEMA_CHANGE = "schema_change"

    # Documentation & Testing
    DOCUMENTATION = "documentation"
    TESTING = "testing"

    # Unknown
    UNCLEAR = "unclear"


class IntentConfidence(str, Enum):
    """Confidence level in intent detection."""

    VERY_HIGH = "very_high"  # 90-100%
    HIGH = "high"  # 75-89%
    MEDIUM = "medium"  # 50-74%
    LOW = "low"  # 25-49%
    VERY_LOW = "very_low"  # 0-24%


@dataclass
class Intent:
    """Detected intent with confidence and reasoning."""

    category: IntentCategory
    workflow_type: WorkflowType
    confidence_score: float  # 0.0 to 1.0
    confidence_level: IntentConfidence
    reasoning: str
    keywords_found: list[str] = field(default_factory=list)
    context_clues: list[str] = field(default_factory=list)


@dataclass
class IntentAnalysis:
    """Complete intent analysis with alternatives and metadata."""

    primary_intent: Intent
    alternative_intents: list[Intent] = field(default_factory=list)
    task_description: str = ""
    analyzed_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    model_used: str = "claude-3-5-sonnet-20241022"
    requires_clarification: bool = False
    clarification_questions: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "primary_intent": {
                "category": self.primary_intent.category.value,
                "workflow_type": self.primary_intent.workflow_type.value,
                "confidence_score": self.primary_intent.confidence_score,
                "confidence_level": self.primary_intent.confidence_level.value,
                "reasoning": self.primary_intent.reasoning,
                "keywords_found": self.primary_intent.keywords_found,
                "context_clues": self.primary_intent.context_clues,
            },
            "alternative_intents": [
                {
                    "category": alt.category.value,
                    "workflow_type": alt.workflow_type.value,
                    "confidence_score": alt.confidence_score,
                    "confidence_level": alt.confidence_level.value,
                    "reasoning": alt.reasoning,
                }
                for alt in self.alternative_intents
            ],
            "task_description": self.task_description,
            "analyzed_at": self.analyzed_at,
            "model_used": self.model_used,
            "requires_clarification": self.requires_clarification,
            "clarification_questions": self.clarification_questions,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> IntentAnalysis:
        """Create from dictionary."""
        primary = data["primary_intent"]
        primary_intent = Intent(
            category=IntentCategory(primary["category"]),
            workflow_type=WorkflowType(primary["workflow_type"]),
            confidence_score=primary["confidence_score"],
            confidence_level=IntentConfidence(primary["confidence_level"]),
            reasoning=primary["reasoning"],
            keywords_found=primary.get("keywords_found", []),
            context_clues=primary.get("context_clues", []),
        )

        alternatives = []
        for alt_data in data.get("alternative_intents", []):
            alt = Intent(
                category=IntentCategory(alt_data["category"]),
                workflow_type=WorkflowType(alt_data["workflow_type"]),
                confidence_score=alt_data["confidence_score"],
                confidence_level=IntentConfidence(alt_data["confidence_level"]),
                reasoning=alt_data["reasoning"],
            )
            alternatives.append(alt)

        return cls(
            primary_intent=primary_intent,
            alternative_intents=alternatives,
            task_description=data.get("task_description", ""),
            analyzed_at=data.get("analyzed_at", ""),
            model_used=data.get("model_used", "claude-3-5-sonnet-20241022"),
            requires_clarification=data.get("requires_clarification", False),
            clarification_questions=data.get("clarification_questions", []),
        )
