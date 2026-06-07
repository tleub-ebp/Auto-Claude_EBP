"""
Learning Loop System for Convention Evolution

This module implements the Learning Loop that analyzes successful builds,
discovers patterns, and automatically evolves project conventions.
"""

import hashlib
import json
import logging
import os
import re
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class BuildPattern:
    """Represents a discovered pattern from successful builds."""

    pattern_id: str
    pattern_type: str  # 'code_structure', 'naming', 'architecture', 'performance'
    description: str
    examples: list[str]
    success_rate: float
    frequency: int
    confidence_score: float
    discovered_at: datetime
    last_seen: datetime

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        data = asdict(self)
        data["discovered_at"] = self.discovered_at.isoformat()
        data["last_seen"] = self.last_seen.isoformat()
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BuildPattern":
        """Create from dictionary."""
        data["discovered_at"] = datetime.fromisoformat(data["discovered_at"])
        data["last_seen"] = datetime.fromisoformat(data["last_seen"])
        return cls(**data)


@dataclass
class ConventionEvolution:
    """Represents a proposed convention evolution."""

    evolution_id: str
    pattern_id: str
    evolution_type: str  # 'add', 'update', 'remove'
    target_file: str  # conventions.md, architecture.md, patterns.md
    section: str
    proposed_change: str
    rationale: str
    confidence_score: float
    impact_assessment: str
    created_at: datetime

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        data = asdict(self)
        data["created_at"] = self.created_at.isoformat()
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ConventionEvolution":
        """Create from dictionary."""
        data["created_at"] = datetime.fromisoformat(data["created_at"])
        return cls(**data)


class LearningLoop:
    """
    Learning Loop system that analyzes successful builds to discover patterns
    and propose convention evolutions.
    """

    def __init__(self, project_root: str):
        self.project_root = Path(project_root)
        self.workpilot_dir = self.project_root / ".workpilot"
        self.learning_dir = self.workpilot_dir / "learning"
        self.patterns_file = self.learning_dir / "patterns.json"
        self.evolutions_file = self.learning_dir / "evolutions.json"
        self.build_history_file = self.learning_dir / "build_history.json"

        # Ensure learning directory exists
        self.learning_dir.mkdir(parents=True, exist_ok=True)

        # Data storage
        self.patterns: dict[str, BuildPattern] = {}
        self.evolutions: dict[str, ConventionEvolution] = {}
        self.build_history: list[dict[str, Any]] = []

        # Configuration
        self.min_success_rate = 0.8  # Minimum success rate for pattern adoption
        self.min_frequency = 5  # Minimum occurrences for pattern consideration
        self.confidence_threshold = 0.7  # Minimum confidence for evolution proposals

        self._load_data()

    def _load_data(self):
        """Load learning data from files."""
        try:
            # Load patterns
            if self.patterns_file.exists():
                patterns_data = json.loads(
                    self.patterns_file.read_text(encoding="utf-8")
                )
                self.patterns = {
                    pid: BuildPattern.from_dict(pdata)
                    for pid, pdata in patterns_data.items()
                }

            # Load evolutions
            if self.evolutions_file.exists():
                evolutions_data = json.loads(
                    self.evolutions_file.read_text(encoding="utf-8")
                )
                self.evolutions = {
                    eid: ConventionEvolution.from_dict(edata)
                    for eid, edata in evolutions_data.items()
                }

            # Load build history
            if self.build_history_file.exists():
                self.build_history = json.loads(
                    self.build_history_file.read_text(encoding="utf-8")
                )

        except Exception as e:
            logger.warning(f"Failed to load learning data: {e}")

    def _save_data(self):
        """Save learning data to files."""
        try:
            # Save patterns
            patterns_data = {
                pid: pattern.to_dict() for pid, pattern in self.patterns.items()
            }
            self.patterns_file.write_text(
                json.dumps(patterns_data, indent=2), encoding="utf-8"
            )

            # Save evolutions
            evolutions_data = {
                eid: evolution.to_dict() for eid, evolution in self.evolutions.items()
            }
            self.evolutions_file.write_text(
                json.dumps(evolutions_data, indent=2), encoding="utf-8"
            )

            # Save build history
            self.build_history_file.write_text(
                json.dumps(self.build_history, indent=2), encoding="utf-8"
            )

        except Exception as e:
            logger.error(f"Failed to save learning data: {e}")

    def record_build(self, build_data: dict[str, Any]):
        """Record a build completion for learning."""
        build_record = {
            "build_id": build_data.get("build_id", self._generate_id()),
            "timestamp": datetime.now().isoformat(),
            "success": build_data.get("success", False),
            "duration": build_data.get("duration", 0),
            "files_changed": build_data.get("files_changed", []),
            "agent_types": build_data.get("agent_types", []),
            "technologies_used": build_data.get("technologies_used", []),
            "patterns_applied": build_data.get("patterns_applied", []),
            "violations_found": build_data.get("violations_found", []),
            "performance_metrics": build_data.get("performance_metrics", {}),
            "context_size": build_data.get("context_size", 0),
            "tokens_used": build_data.get("tokens_used", 0),
        }

        self.build_history.append(build_record)

        # Keep only recent history (last 1000 builds)
        if len(self.build_history) > 1000:
            self.build_history = self.build_history[-1000:]

        # Trigger pattern discovery if this was a successful build
        if build_record["success"]:
            self._discover_patterns_from_build(build_record)

        self._save_data()

    def _discover_patterns_from_build(self, build_record: dict[str, Any]):
        """Discover patterns from a successful build."""
        try:
            # Analyze file structure patterns
            self._analyze_file_structure_patterns(build_record)

            # Analyze naming patterns
            self._analyze_naming_patterns(build_record)

            # Analyze architecture patterns
            self._analyze_architecture_patterns(build_record)

            # Analyze performance patterns
            self._analyze_performance_patterns(build_record)

            # Generate evolution proposals
            self._generate_evolution_proposals()

        except Exception as e:
            logger.warning(f"Pattern discovery failed: {e}")

    def _analyze_file_structure_patterns(self, build_record: dict[str, Any]):
        """Analyze file structure patterns."""
        files_changed = build_record.get("files_changed", [])

        # Group files by directory and type
        directory_patterns = defaultdict(list)
        for file_path in files_changed:
            path = Path(file_path)
            directory_patterns[str(path.parent)].append(path.suffix)

        # Look for consistent directory structures
        for directory, extensions in directory_patterns.items():
            if len(extensions) >= 3:  # Significant pattern
                pattern_id = self._generate_pattern_id("file_structure", directory)

                # Calculate success rate for similar structures
                similar_builds = self._find_similar_builds("file_structure", directory)
                success_rate = len([b for b in similar_builds if b["success"]]) / max(
                    len(similar_builds), 1
                )

                if success_rate >= self.min_success_rate:
                    pattern = BuildPattern(
                        pattern_id=pattern_id,
                        pattern_type="file_structure",
                        description=f"Directory structure: {directory} with {', '.join(set(extensions))}",
                        examples=[directory],
                        success_rate=success_rate,
                        frequency=len(similar_builds),
                        confidence_score=min(
                            success_rate * (len(similar_builds) / 10), 1.0
                        ),
                        discovered_at=datetime.now(),
                        last_seen=datetime.now(),
                    )

                    self.patterns[pattern_id] = pattern

    def _analyze_naming_patterns(self, build_record: dict[str, Any]):
        """Analyze naming conventions."""
        files_changed = build_record.get("files_changed", [])

        # Analyze file naming patterns
        naming_patterns = defaultdict(int)
        for file_path in files_changed:
            path = Path(file_path)
            filename = path.stem

            # Determine naming style
            if re.match(r"^[a-z][a-z0-9_]*$", filename):
                naming_patterns["snake_case"] += 1
            elif re.match(r"^[A-Z][a-zA-Z0-9]*$", filename):
                naming_patterns["PascalCase"] += 1
            elif re.match(r"^[a-z][a-zA-Z0-9]*$", filename):
                naming_patterns["camelCase"] += 1
            elif re.match(r"^[a-z-]+$", filename):
                naming_patterns["kebab-case"] += 1

        # Look for dominant naming patterns
        for naming_style, count in naming_patterns.items():
            if count >= 3:  # Significant pattern
                pattern_id = self._generate_pattern_id("naming", naming_style)

                similar_builds = self._find_similar_builds("naming", naming_style)
                success_rate = len([b for b in similar_builds if b["success"]]) / max(
                    len(similar_builds), 1
                )

                if success_rate >= self.min_success_rate:
                    pattern = BuildPattern(
                        pattern_id=pattern_id,
                        pattern_type="naming",
                        description=f"File naming convention: {naming_style}",
                        examples=[f"example.{naming_style}"],
                        success_rate=success_rate,
                        frequency=len(similar_builds),
                        confidence_score=min(
                            success_rate * (len(similar_builds) / 10), 1.0
                        ),
                        discovered_at=datetime.now(),
                        last_seen=datetime.now(),
                    )

                    self.patterns[pattern_id] = pattern

    def _analyze_architecture_patterns(self, build_record: dict[str, Any]):
        """Analyze architectural patterns."""
        agent_types = build_record.get("agent_types", [])

        # Look for successful agent combinations
        if len(agent_types) >= 2:
            agent_combo = "_".join(sorted(agent_types))
            pattern_id = self._generate_pattern_id("architecture", agent_combo)

            similar_builds = self._find_similar_builds("architecture", agent_combo)
            success_rate = len([b for b in similar_builds if b["success"]]) / max(
                len(similar_builds), 1
            )

            if (
                success_rate >= self.min_success_rate
                and len(similar_builds) >= self.min_frequency
            ):
                pattern = BuildPattern(
                    pattern_id=pattern_id,
                    pattern_type="architecture",
                    description=f"Agent combination: {', '.join(agent_types)}",
                    examples=[agent_combo],
                    success_rate=success_rate,
                    frequency=len(similar_builds),
                    confidence_score=min(
                        success_rate * (len(similar_builds) / 20), 1.0
                    ),
                    discovered_at=datetime.now(),
                    last_seen=datetime.now(),
                )

                self.patterns[pattern_id] = pattern

    def _analyze_performance_patterns(self, build_record: dict[str, Any]):
        """Analyze performance patterns."""
        duration = build_record.get("duration", 0)
        tokens_used = build_record.get("tokens_used", 0)

        # Look for efficient patterns
        if duration > 0 and tokens_used > 0:
            efficiency = tokens_used / duration  # tokens per second

            # Categorize efficiency
            if efficiency < 100:
                efficiency_category = "high_efficiency"
            elif efficiency < 500:
                efficiency_category = "medium_efficiency"
            else:
                efficiency_category = "low_efficiency"

            pattern_id = self._generate_pattern_id("performance", efficiency_category)

            similar_builds = self._find_similar_builds(
                "performance", efficiency_category
            )
            success_rate = len([b for b in similar_builds if b["success"]]) / max(
                len(similar_builds), 1
            )

            if success_rate >= self.min_success_rate:
                pattern = BuildPattern(
                    pattern_id=pattern_id,
                    pattern_type="performance",
                    description=f"Performance pattern: {efficiency_category}",
                    examples=[f"Efficiency: {efficiency:.1f} tokens/sec"],
                    success_rate=success_rate,
                    frequency=len(similar_builds),
                    confidence_score=min(
                        success_rate * (len(similar_builds) / 15), 1.0
                    ),
                    discovered_at=datetime.now(),
                    last_seen=datetime.now(),
                )

                self.patterns[pattern_id] = pattern

    def _generate_evolution_proposals(self):
        """Generate convention evolution proposals based on discovered patterns."""
        for pattern in self.patterns.values():
            # Check if pattern is strong enough for evolution
            if (
                pattern.confidence_score >= self.confidence_threshold
                and pattern.frequency >= self.min_frequency
            ):
                # Check if we already have an evolution for this pattern
                existing_evolution = self._find_evolution_for_pattern(
                    pattern.pattern_id
                )

                if not existing_evolution:
                    evolution = self._create_evolution_proposal(pattern)
                    if evolution:
                        self.evolutions[evolution.evolution_id] = evolution

    def _create_evolution_proposal(
        self, pattern: BuildPattern
    ) -> ConventionEvolution | None:
        """Create an evolution proposal for a pattern."""
        if pattern.pattern_type == "naming":
            return self._create_naming_evolution(pattern)
        elif pattern.pattern_type == "file_structure":
            return self._create_structure_evolution(pattern)
        elif pattern.pattern_type == "architecture":
            return self._create_architecture_evolution(pattern)
        elif pattern.pattern_type == "performance":
            return self._create_performance_evolution(pattern)

        return None

    def _create_naming_evolution(self, pattern: BuildPattern) -> ConventionEvolution:
        """Create naming convention evolution."""
        evolution_id = self._generate_id()

        if "snake_case" in pattern.description:
            proposed_change = (
                "### File Naming\n- Python files: Use `snake_case.py` naming convention"
            )
            section = "Code Style Conventions"
        elif "PascalCase" in pattern.description:
            proposed_change = "### File Naming\n- React components: Use `PascalCase.tsx` naming convention"
            section = "Code Style Conventions"
        else:
            proposed_change = f"### File Naming\n- {pattern.description}"
            section = "Code Style Conventions"

        return ConventionEvolution(
            evolution_id=evolution_id,
            pattern_id=pattern.pattern_id,
            evolution_type="add",
            target_file="conventions.md",
            section=section,
            proposed_change=proposed_change,
            rationale=f"Pattern discovered with {pattern.success_rate:.1%} success rate across {pattern.frequency} builds",
            confidence_score=pattern.confidence_score,
            impact_assessment="Medium - Improves code consistency",
            created_at=datetime.now(),
        )

    def _create_structure_evolution(self, pattern: BuildPattern) -> ConventionEvolution:
        """Create file structure evolution."""
        evolution_id = self._generate_id()

        proposed_change = f"### Directory Structure\n- {pattern.description}"
        section = "Architecture Patterns"

        return ConventionEvolution(
            evolution_id=evolution_id,
            pattern_id=pattern.pattern_id,
            evolution_type="add",
            target_file="architecture.md",
            section=section,
            proposed_change=proposed_change,
            rationale=f"Consistent directory structure with {pattern.success_rate:.1%} success rate",
            confidence_score=pattern.confidence_score,
            impact_assessment="High - Improves project organization",
            created_at=datetime.now(),
        )

    def _create_architecture_evolution(
        self, pattern: BuildPattern
    ) -> ConventionEvolution:
        """Create architecture pattern evolution."""
        evolution_id = self._generate_id()

        proposed_change = f"### Multi-Agent Coordination\n- {pattern.description}"
        section = "Architecture Patterns"

        return ConventionEvolution(
            evolution_id=evolution_id,
            pattern_id=pattern.pattern_id,
            evolution_type="add",
            target_file="patterns.md",
            section=section,
            proposed_change=proposed_change,
            rationale="Successful agent combination pattern",
            confidence_score=pattern.confidence_score,
            impact_assessment="Medium - Improves build success rate",
            created_at=datetime.now(),
        )

    def _create_performance_evolution(
        self, pattern: BuildPattern
    ) -> ConventionEvolution:
        """Create performance pattern evolution."""
        evolution_id = self._generate_id()

        proposed_change = f"### Performance Patterns\n- {pattern.description}"
        section = "Performance Standards"

        return ConventionEvolution(
            evolution_id=evolution_id,
            pattern_id=pattern.pattern_id,
            evolution_type="add",
            target_file="conventions.md",
            section=section,
            proposed_change=proposed_change,
            rationale="Performance optimization pattern discovered",
            confidence_score=pattern.confidence_score,
            impact_assessment="Low - Performance guidance",
            created_at=datetime.now(),
        )

    def _find_similar_builds(
        self, pattern_type: str, pattern_value: str
    ) -> list[dict[str, Any]]:
        """Find builds with similar patterns."""
        similar_builds = []

        for build in self.build_history:
            if pattern_type == "naming":
                # Check if similar naming patterns were used
                files = build.get("files_changed", [])
                if any(self._matches_naming_pattern(f, pattern_value) for f in files):
                    similar_builds.append(build)

            elif pattern_type == "file_structure":
                # Check if similar directory structures
                files = build.get("files_changed", [])
                if any(
                    self._matches_structure_pattern(f, pattern_value) for f in files
                ):
                    similar_builds.append(build)

            elif pattern_type == "architecture":
                # Check agent combinations
                agents = build.get("agent_types", [])
                if pattern_value.replace("_", " ") in " ".join(sorted(agents)):
                    similar_builds.append(build)

            elif pattern_type == "performance":
                # Check performance category
                duration = build.get("duration", 0)
                tokens = build.get("tokens_used", 0)

                if duration > 0 and tokens > 0:
                    efficiency = tokens / duration
                    if (
                        (pattern_value == "high_efficiency" and efficiency < 100)
                        or (
                            pattern_value == "medium_efficiency"
                            and 100 <= efficiency < 500
                        )
                        or (pattern_value == "low_efficiency" and efficiency >= 500)
                    ):
                        similar_builds.append(build)

        return similar_builds

    def _matches_naming_pattern(self, file_path: str, pattern: str) -> bool:
        """Check if file matches naming pattern."""
        filename = Path(file_path).stem

        if pattern == "snake_case":
            return re.match(r"^[a-z][a-z0-9_]*$", filename) is not None
        elif pattern == "PascalCase":
            return re.match(r"^[A-Z][a-zA-Z0-9]*$", filename) is not None
        elif pattern == "camelCase":
            return re.match(r"^[a-z][a-zA-Z0-9]*$", filename) is not None
        elif pattern == "kebab-case":
            return re.match(r"^[a-z-]+$", filename) is not None

        return False

    def _matches_structure_pattern(self, file_path: str, pattern: str) -> bool:
        """Check if file matches structure pattern."""
        return pattern in str(Path(file_path).parent)

    def _find_evolution_for_pattern(
        self, pattern_id: str
    ) -> ConventionEvolution | None:
        """Find existing evolution for a pattern."""
        for evolution in self.evolutions.values():
            if evolution.pattern_id == pattern_id:
                return evolution
        return None

    def _generate_pattern_id(self, pattern_type: str, pattern_value: str) -> str:
        """Generate unique pattern ID."""
        content = f"{pattern_type}:{pattern_value}"
        return hashlib.md5(content.encode(), usedforsecurity=False).hexdigest()[:12]

    def _generate_id(self) -> str:
        """Generate unique ID."""
        return hashlib.md5(
            f"{datetime.now().isoformat()}{os.urandom(8)}".encode(),
            usedforsecurity=False,
        ).hexdigest()[:12]

    def get_pending_evolutions(self) -> list[ConventionEvolution]:
        """Get all pending evolution proposals."""
        return list(self.evolutions.values())

    def apply_evolution(self, evolution_id: str) -> bool:
        """Apply an evolution proposal to steering files."""
        if evolution_id not in self.evolutions:
            return False

        evolution = self.evolutions[evolution_id]
        target_file = self.workpilot_dir / evolution.target_file

        try:
            if target_file.exists():
                content = target_file.read_text(encoding="utf-8")

                # Find the section and add the proposed change
                if evolution.section in content:
                    # Insert after section header
                    section_pattern = f"## {evolution.section}"
                    if section_pattern in content:
                        parts = content.split(section_pattern)
                        new_content = (
                            parts[0]
                            + section_pattern
                            + "\n"
                            + evolution.proposed_change
                            + "\n"
                            + parts[1]
                        )
                        target_file.write_text(new_content, encoding="utf-8")

                        # Remove applied evolution
                        del self.evolutions[evolution_id]
                        self._save_data()
                        return True
                else:
                    # Add new section at the end
                    new_content = (
                        content
                        + f"\n\n## {evolution.section}\n{evolution.proposed_change}\n"
                    )
                    target_file.write_text(new_content, encoding="utf-8")

                    # Remove applied evolution
                    del self.evolutions[evolution_id]
                    self._save_data()
                    return True

        except Exception as e:
            logger.error(f"Failed to apply evolution {evolution_id}: {e}")

        return False

    def reject_evolution(self, evolution_id: str) -> bool:
        """Reject and remove an evolution proposal."""
        if evolution_id in self.evolutions:
            del self.evolutions[evolution_id]
            self._save_data()
            return True
        return False

    def get_learning_summary(self) -> dict[str, Any]:
        """Get summary of learning data."""
        recent_builds = [
            b
            for b in self.build_history
            if datetime.fromisoformat(b["timestamp"])
            > datetime.now() - timedelta(days=30)
        ]

        recent_success_rate = len([b for b in recent_builds if b["success"]]) / max(
            len(recent_builds), 1
        )

        return {
            "total_builds": len(self.build_history),
            "recent_builds": len(recent_builds),
            "recent_success_rate": recent_success_rate,
            "patterns_discovered": len(self.patterns),
            "pending_evolutions": len(self.evolutions),
            "pattern_types": {
                ptype: len(
                    [p for p in self.patterns.values() if p.pattern_type == ptype]
                )
                for ptype in set(p.pattern_type for p in self.patterns.values())
            },
            "high_confidence_patterns": len(
                [
                    p
                    for p in self.patterns.values()
                    if p.confidence_score >= self.confidence_threshold
                ]
            ),
        }


def create_learning_loop(project_root: str) -> LearningLoop:
    """Factory function to create learning loop."""
    return LearningLoop(project_root)
