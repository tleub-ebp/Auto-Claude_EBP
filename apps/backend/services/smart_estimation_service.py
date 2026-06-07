"""
Smart Estimation Service

Analyzes build history to provide complexity scores for new tasks.
Uses historical data to estimate relative complexity similar to story points.
"""

import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# Add the apps/backend directory to the Python path
backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from analytics.database import get_db
from analytics.database_schema import (
    Build,
    BuildPhase,
    BuildStatus,
    QAResult,
)
from core.model_info import get_current_model_info
from sqlalchemy import desc


@dataclass
class TaskComplexityFactors:
    """Factors that influence task complexity"""

    estimated_files_impacted: int
    codebase_coverage_percentage: float
    similar_tasks_history: list[dict[str, Any]]
    risk_factors: list[str]
    complexity_indicators: list[str]


@dataclass
class EstimationResult:
    """Result of smart estimation analysis"""

    complexity_score: int  # 1-13 scale (similar to story points)
    confidence_level: float  # 0.0-1.0
    reasoning: list[str]
    similar_tasks: list[dict[str, Any]]
    risk_factors: list[str]
    estimated_duration_hours: float | None
    estimated_qa_iterations: float | None
    token_cost_estimate: float | None
    recommendations: list[str]


class SmartEstimationService:
    """
    Service for providing intelligent task estimations based on build history.
    """

    def __init__(self):
        self.model_info = get_current_model_info()

    def analyze_task_description(
        self, task_description: str, project_path: str
    ) -> EstimationResult:
        """
        Analyze a task description and provide complexity estimation.

        Args:
            task_description: Natural language description of the task
            project_path: Path to the project directory

        Returns:
            EstimationResult with complexity score and supporting analysis
        """
        # Extract complexity factors from the task description
        factors = self._extract_complexity_factors(task_description, project_path)

        # Find similar historical tasks
        similar_tasks = self._find_similar_tasks(task_description, factors)

        # Calculate complexity score
        complexity_score = self._calculate_complexity_score(factors, similar_tasks)

        # Calculate confidence level
        confidence = self._calculate_confidence_level(similar_tasks, factors)

        # Generate reasoning
        reasoning = self._generate_reasoning(factors, similar_tasks, complexity_score)

        # Estimate metrics based on similar tasks
        duration_estimate = self._estimate_duration(similar_tasks, complexity_score)
        qa_iterations_estimate = self._estimate_qa_iterations(
            similar_tasks, complexity_score
        )
        cost_estimate = self._estimate_token_cost(similar_tasks, complexity_score)

        # Generate recommendations
        recommendations = self._generate_recommendations(
            factors, complexity_score, similar_tasks
        )

        return EstimationResult(
            complexity_score=complexity_score,
            confidence_level=confidence,
            reasoning=reasoning,
            similar_tasks=similar_tasks[:5],  # Top 5 similar tasks
            risk_factors=factors.risk_factors,
            estimated_duration_hours=duration_estimate,
            estimated_qa_iterations=qa_iterations_estimate,
            token_cost_estimate=cost_estimate,
            recommendations=recommendations,
        )

    def _extract_complexity_factors(
        self, task_description: str, project_path: str
    ) -> TaskComplexityFactors:
        """Extract complexity factors from task description and project analysis"""

        # Count estimated files impacted
        file_patterns = self._extract_file_patterns(task_description)
        estimated_files = len(file_patterns) + self._count_implicit_files(
            task_description
        )

        # Calculate codebase coverage (simplified)
        coverage_percentage = min(
            100.0, (estimated_files / 10.0) * 100
        )  # Assume 10 files = full coverage

        # Identify risk factors
        risk_factors = self._identify_risk_factors(task_description)

        # Identify complexity indicators
        complexity_indicators = self._identify_complexity_indicators(task_description)

        return TaskComplexityFactors(
            estimated_files_impacted=estimated_files,
            codebase_coverage_percentage=coverage_percentage,
            similar_tasks_history=[],  # Will be filled by _find_similar_tasks
            risk_factors=risk_factors,
            complexity_indicators=complexity_indicators,
        )

    def _extract_file_patterns(self, description: str) -> list[str]:
        """Extract file patterns mentioned in the task description"""
        patterns = []

        # Common file extensions and patterns
        file_keywords = [
            "component",
            "service",
            "controller",
            "model",
            "view",
            "template",
            "config",
            "module",
            "library",
            "api",
            "endpoint",
            "route",
            "database",
            "migration",
            "seed",
            "test",
            "spec",
            "css",
            "scss",
            "html",
            "js",
            "ts",
            "tsx",
            "jsx",
            "py",
            "java",
            "cpp",
            "c",
            "go",
            "rust",
            "php",
        ]

        words = description.lower().split()
        for word in words:
            for keyword in file_keywords:
                if keyword in word:
                    patterns.append(word)
                    break

        return list(set(patterns))

    def _count_implicit_files(self, description: str) -> int:
        """Count files implicitly mentioned (e.g., 'add login page' implies multiple files)"""
        implicit_count = 0

        # UI-related tasks usually involve multiple files
        ui_indicators = ["page", "component", "view", "screen", "ui", "interface"]
        if any(indicator in description.lower() for indicator in ui_indicators):
            implicit_count += 2  # Component + styles + tests

        # API-related tasks
        api_indicators = ["api", "endpoint", "route", "service"]
        if any(indicator in description.lower() for indicator in api_indicators):
            implicit_count += 2  # Service + tests

        # Database tasks
        db_indicators = ["database", "migration", "model", "schema"]
        if any(indicator in description.lower() for indicator in db_indicators):
            implicit_count += 2  # Migration + model

        return implicit_count

    def _identify_risk_factors(self, description: str) -> list[str]:
        """Identify potential risk factors in the task"""
        risks = []
        desc_lower = description.lower()

        # High-risk keywords
        high_risk_patterns = [
            ("refactor", "Major refactoring can introduce unexpected issues"),
            ("migration", "Data migration risks and potential downtime"),
            (
                "performance",
                "Performance optimizations can have unintended side effects",
            ),
            ("security", "Security changes require careful testing"),
            ("authentication", "Auth changes affect core functionality"),
            ("database", "Database changes are high risk and hard to rollback"),
            ("production", "Production-facing changes require extensive testing"),
            ("breaking", "Breaking changes affect multiple systems"),
            ("dependency", "Dependency updates can introduce conflicts"),
            ("infrastructure", "Infrastructure changes have broad impact"),
        ]

        for pattern, reason in high_risk_patterns:
            if pattern in desc_lower:
                risks.append(reason)

        return risks

    def _identify_complexity_indicators(self, description: str) -> list[str]:
        """Identify indicators that suggest higher complexity"""
        indicators = []
        desc_lower = description.lower()

        # Complexity indicators
        complexity_patterns = [
            ("integration", "Requires integration with existing systems"),
            ("multiple", "Involves multiple components or systems"),
            ("real-time", "Real-time features add complexity"),
            ("async", "Asynchronous operations are harder to test"),
            ("scalable", "Scalability requirements add architectural complexity"),
            ("optimize", "Optimization requires deep understanding"),
            ("algorithm", "Algorithm development is inherently complex"),
            ("distributed", "Distributed systems add communication complexity"),
            ("cache", "Caching strategies require careful invalidation"),
            ("queue", "Queue systems add operational complexity"),
        ]

        for pattern, reason in complexity_patterns:
            if pattern in desc_lower:
                indicators.append(reason)

        return indicators

    def _find_similar_tasks(
        self, task_description: str, factors: TaskComplexityFactors
    ) -> list[dict[str, Any]]:
        """Find similar tasks in build history"""
        db = next(get_db())
        try:
            # Get recent builds with their specs
            recent_builds = (
                db.query(Build)
                .filter(
                    Build.started_at
                    >= datetime.now(timezone.utc).replace(tzinfo=None)
                    - timedelta(days=90)
                )
                .order_by(desc(Build.started_at))
                .limit(50)
                .all()
            )

            similar_tasks = []
            desc_lower = task_description.lower()

            for build in recent_builds:
                # Simple similarity matching based on spec name and keywords
                similarity_score = self._calculate_text_similarity(
                    desc_lower, (build.spec_name or "").lower()
                )

                if similarity_score > 0.2:  # Threshold for similarity
                    # Get build metrics
                    phases = (
                        db.query(BuildPhase)
                        .filter(BuildPhase.build_id == build.build_id)
                        .all()
                    )
                    qa_results = (
                        db.query(QAResult)
                        .filter(QAResult.build_id == build.build_id)
                        .all()
                    )

                    task_data = {
                        "build_id": build.build_id,
                        "spec_name": build.spec_name,
                        "similarity_score": similarity_score,
                        "complexity_score": self._infer_complexity_from_metrics(
                            build, phases, qa_results
                        ),
                        "duration_hours": build.total_duration_seconds / 3600
                        if build.total_duration_seconds
                        else None,
                        "qa_iterations": build.qa_iterations,
                        "success_rate": build.qa_success_rate,
                        "tokens_used": build.total_tokens_used,
                        "cost_usd": build.total_cost_usd,
                        "status": build.status,
                    }
                    similar_tasks.append(task_data)

            # Sort by similarity score
            similar_tasks.sort(key=lambda x: x["similarity_score"], reverse=True)
            return similar_tasks

        finally:
            db.close()

    def _calculate_text_similarity(self, text1: str, text2: str) -> float:
        """Calculate simple text similarity using keyword overlap"""
        words1 = set(text1.split())
        words2 = set(text2.split())

        if not words1 or not words2:
            return 0.0

        intersection = words1.intersection(words2)
        union = words1.union(words2)

        return len(intersection) / len(union)

    def _infer_complexity_from_metrics(
        self, build: Build, phases: list[BuildPhase], qa_results: list[QAResult]
    ) -> int:
        """Infer complexity score from build metrics"""
        score = 1  # Base score

        # Duration factor
        if build.total_duration_seconds:
            duration_hours = build.total_duration_seconds / 3600
            if duration_hours > 4:
                score += 3
            elif duration_hours > 2:
                score += 2
            elif duration_hours > 1:
                score += 1

        # QA iterations factor
        if build.qa_iterations and build.qa_iterations > 2:
            score += min(2, build.qa_iterations - 1)

        # Token usage factor
        if build.total_tokens_used:
            if build.total_tokens_used > 10000:
                score += 2
            elif build.total_tokens_used > 5000:
                score += 1

        # Error factor
        error_count = len([phase for phase in phases if not phase.success])
        if error_count > 0:
            score += min(2, error_count)

        return min(13, score)  # Cap at 13

    def _calculate_complexity_score(
        self, factors: TaskComplexityFactors, similar_tasks: list[dict[str, Any]]
    ) -> int:
        """Calculate final complexity score (1-13 scale)"""
        base_score = 1

        # Files impacted factor
        if factors.estimated_files_impacted > 10:
            base_score += 4
        elif factors.estimated_files_impacted > 5:
            base_score += 3
        elif factors.estimated_files_impacted > 3:
            base_score += 2
        elif factors.estimated_files_impacted > 1:
            base_score += 1

        # Risk factors factor
        base_score += min(3, len(factors.risk_factors))

        # Complexity indicators factor
        base_score += min(2, len(factors.complexity_indicators))

        # Similar tasks adjustment
        if similar_tasks:
            avg_complexity = sum(
                task["complexity_score"] for task in similar_tasks[:5]
            ) / min(5, len(similar_tasks))
            # Weight the average: 70% historical, 30% current analysis
            base_score = int((base_score * 0.3) + (avg_complexity * 0.7))

        return max(1, min(13, base_score))

    def _calculate_confidence_level(
        self, similar_tasks: list[dict[str, Any]], factors: TaskComplexityFactors
    ) -> float:
        """Calculate confidence level in the estimation"""
        confidence = 0.3  # Base confidence

        # More similar tasks = higher confidence
        if len(similar_tasks) >= 5:
            confidence += 0.4
        elif len(similar_tasks) >= 3:
            confidence += 0.3
        elif len(similar_tasks) >= 1:
            confidence += 0.2

        # High similarity scores increase confidence
        if similar_tasks:
            avg_similarity = sum(
                task["similarity_score"] for task in similar_tasks[:3]
            ) / min(3, len(similar_tasks))
            confidence += avg_similarity * 0.3

        return min(1.0, confidence)

    def _generate_reasoning(
        self,
        factors: TaskComplexityFactors,
        similar_tasks: list[dict[str, Any]],
        score: int,
    ) -> list[str]:
        """Generate reasoning for the complexity score"""
        reasoning = []

        # Files reasoning
        if factors.estimated_files_impacted > 5:
            reasoning.append(
                f"High file impact ({factors.estimated_files_impacted} files) suggests significant changes"
            )
        elif factors.estimated_files_impacted > 1:
            reasoning.append(
                f"Moderate file impact ({factors.estimated_files_impacted} files)"
            )

        # Risk reasoning
        if factors.risk_factors:
            reasoning.append(
                f"Identified {len(factors.risk_factors)} risk factors that increase complexity"
            )

        # Historical reasoning
        if similar_tasks:
            avg_score = sum(
                task["complexity_score"] for task in similar_tasks[:5]
            ) / min(5, len(similar_tasks))
            reasoning.append(
                f"Similar tasks historically score {avg_score:.1f} on average"
            )

        # Score categorization
        if score <= 3:
            reasoning.append("Task appears to be relatively straightforward")
        elif score <= 7:
            reasoning.append("Task has moderate complexity with several components")
        elif score <= 10:
            reasoning.append("Task is complex with multiple integration points")
        else:
            reasoning.append("Task is highly complex with significant risks")

        return reasoning

    def _estimate_duration(
        self, similar_tasks: list[dict[str, Any]], complexity_score: int
    ) -> float | None:
        """Estimate task duration based on similar tasks and complexity"""
        if similar_tasks:
            # Use weighted average of similar tasks
            durations = [
                task["duration_hours"]
                for task in similar_tasks[:5]
                if task["duration_hours"]
            ]
            if durations:
                return sum(durations) / len(durations)

        # Fallback to complexity-based estimation
        base_hours = {
            1: 0.5,
            2: 1.0,
            3: 1.5,
            4: 2.0,
            5: 2.5,
            6: 3.0,
            7: 4.0,
            8: 5.0,
            9: 6.0,
            10: 8.0,
            11: 10.0,
            12: 12.0,
            13: 15.0,
        }
        return base_hours.get(complexity_score, 8.0)

    def _estimate_qa_iterations(
        self, similar_tasks: list[dict[str, Any]], complexity_score: int
    ) -> float | None:
        """Estimate QA iterations based on similar tasks and complexity"""
        if similar_tasks:
            iterations = [
                task["qa_iterations"]
                for task in similar_tasks[:5]
                if task["qa_iterations"]
            ]
            if iterations:
                return sum(iterations) / len(iterations)

        # Fallback to complexity-based estimation
        return max(1.0, complexity_score / 3.0)

    def _estimate_token_cost(
        self, similar_tasks: list[dict[str, Any]], complexity_score: int
    ) -> float | None:
        """Estimate token cost based on similar tasks and complexity"""
        if similar_tasks:
            costs = [task["cost_usd"] for task in similar_tasks[:5] if task["cost_usd"]]
            if costs:
                return sum(costs) / len(costs)

        # Fallback to complexity-based estimation
        return complexity_score * 0.5  # Rough estimation: $0.50 per complexity point

    def _generate_recommendations(
        self,
        factors: TaskComplexityFactors,
        complexity_score: int,
        similar_tasks: list[dict[str, Any]],
    ) -> list[str]:
        """Generate recommendations based on the analysis"""
        recommendations = []

        # Risk-based recommendations
        if factors.risk_factors:
            recommendations.append(
                "Consider creating a separate branch for this high-risk task"
            )
            recommendations.append("Implement comprehensive testing before deployment")

        # Complexity-based recommendations
        if complexity_score >= 8:
            recommendations.append(
                "Break this task into smaller sub-tasks for better manageability"
            )
            recommendations.append("Schedule additional code review time")
        elif complexity_score >= 5:
            recommendations.append("Consider pair programming for complex sections")

        # Historical recommendations
        failed_similar = [
            task for task in similar_tasks if task["status"] == BuildStatus.FAILED
        ]
        if failed_similar:
            recommendations.append(
                f"Note: {len(failed_similar)} similar tasks failed historically - extra caution advised"
            )

        # File impact recommendations
        if factors.estimated_files_impacted > 7:
            recommendations.append("Plan for incremental deployment to reduce risk")

        return recommendations


# Global service instance
_smart_estimation_service = SmartEstimationService()


def get_smart_estimation_service() -> SmartEstimationService:
    """Get the global smart estimation service instance."""
    return _smart_estimation_service
