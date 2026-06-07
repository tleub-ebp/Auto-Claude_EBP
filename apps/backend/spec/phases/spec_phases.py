"""
Spec Writing and Critique Phase Implementations
================================================

Phases for spec document creation and quality assurance.
"""

import json
from typing import TYPE_CHECKING

from .. import validator, writer
from .models import MAX_RETRIES, PhaseResult

if TYPE_CHECKING:
    pass


class SpecPhaseMixin:
    """Mixin for spec writing and critique phase methods."""

    async def phase_quick_spec(self) -> PhaseResult:
        """Quick spec for simple tasks - combines context and spec in one step."""
        spec_file = self.spec_dir / "spec.md"
        plan_file = self.spec_dir / "implementation_plan.json"

        if spec_file.exists() and plan_file.exists():
            self.ui.print_status("Quick spec already exists", "success")
            return PhaseResult(
                "quick_spec", True, [str(spec_file), str(plan_file)], [], 0
            )

        errors = []
        for attempt in range(MAX_RETRIES):
            self.ui.print_status(
                f"Running quick spec agent (attempt {attempt + 1})...", "progress"
            )

            context_str = f"""
**Task**: {self.task_description}
**Spec Directory**: {self.spec_dir}
**Complexity**: SIMPLE (1-2 files expected)

This is a SIMPLE task. Create a minimal spec and implementation plan directly.
No research or extensive analysis needed.

Create:
1. A concise spec.md with just the essential sections
2. A simple implementation_plan.json with 1-2 subtasks
"""
            success, output = await self.run_agent_fn(
                "spec_quick.md",
                additional_context=context_str,
                phase_name="quick_spec",
            )

            if success and spec_file.exists():
                # Create minimal plan if agent didn't
                if not plan_file.exists():
                    writer.create_minimal_plan(self.spec_dir, self.task_description)

                self.ui.print_status("Quick spec created", "success")
                return PhaseResult(
                    "quick_spec", True, [str(spec_file), str(plan_file)], [], attempt
                )

            errors.append(f"Attempt {attempt + 1}: Quick spec agent failed")

        # Escalade automatique : si le quick spec echoue apres tous les essais,
        # on bascule sur le workflow STANDARD (context -> spec_writing -> planning)
        # au lieu de declarer la tache en erreur. Cela rend le pipeline tolerant
        # a une mauvaise classification de complexite (ex. tache jugee SIMPLE a
        # tort sur une grosse base de code necessitant de la recherche).
        return await self._escalate_quick_spec(spec_file, plan_file, errors)

    async def _escalate_quick_spec(
        self, spec_file, plan_file, prior_errors: list[str]
    ) -> PhaseResult:
        """Bascule du quick spec vers le workflow STANDARD apres echec.

        Execute sequentiellement les phases context, spec_writing et planning,
        qui disposent toutes de fallbacks fiables (context/spec minimal, planner
        deterministe). Retourne un quick_spec reussi si spec.md et le plan ont
        ete produits, sinon un echec contenant l'ensemble des erreurs.
        """
        self.ui.print_status(
            "Quick spec failed - escalating to STANDARD spec workflow",
            "warning",
        )

        escalation_errors = list(prior_errors)
        fallback_phases = (
            self.phase_context,
            self.phase_spec_writing,
            self.phase_planning,
        )
        for fallback_phase in fallback_phases:
            fallback_result = await fallback_phase()
            escalation_errors.extend(fallback_result.errors)
            if not fallback_result.success:
                self.ui.print_status(
                    f"Escalation phase '{fallback_result.phase}' failed",
                    "error",
                )
                return PhaseResult(
                    "quick_spec", False, [], escalation_errors, MAX_RETRIES
                )

        if spec_file.exists() and plan_file.exists():
            self.ui.print_status("Spec created via STANDARD escalation", "success")
            return PhaseResult(
                "quick_spec",
                True,
                [str(spec_file), str(plan_file)],
                escalation_errors,
                MAX_RETRIES,
            )

        escalation_errors.append(
            "Escalation completed but spec.md or implementation_plan.json missing"
        )
        return PhaseResult("quick_spec", False, [], escalation_errors, MAX_RETRIES)

    async def phase_spec_writing(self) -> PhaseResult:
        """Write the spec.md document."""
        spec_file = self.spec_dir / "spec.md"

        if spec_file.exists():
            result = self.spec_validator.validate_spec_document()
            if result.valid:
                self.ui.print_status("spec.md already exists and is valid", "success")
                return PhaseResult("spec_writing", True, [str(spec_file)], [], 0)
            self.ui.print_status(
                "spec.md exists but has issues, regenerating...", "warning"
            )

        errors = []
        for attempt in range(MAX_RETRIES):
            self.ui.print_status(
                f"Running spec writer (attempt {attempt + 1})...", "progress"
            )

            # Check if we have sufficient context before running agent
            context_file = self.spec_dir / "context.json"
            requirements_file = self.spec_dir / "requirements.json"

            # Create enhanced context for minimal scenarios
            additional_context = ""
            if context_file.exists():
                try:
                    import json

                    with open(context_file, encoding="utf-8") as f:
                        ctx = json.load(f)

                    # If we're in fallback mode with minimal context, add helpful guidance
                    if ctx.get("fallback_mode") and not ctx.get("files_to_modify"):
                        additional_context = f"""
**IMPORTANT**: You're working with minimal context because the context discovery script failed.
The task description is: {ctx.get("task_description", "Unknown")}

Since you have minimal context, create a SPECIFIC and ACTIONABLE spec based on the task description:
1. Extract the main requirement from the task description
2. Create a complete spec with all required sections (Overview, Workflow Type, Task Scope, Success Criteria)
3. Be specific about what needs to be implemented
4. Include reasonable assumptions based on the task description
5. Create comprehensive QA criteria

It's OK to make reasonable assumptions to create a complete spec. The goal is to provide a clear implementation guide.
"""
                except Exception:
                    pass

            success, output = await self.run_agent_fn(
                "spec_writer.md",
                additional_context=additional_context,
                phase_name="spec_writing",
            )

            if success and spec_file.exists():
                result = self.spec_validator.validate_spec_document()
                if result.valid:
                    self.ui.print_status("Created valid spec.md", "success")
                    return PhaseResult(
                        "spec_writing", True, [str(spec_file)], [], attempt
                    )
                else:
                    errors.append(
                        f"Attempt {attempt + 1}: Spec invalid - {result.errors}"
                    )
                    self.ui.print_status(
                        f"Spec created but invalid: {result.errors}", "error"
                    )
            else:
                errors.append(f"Attempt {attempt + 1}: Agent did not create spec.md")

        # If all attempts failed, create a fallback spec
        if not spec_file.exists():
            self.ui.print_status("Creating fallback spec.md...", "warning")
            self._create_fallback_spec()
            if spec_file.exists():
                return PhaseResult(
                    "spec_writing",
                    True,
                    [str(spec_file)],
                    ["Created fallback spec"],
                    MAX_RETRIES,
                )

        return PhaseResult("spec_writing", False, [], errors, MAX_RETRIES)

    def _create_fallback_spec(self) -> None:
        """Create a fallback spec.md when agent fails."""
        spec_file = self.spec_dir / "spec.md"
        requirements_file = self.spec_dir / "requirements.json"

        # Load requirements for task description
        task_desc = "Unknown task"
        workflow_type = "feature"

        if requirements_file.exists():
            try:
                import json

                with open(requirements_file, encoding="utf-8") as f:
                    req = json.load(f)
                task_desc = req.get("task_description", task_desc)
                workflow_type = req.get("workflow_type", workflow_type)
            except Exception:
                pass

        # Create a basic but complete spec
        fallback_spec = f"""# Specification: {task_desc[:50]}{"..." if len(task_desc) > 50 else ""}

## Overview

This task addresses: {task_desc}

## Workflow Type

**Type**: {workflow_type}

**Rationale**: Based on the task description, this appears to be a {workflow_type} type of work.

## Task Scope

### Services Involved
- **Backend Service** (primary) - Main implementation service

### This Task Will:
- [ ] Implement the requirements described in the task
- [ ] Follow established patterns and conventions
- [ ] Ensure code quality and testing

### Out of Scope:
- Major architectural changes
- Breaking changes to existing APIs

## Service Context

### Backend Service

**Tech Stack:**
- Language: Python
- Framework: Based on project structure

**How to Run:**
```bash
# Standard Python run commands
python -m src.main
```

## Files to Modify

| File | Service | What to Change |
|------|---------|---------------|
| *To be determined* | Backend | Implementation based on task requirements |

## Files to Reference

| File | Pattern to Copy |
|------|----------------|
| *To be determined* | Existing patterns in the codebase |

## Patterns to Follow

### Code Style

Follow existing codebase patterns for:
- Function naming conventions
- Error handling
- Documentation
- Testing structure

## Requirements

### Functional Requirements

1. **Main Requirement**
   - Description: {task_desc}
   - Acceptance: Implementation meets the described requirements

### Edge Cases

1. **Error Handling** - Proper error handling for edge cases
2. **Input Validation** - Validate inputs appropriately

## Implementation Notes

### DO
- Follow existing code patterns
- Add appropriate error handling
- Include tests for new functionality
- Document changes clearly

### DON'T
- Break existing functionality
- Introduce unnecessary complexity
- Skip error handling

## Development Environment

### Start Services

```bash
# Start the application as per project conventions
python -m src.main
```

### Service URLs
- Backend: http://localhost:8000 (typical)

## Success Criteria

The task is complete when:

1. [ ] Requirements are implemented as described
2. [ ] Code follows established patterns
3. [ ] No console errors
4. [ ] Existing tests still pass
5. [ ] New functionality is tested

## QA Acceptance Criteria

**CRITICAL**: These criteria must be verified before sign-off.

### Unit Tests
| Test | File | What to Verify |
|------|------|----------------|
| New functionality tests | *To be created* | Verify new implementation |

### Integration Tests
| Test | Services | What to Verify |
|------|----------|----------------|
| Integration test | Backend | Component interaction |

### QA Sign-off Requirements
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] No regressions in existing functionality
- [ ] Code follows established patterns
- [ ] No security vulnerabilities introduced

---

*This spec was automatically generated as a fallback when the spec writer agent failed.*
"""

        with open(spec_file, "w", encoding="utf-8") as f:
            f.write(fallback_spec)

    async def phase_self_critique(self) -> PhaseResult:
        """Self-critique the spec using extended thinking."""
        spec_file = self.spec_dir / "spec.md"
        research_file = self.spec_dir / "research.json"
        critique_file = self.spec_dir / "critique_report.json"

        if not spec_file.exists():
            self.ui.print_status("No spec.md to critique", "error")
            return PhaseResult(
                "self_critique", False, [], ["spec.md does not exist"], 0
            )

        if critique_file.exists():
            with open(critique_file, encoding="utf-8") as f:
                critique = json.load(f)
                if critique.get("issues_fixed", False) or critique.get(
                    "no_issues_found", False
                ):
                    self.ui.print_status("Self-critique already completed", "success")
                    return PhaseResult(
                        "self_critique", True, [str(critique_file)], [], 0
                    )

        errors = []
        for attempt in range(MAX_RETRIES):
            self.ui.print_status(
                f"Running self-critique agent (attempt {attempt + 1})...", "progress"
            )

            context_str = f"""
**Spec File**: {spec_file}
**Research File**: {research_file}
**Critique Output**: {critique_file}

Use EXTENDED THINKING (ultrathink) to deeply analyze the spec.md:

1. **Technical Accuracy**: Do code examples match the research findings?
2. **Completeness**: Are all requirements covered? Edge cases handled?
3. **Consistency**: Do package names, APIs, and patterns match throughout?
4. **Feasibility**: Is the implementation approach realistic?

For each issue found:
- Fix it directly in spec.md
- Document what was fixed in critique_report.json

Output critique_report.json with:
{{
  "issues_found": [...],
  "issues_fixed": true/false,
  "no_issues_found": true/false,
  "critique_summary": "..."
}}
"""
            success, output = await self.run_agent_fn(
                "spec_critic.md",
                additional_context=context_str,
                phase_name="self_critique",
            )

            if success:
                if not critique_file.exists():
                    validator.create_minimal_critique(
                        self.spec_dir,
                        reason="Agent completed without explicit issues",
                    )

                result = self.spec_validator.validate_spec_document()
                if result.valid:
                    self.ui.print_status(
                        "Self-critique completed, spec is valid", "success"
                    )
                    return PhaseResult(
                        "self_critique", True, [str(critique_file)], [], attempt
                    )
                else:
                    self.ui.print_status(
                        f"Spec invalid after critique: {result.errors}", "warning"
                    )
                    errors.append(
                        f"Attempt {attempt + 1}: Spec still invalid after critique"
                    )
            else:
                errors.append(f"Attempt {attempt + 1}: Critique agent failed")

        validator.create_minimal_critique(
            self.spec_dir,
            reason="Critique failed after retries",
        )
        return PhaseResult(
            "self_critique", True, [str(critique_file)], errors, MAX_RETRIES
        )
