---
name: framework-migration
description: Automate framework migrations with dependency resolution, breaking-change auto-fix, and rollback. Use for framework upgrades (React, Express), version updates, JS→TS, or build-tool/stack changes. For Angular-specific upgrades, use the angular-development skill.
triggers: ["migration", "framework upgrade", "version update", "technology change", "stack migration"]
category: development
version: "1.0.0"
author: "WorkPilot AI Team"
---

# Framework Migration Skill

## Quick Actions
- **Analyze stack**: Run `analyze_stack.py` to detect current technology stack
- **Create plan**: Generate step-by-step migration plan with breaking changes
- **Execute migration**: Run transformations with automatic rollback support
- **Validate results**: Run regression tests to ensure migration success

## Supported Frameworks
- **React**: 18→19 (ReactDOM.render → createRoot, automatic batching)
- **Angular**: 15→16, 16→17, 17→18, 18→19 (standalone components, signals, zoneless apps)
- **Express**: 4→5 (req.query behavior changes, improved security)
- **JavaScript→TypeScript**: Full type migration with tsconfig generation
- **Build Tools**: Webpack→Vite, custom build systems

## Key Features
- Automatic stack detection and dependency analysis
- Breaking changes database with auto-fix capabilities
- Step-by-step migration plans with risk assessment
- Automated code transformations and rollback support
- Regression test generation and validation

## Resources
- **Scripts**: `analyze_stack.py`, `execute_migration.py`
- **Data**: `breaking_changes.json` (known breaking changes database)
- **Templates**: `migration_plan.md` (migration plan template)

## Usage Examples

### Basic Migration
```python
# Analyze current stack
analysis = skill.execute_script("analyze_stack.py", {"project_root": "/path/to/project"})

# Create migration plan
plan = skill.create_migration_plan(
    source_framework="react",
    source_version="18.2", 
    target_version="19.0"
)

# Execute migration
result = skill.execute_script("execute_migration.py", {"plan_id": plan.plan_id})
```

## Error Handling & Recovery
- Automatic rollback on critical failures
- Partial migration recovery points
- Manual intervention guidance with detailed error reporting

## Integration Notes
Works well with code-review, testing, and documentation skills for comprehensive migration workflows.
