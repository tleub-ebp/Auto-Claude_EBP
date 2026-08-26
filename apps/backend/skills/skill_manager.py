#!/usr/bin/env python3
"""
Skill Manager for Claude Agent Skills

Manages discovery, loading, and execution of Claude Agent Skills with
progressive loading (3-level architecture) and automatic triggering.

Usage:
    skill_manager = SkillManager("skills/")
    relevant_skills = skill_manager.get_relevant_skills("migrate react 18 to 19")
    skill = skill_manager.load_skill("framework-migration")
    result = skill.execute_script("analyze_stack.py", {"project_root": "/path/to/project"})
"""

import json
import logging
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from core.workflow_logger import workflow_logger

logging.basicConfig(level=logging.INFO)
try:
    from skills_registry.frontmatter import parse_frontmatter
except ImportError:  # running as `python skills/skill_manager.py`
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from skills_registry.frontmatter import parse_frontmatter

logger = logging.getLogger(__name__)


@dataclass
class SkillMetadata:
    """Metadata extracted from SKILL.md frontmatter."""

    name: str
    description: str
    triggers: list[str] = field(default_factory=list)
    category: str = "general"
    version: str = "1.0.0"
    author: str = ""
    skill_path: Path = field(default_factory=lambda: Path())

    def matches_query(self, query: str) -> bool:
        """Check if this skill matches the given query."""
        query_lower = query.lower()

        # Check triggers first
        for trigger in self.triggers:
            if trigger.lower() in query_lower:
                return True

        # Check description and name
        if any(word in self.description.lower() for word in query_lower.split()):
            return True

        if any(word in self.name.lower() for word in query_lower.split()):
            return True

        return False


@dataclass
class Skill:
    """A loaded Claude Agent Skill with instructions and resources."""

    metadata: SkillMetadata
    instructions: str = ""
    resources: dict[str, Any] = field(default_factory=dict)

    def execute_script(
        self, script_name: str, args: dict[str, Any] = None
    ) -> dict[str, Any]:
        """Execute a script from this skill's scripts directory."""
        # Log skill execution start
        skill_trace_id = workflow_logger.log_skill_start(
            self.metadata.name,
            f"execute_script:{script_name}",
            {
                "script": script_name,
                "args": args,
                "skill_path": str(self.metadata.skill_path),
            },
        )

        script_path = self.metadata.skill_path / "scripts" / script_name
        if not script_path.exists():
            # Log skill error
            workflow_logger.log_skill_end(
                self.metadata.name,
                f"execute_script:{script_name}",
                "error",
                {"error": f"Script not found: {script_path}"},
                skill_trace_id,
            )
            raise FileNotFoundError(f"Script not found: {script_path}")

        # Build command arguments
        cmd = [sys.executable, str(script_path)]
        if args:
            for key, value in args.items():
                if isinstance(value, (list, dict)):
                    cmd.extend([f"--{key}", json.dumps(value)])
                else:
                    cmd.extend([f"--{key}", str(value)])

        try:
            result = subprocess.run(
                cmd,
                cwd=str(self.metadata.skill_path.parent.parent),
                capture_output=True,
                text=True,
                timeout=300,  # 5 minute timeout
            )

            execution_result = {
                "success": result.returncode == 0,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "returncode": result.returncode,
            }

            # Log skill completion
            workflow_logger.log_skill_end(
                self.metadata.name,
                f"execute_script:{script_name}",
                "success" if result.returncode == 0 else "error",
                {
                    "returncode": result.returncode,
                    "stdout_length": len(result.stdout),
                    "stderr_length": len(result.stderr),
                    "timed_out": False,
                },
                skill_trace_id,
            )

            return execution_result
        except subprocess.TimeoutExpired:
            # Log skill timeout
            workflow_logger.log_skill_end(
                self.metadata.name,
                f"execute_script:{script_name}",
                "timeout",
                {"timed_out": True, "timeout_seconds": 300},
                skill_trace_id,
            )
            return {
                "success": False,
                "stdout": "",
                "stderr": "Script execution timed out",
                "returncode": -1,
            }
        except Exception as e:
            # Log skill exception
            workflow_logger.log_skill_end(
                self.metadata.name,
                f"execute_script:{script_name}",
                "error",
                {"error": str(e), "exception_type": type(e).__name__},
                skill_trace_id,
            )
            return {"success": False, "stdout": "", "stderr": str(e), "returncode": -1}

    def get_template(self, template_name: str) -> str:
        """Get a template from this skill's templates directory."""
        template_path = self.metadata.skill_path / "templates" / template_name
        if not template_path.exists():
            raise FileNotFoundError(f"Template not found: {template_path}")

        return template_path.read_text(encoding="utf-8")

    def get_data(self, data_name: str) -> Any:
        """Get data from this skill's data directory."""
        data_path = self.metadata.skill_path / "data" / data_name
        if not data_path.exists():
            raise FileNotFoundError(f"Data file not found: {data_path}")

        if data_path.suffix == ".json":
            return json.loads(data_path.read_text(encoding="utf-8"))
        else:
            return data_path.read_text(encoding="utf-8")


class SkillManager:
    """Manages Claude Agent Skills with progressive loading."""

    def __init__(self, skills_dir: str = "skills/"):
        self.skills_dir = Path(skills_dir)
        self.skill_metadata: dict[str, SkillMetadata] = {}
        self.loaded_skills: dict[str, Skill] = {}

        if self.skills_dir.exists():
            self._load_all_metadata()
        else:
            logger.warning(f"Skills directory not found: {self.skills_dir}")

    def _load_all_metadata(self) -> None:
        """Load metadata from all available skills (Level 1 loading)."""
        logger.info("Loading skill metadata...")

        for skill_dir in self.skills_dir.iterdir():
            if skill_dir.is_dir():
                skill_file = skill_dir / "SKILL.md"
                if skill_file.exists():
                    try:
                        metadata = self._extract_metadata(skill_file)
                        # Resolve: execute_script() runs the subprocess with cwd set
                        # to the skills dir's parent, so a relative skill_path would
                        # be joined onto that cwd and double the prefix.
                        metadata.skill_path = skill_dir.resolve()
                        self.skill_metadata[metadata.name] = metadata
                        logger.debug(f"Loaded metadata for skill: {metadata.name}")
                    except Exception as e:
                        logger.error(f"Error loading metadata from {skill_file}: {e}")

        logger.info(f"Loaded metadata for {len(self.skill_metadata)} skills")

    def _extract_metadata(self, skill_file: Path) -> SkillMetadata:
        """Extract metadata from SKILL.md frontmatter.

        Parsing is delegated to skills_registry.frontmatter so this module
        agrees with the slash-command API on what a frontmatter block means.
        """
        content = skill_file.read_text(encoding="utf-8")
        try:
            meta, _ = parse_frontmatter(content)
        except Exception as e:
            logger.error(f"Error parsing frontmatter in {skill_file}: {e}")
            meta = {}

        if not meta:
            return SkillMetadata(
                name=skill_file.parent.name,
                description="No description available",
                triggers=[],
                category="general",
            )

        return SkillMetadata(
            name=str(meta.get("name", "") or ""),
            description=str(meta.get("description", "") or ""),
            triggers=list(meta.get("triggers", []) or []),
            category=str(meta.get("category", "general") or "general"),
            version=str(meta.get("version", "1.0.0") or "1.0.0"),
            author=str(meta.get("author", "") or ""),
        )

    def get_relevant_skills(self, query: str) -> list[str]:
        """Find skills relevant to the given query."""
        relevant = []
        query_lower = query.lower()

        for skill_name, metadata in self.skill_metadata.items():
            if metadata.matches_query(query_lower):
                relevant.append(skill_name)
                logger.debug(f"Skill '{skill_name}' matches query: {query}")

        logger.info(f"Found {len(relevant)} relevant skills for query: {query}")
        return relevant

    def load_skill(self, skill_name: str) -> Skill:
        """Load a specific skill with full instructions (Level 2 loading)."""
        if skill_name in self.loaded_skills:
            return self.loaded_skills[skill_name]

        metadata = self.skill_metadata.get(skill_name)
        if not metadata:
            raise ValueError(f"Skill not found: {skill_name}")

        skill_file = metadata.skill_path / "SKILL.md"
        if not skill_file.exists():
            raise FileNotFoundError(f"Skill file not found: {skill_file}")

        content = skill_file.read_text(encoding="utf-8")

        # Extract content after frontmatter
        instructions = ""
        if content.startswith("---"):
            end_marker = content.find("---", 3)
            if end_marker != -1:
                instructions = content[end_marker + 3 :].strip()
        else:
            instructions = content

        skill = Skill(metadata=metadata, instructions=instructions)

        self.loaded_skills[skill_name] = skill
        logger.info(f"Loaded skill: {skill_name}")

        return skill

    def list_skills(self, category: str | None = None) -> list[SkillMetadata]:
        """List all available skills, optionally filtered by category."""
        skills = list(self.skill_metadata.values())

        if category:
            skills = [s for s in skills if s.category == category]

        return sorted(skills, key=lambda s: s.name)

    def get_skill_info(self, skill_name: str) -> SkillMetadata | None:
        """Get metadata for a specific skill without loading it."""
        return self.skill_metadata.get(skill_name)

    def reload_metadata(self) -> None:
        """Reload all skill metadata (useful for development)."""
        self.skill_metadata.clear()
        self.loaded_skills.clear()
        self._load_all_metadata()
        logger.info("Reloaded all skill metadata")

    def search_skills(self, query: str) -> list[SkillMetadata]:
        """Search skills by name, description, or triggers."""
        results = []
        query_lower = query.lower()

        for metadata in self.skill_metadata.values():
            # Search in name
            if query_lower in metadata.name.lower():
                results.append(metadata)
                continue

            # Search in description
            if query_lower in metadata.description.lower():
                results.append(metadata)
                continue

            # Search in triggers
            for trigger in metadata.triggers:
                if query_lower in trigger.lower():
                    results.append(metadata)
                    break

        return results


def main():
    """Command line interface for Skill Manager."""
    import argparse

    parser = argparse.ArgumentParser(description="Claude Agent Skills Manager")
    parser.add_argument("--skills-dir", default="skills/", help="Skills directory path")
    parser.add_argument("--list", action="store_true", help="List all available skills")
    parser.add_argument("--search", help="Search skills by query")
    parser.add_argument("--info", help="Get info about a specific skill")
    parser.add_argument("--load", help="Load a specific skill")
    parser.add_argument("--execute", help="Execute a script from a skill")
    parser.add_argument("--query", help="Find relevant skills for a query")
    parser.add_argument(
        "--verbose", "-v", action="store_true", help="Enable verbose logging"
    )

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    manager = SkillManager(args.skills_dir)

    if args.list:
        skills = manager.list_skills()
        print(f"Available skills ({len(skills)}):")
        for skill in skills:
            print(f"  - {skill.name}: {skill.description[:80]}...")

    elif args.search:
        results = manager.search_skills(args.search)
        print(f"Search results for '{args.search}' ({len(results)}):")
        for skill in results:
            print(f"  - {skill.name}: {skill.description[:80]}...")

    elif args.info:
        skill_info = manager.get_skill_info(args.info)
        if skill_info:
            print(f"Skill: {skill_info.name}")
            print(f"Description: {skill_info.description}")
            print(f"Category: {skill_info.category}")
            print(f"Version: {skill_info.version}")
            print(f"Author: {skill_info.author}")
            print(f"Triggers: {', '.join(skill_info.triggers)}")
        else:
            print(f"Skill not found: {args.info}")

    elif args.query:
        relevant = manager.get_relevant_skills(args.query)
        print(f"Relevant skills for '{args.query}' ({len(relevant)}):")
        for skill_name in relevant:
            metadata = manager.skill_metadata[skill_name]
            print(f"  - {skill_name}: {metadata.description[:80]}...")

    elif args.load and args.execute:
        try:
            skill = manager.load_skill(args.load)
            result = skill.execute_script(args.execute)
            print(f"Execution result: {result}")
        except Exception as e:
            print(f"Error: {e}")

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
