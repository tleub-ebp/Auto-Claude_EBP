#!/usr/bin/env python3
"""
Pipeline Generator Runner
=========================

AI-powered CI/CD pipeline generation for any project.

Analyzes the project stack (languages, frameworks, package managers, test runners,
Dockerfiles, existing CI configs) and generates complete, production-ready pipeline
YAML files for GitHub Actions, GitLab CI, or CircleCI in seconds.

Usage:
    python runners/pipeline_generator_runner.py --project /path/to/project
    python runners/pipeline_generator_runner.py --project /path/to/project --platforms github,gitlab
    python runners/pipeline_generator_runner.py --project /path/to/project --refresh
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

# Add the apps/backend directory to the Python path
backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

# Validate platform-specific dependencies
from core.dependency_validator import validate_platform_dependencies

validate_platform_dependencies()

# Load .env file
from cli.utils import import_dotenv

load_dotenv = import_dotenv()
env_file = Path(__file__).parent.parent.parent.parent / ".env-files" / ".env"
if env_file.exists():
    load_dotenv(env_file)

from core.client import create_client
from core.workflow_logger import workflow_logger

SUPPORTED_PLATFORMS = ["github", "gitlab", "circleci"]

PLATFORM_LABELS = {
    "github": "GitHub Actions",
    "gitlab": "GitLab CI/CD",
    "circleci": "CircleCI",
}

PLATFORM_OUTPUT_FILES = {
    "github": ".github/workflows/ci.yml",
    "gitlab": ".gitlab-ci.yml",
    "circleci": ".circleci/config.yml",
}


def detect_project_stack(project_dir: Path) -> dict:
    """Detect tech stack, test runners, and existing CI configs."""
    stack = {
        "languages": [],
        "package_managers": [],
        "frameworks": [],
        "test_runners": [],
        "has_docker": False,
        "has_docker_compose": False,
        "existing_ci": [],
        "build_scripts": [],
    }

    # Language/framework detection
    if (project_dir / "package.json").exists():
        stack["languages"].append("javascript/typescript")
        stack["package_managers"].append("npm")
        try:
            pkg = json.loads((project_dir / "package.json").read_text(encoding="utf-8"))
            scripts = pkg.get("scripts", {})
            if "test" in scripts:
                stack["test_runners"].append(scripts["test"])
            if "build" in scripts:
                stack["build_scripts"].append(scripts["build"])
            deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
            if "react" in deps:
                stack["frameworks"].append("react")
            if "next" in deps:
                stack["frameworks"].append("nextjs")
            if "vue" in deps:
                stack["frameworks"].append("vue")
            if "jest" in deps:
                stack["test_runners"].append("jest")
            if "vitest" in deps:
                stack["test_runners"].append("vitest")
            if "playwright" in deps or "@playwright/test" in deps:
                stack["test_runners"].append("playwright")
            if "pnpm" in deps or (project_dir / "pnpm-lock.yaml").exists():
                stack["package_managers"].append("pnpm")
            if (project_dir / "yarn.lock").exists():
                stack["package_managers"].append("yarn")
        except Exception:
            pass

    if (project_dir / "requirements.txt").exists() or (
        project_dir / "pyproject.toml"
    ).exists():
        stack["languages"].append("python")
        if (project_dir / "pyproject.toml").exists():
            stack["package_managers"].append("uv/poetry/pip")
        else:
            stack["package_managers"].append("pip")

    if (project_dir / "Cargo.toml").exists():
        stack["languages"].append("rust")
        stack["package_managers"].append("cargo")

    # .NET. Project files can sit in subdirectories next to a solution at the
    # root, which is the usual layout, so a root-only check misses most repos.
    dotnet_projects = (
        list(project_dir.glob("*.sln")) or list(project_dir.glob("**/*.csproj"))[:50]
    )
    if dotnet_projects:
        stack["languages"].append("c#")
        stack["package_managers"].append("nuget")
        stack["test_runners"].append("dotnet test")

    if (project_dir / "go.mod").exists():
        stack["languages"].append("go")
        stack["package_managers"].append("go mod")

    if (project_dir / "pom.xml").exists():
        stack["languages"].append("java/kotlin")
        stack["package_managers"].append("maven")

    if (project_dir / "build.gradle").exists() or (
        project_dir / "build.gradle.kts"
    ).exists():
        stack["languages"].append("java/kotlin")
        stack["package_managers"].append("gradle")

    # Docker
    if (project_dir / "Dockerfile").exists():
        stack["has_docker"] = True
    if (project_dir / "docker-compose.yml").exists() or (
        project_dir / "docker-compose.yaml"
    ).exists():
        stack["has_docker_compose"] = True

    # Existing CI configs
    if (project_dir / ".github" / "workflows").exists():
        stack["existing_ci"].append("github_actions")
    if (project_dir / ".gitlab-ci.yml").exists():
        stack["existing_ci"].append("gitlab_ci")
    if (project_dir / ".circleci" / "config.yml").exists():
        stack["existing_ci"].append("circleci")

    # Deduplicate
    for key in ["languages", "package_managers", "frameworks", "test_runners"]:
        stack[key] = list(set(stack[key]))

    return stack


def build_generation_prompt(project_dir: Path, stack: dict, platforms: list) -> str:
    """Build the AI prompt for pipeline generation."""
    stack_summary = json.dumps(stack, indent=2)
    platforms_str = ", ".join(PLATFORM_LABELS[p] for p in platforms)

    return f"""You are an expert DevOps engineer. Generate complete, production-ready CI/CD pipeline configurations for the following project.

## Project Analysis

Project directory: {project_dir}
Target platforms: {platforms_str}

## Detected Stack

```json
{stack_summary}
```

## Instructions

Generate a complete CI/CD pipeline for each requested platform. Each pipeline must include:

1. **Build stage** — Install dependencies and build the project
2. **Test stage** — Run all detected test suites with proper commands
3. **Lint/Type-check stage** — Static analysis if applicable
4. **Docker build stage** — If Dockerfile detected, build and tag the image
5. **Deploy stage** — Template deploy stage (placeholder with comments)

For each platform, output in this EXACT format:
```
__PIPELINE_START__:<platform_id>
<complete yaml content here>
__PIPELINE_END__:<platform_id>
```

Where <platform_id> is one of: github, gitlab, circleci

Important rules:
- Use the correct YAML syntax for each platform
- Add caching for dependencies (node_modules, pip cache, cargo registry, etc.)
- Use matrix builds if multiple Node/Python versions make sense
- Add branch protection: run full pipeline on main/master, lighter on feature branches
- Include environment variable placeholders for secrets (use ${{ secrets.X }} syntax)
- Add job dependencies properly (test depends on build, deploy depends on test)
- For GitHub Actions: use ubuntu-latest runners
- For GitLab CI: use appropriate Docker images
- For CircleCI: use appropriate orbs or Docker executors
- Add comments explaining key decisions
- Make the pipeline production-ready, not a toy example

Generate the pipelines now:"""


async def generate_pipelines(
    project_dir: Path,
    platforms: list,
    output_dir: Path,
    model: str = "sonnet",
    thinking_level: str = "medium",
    refresh: bool = False,
) -> dict:
    """Core pipeline generation logic using Claude SDK."""

    print(f"🔍 Analyzing project at: {project_dir}")
    stack = detect_project_stack(project_dir)

    print(f"📦 Detected stack: {stack['languages'] or ['unknown']}")
    if stack["frameworks"]:
        print(f"🏗️  Frameworks: {stack['frameworks']}")
    if stack["has_docker"]:
        print("🐳 Dockerfile detected")

    # Check if pipelines already exist and refresh not requested
    existing_outputs = {}
    for platform in platforms:
        out_file = output_dir / f"pipeline_{platform}.yml"
        if out_file.exists() and not refresh:
            existing_outputs[platform] = out_file.read_text(encoding="utf-8")
            print(
                f"✅ {PLATFORM_LABELS[platform]} pipeline already exists (use --refresh to regenerate)"
            )

    platforms_to_generate = [p for p in platforms if p not in existing_outputs]

    results = {**{p: existing_outputs[p] for p in existing_outputs}}

    if not platforms_to_generate:
        return {"status": "success", "pipelines": results, "stack": stack}

    print(
        f"\n🤖 Generating pipelines for: {', '.join(PLATFORM_LABELS[p] for p in platforms_to_generate)}"
    )
    print("   This may take 30–60 seconds...\n")

    trace_id = workflow_logger.log_agent_start(
        "PipelineGenerator",
        "generate_pipelines",
        {"project": str(project_dir), "platforms": platforms_to_generate},
    )

    try:
        prompt = build_generation_prompt(project_dir, stack, platforms_to_generate)

        client = create_client(
            project_dir=project_dir,
            model=model,
            agent_type="coder",
        )
        async with client:
            from core.session import run_agent_session

            _, response_text = await run_agent_session(client, prompt, None)

        # Parse the response to extract each platform's pipeline
        for platform in platforms_to_generate:
            start_marker = f"__PIPELINE_START__:{platform}"
            end_marker = f"__PIPELINE_END__:{platform}"

            start_idx = response_text.find(start_marker)
            end_idx = response_text.find(end_marker)

            if start_idx != -1 and end_idx != -1:
                yaml_content = response_text[
                    start_idx + len(start_marker) : end_idx
                ].strip()
                # Strip markdown code fences if present
                if yaml_content.startswith("```"):
                    lines = yaml_content.split("\n")
                    yaml_content = "\n".join(lines[1:])
                if yaml_content.endswith("```"):
                    yaml_content = yaml_content[:-3].rstrip()

                results[platform] = yaml_content
                print(
                    f"✅ {PLATFORM_LABELS[platform]} pipeline generated ({len(yaml_content)} chars)"
                )
            else:
                print(
                    f"⚠️  Could not extract {PLATFORM_LABELS[platform]} pipeline from response"
                )

        workflow_logger.log_agent_end(
            "PipelineGenerator",
            "success",
            {"platforms_generated": list(results.keys())},
            trace_id=trace_id,
        )

        return {"status": "success", "pipelines": results, "stack": stack}

    except Exception as e:
        workflow_logger.log_agent_end(
            "PipelineGenerator",
            "error",
            {"error": str(e)},
            trace_id=trace_id,
        )
        return {
            "status": "error",
            "error": str(e),
            "pipelines": results,
            "stack": stack,
        }


def save_pipelines(
    pipelines: dict, output_dir: Path, project_dir: Path, write_to_project: bool = False
) -> dict:
    """Save generated pipelines to the output directory (and optionally to the project)."""
    output_dir.mkdir(parents=True, exist_ok=True)
    saved_files = {}

    for platform, content in pipelines.items():
        if not content:
            continue

        # Save to output directory
        out_file = output_dir / f"pipeline_{platform}.yml"
        out_file.write_text(content, encoding="utf-8")
        saved_files[platform] = str(out_file)
        print(f"💾 Saved: {out_file}")

        # Optionally write to project's actual CI config location
        if write_to_project:
            project_ci_path = project_dir / PLATFORM_OUTPUT_FILES[platform]
            project_ci_path.parent.mkdir(parents=True, exist_ok=True)
            project_ci_path.write_text(content, encoding="utf-8")
            print(f"📄 Written to project: {project_ci_path}")

    return saved_files


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="AI-powered CI/CD pipeline generator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--project",
        type=Path,
        default=Path.cwd(),
        help="Project directory (default: current directory)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Output directory for generated pipelines (default: project/.workpilot/pipelines/)",
    )
    parser.add_argument(
        "--platforms",
        type=str,
        default="github,gitlab",
        help=f"Comma-separated CI/CD platforms to generate for (options: {','.join(SUPPORTED_PLATFORMS)})",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="sonnet",
        help="Model to use (haiku, sonnet, opus, or full model ID)",
    )
    parser.add_argument(
        "--thinking-level",
        type=str,
        default="medium",
        choices=["none", "low", "medium", "high"],
        help="Thinking level for extended reasoning (default: medium)",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Force regeneration even if pipelines already exist",
    )
    parser.add_argument(
        "--write-to-project",
        action="store_true",
        help="Also write pipelines to the project's actual CI config locations",
    )

    args = parser.parse_args()

    project_dir = args.project.resolve()
    if not project_dir.exists():
        print(f"Error: Project directory does not exist: {project_dir}")
        sys.exit(1)

    # Parse platforms
    platforms = [p.strip().lower() for p in args.platforms.split(",")]
    invalid = [p for p in platforms if p not in SUPPORTED_PLATFORMS]
    if invalid:
        print(f"Error: Invalid platforms: {invalid}")
        print(f"Valid platforms: {SUPPORTED_PLATFORMS}")
        sys.exit(1)

    output_dir = args.output or project_dir / ".workpilot" / "pipelines"

    try:
        result = asyncio.run(
            generate_pipelines(
                project_dir=project_dir,
                platforms=platforms,
                output_dir=output_dir,
                model=args.model,
                thinking_level=args.thinking_level,
                refresh=args.refresh,
            )
        )

        if result["status"] != "success":
            print(
                f"\n❌ Pipeline generation failed: {result.get('error', 'Unknown error')}"
            )
            sys.exit(1)

        saved = save_pipelines(
            result["pipelines"],
            output_dir=output_dir,
            project_dir=project_dir,
            write_to_project=args.write_to_project,
        )

        # Output structured result for the Electron frontend
        output = {
            "status": "success",
            "pipelines": result["pipelines"],
            "saved_files": saved,
            "stack": result["stack"],
            "platforms_generated": list(result["pipelines"].keys()),
        }
        print("__PIPELINE_GENERATOR_RESULT__:" + json.dumps(output))

        print(f"\n✅ Done! Generated {len(result['pipelines'])} pipeline(s).")
        sys.exit(0)

    except KeyboardInterrupt:
        print("\n\nPipeline generation interrupted.")
        sys.exit(1)


if __name__ == "__main__":
    main()
