"""
Tool Executor for Agent Runtime
==============================

Handles execution of tools during agent sessions.
"""

import asyncio
from pathlib import Path
from typing import Any


def _pick_arg(arguments: dict[str, Any], *names: str, default: Any = None) -> Any:
    """First non-empty value among alias ``names`` (case-insensitive).

    Local models are inconsistent about argument keys — e.g. a shell command may
    arrive as ``command``, ``cmd`` or ``shell_command``; a file's body as
    ``content``, ``Content``, ``CodeContent`` or ``text``. Matching a set of
    aliases (and ignoring case) makes the tools tolerant of those variants
    instead of failing with "X is required".
    """
    if not isinstance(arguments, dict):
        return default
    for name in names:  # exact match first
        value = arguments.get(name)
        if value is not None and value != "":
            return value
    lowered = {k.lower(): v for k, v in arguments.items() if isinstance(k, str)}
    for name in names:  # case-insensitive fallback
        value = lowered.get(name.lower())
        if value is not None and value != "":
            return value
    return default


class ToolExecutor:
    """Executes tools for agent sessions."""

    def __init__(self, project_dir: str):
        self.project_dir = Path(project_dir).resolve()

    def _resolve_within_project(self, path: str) -> Path:
        """Resolve a user-supplied path and reject anything outside project_dir.

        Why: agent-supplied paths can be relative ('../etc/passwd') or absolute
        ('/etc/passwd'). Without this guard, Path / userpath happily escapes
        the sandbox, since Path('/safe') / Path('/etc/x') -> Path('/etc/x').
        """
        candidate = (self.project_dir / path).resolve()
        try:
            candidate.relative_to(self.project_dir)
        except ValueError:
            raise ValueError(f"Path '{path}' is outside the project directory")
        return candidate

    async def execute(self, tool_name: str, arguments: dict[str, Any]) -> Any:
        """
        Execute a tool with the given arguments.

        Args:
            tool_name: Name of the tool to execute
            arguments: Arguments to pass to the tool

        Returns:
            Result of the tool execution
        """
        # Tool dispatch. Argument keys are resolved through alias sets so the
        # varied names local models emit (cmd/command, file_path/path,
        # content/Content/CodeContent, …) all map to the right parameter.
        path_aliases = ("path", "file_path", "filepath", "filename", "file")
        content_aliases = ("content", "CodeContent", "text", "data", "file_text")
        dir_aliases = ("directory", "dir", "folder", "path")
        cmd_aliases = ("command", "cmd", "shell_command", "script", "commandline")
        cwd_aliases = ("cwd", "working_directory", "directory", "dir")

        if tool_name == "read_file":
            return await self._read_file(_pick_arg(arguments, *path_aliases))
        elif tool_name in ("write_file", "Write"):  # "Write" = planner alias
            return await self._write_file(
                _pick_arg(arguments, *path_aliases),
                _pick_arg(arguments, *content_aliases),
                bool(
                    _pick_arg(
                        arguments, "EmptyFile", "empty_file", "empty", default=False
                    )
                ),
            )
        elif tool_name == "list_files":
            return await self._list_files(
                _pick_arg(arguments, *dir_aliases, default=".")
            )
        elif tool_name == "run_command":
            return await self._run_command(
                _pick_arg(arguments, *cmd_aliases),
                _pick_arg(arguments, *cwd_aliases),
            )
        elif tool_name == "create_directory":
            return await self._create_directory(_pick_arg(arguments, *dir_aliases))
        else:
            raise ValueError(f"Unknown tool: {tool_name}")

    async def _read_file(self, path: str | None) -> str:
        """Read a file and return its contents."""
        if not path:
            raise ValueError("Path is required for read_file")

        file_path = self._resolve_within_project(path)
        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {path}")

        try:
            with open(file_path, encoding="utf-8") as f:
                return f.read()
        except Exception as e:
            raise RuntimeError(f"Error reading file {path}: {e}")

    async def _write_file(
        self, path: str | None, content: str | None = None, empty_file: bool = False
    ) -> str:
        """Write content to a file."""
        if not path:
            raise ValueError("Path is required for write_file")

        file_path = self._resolve_within_project(path)
        file_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            with open(file_path, "w", encoding="utf-8") as f:
                if empty_file:
                    # Create empty file
                    pass
                elif content is not None:
                    f.write(content)
                else:
                    # Default content if none provided
                    f.write("")
            return f"Successfully wrote to {path}"
        except Exception as e:
            raise RuntimeError(f"Error writing file {path}: {e}")

    async def _list_files(self, directory: str) -> list[str]:
        """List files in a directory."""
        dir_path = self._resolve_within_project(directory)
        if not dir_path.exists():
            raise FileNotFoundError(f"Directory not found: {directory}")

        try:
            files = []
            for item in dir_path.iterdir():
                if item.is_file():
                    files.append(item.name)
                elif item.is_dir():
                    files.append(item.name + "/")
            return sorted(files)
        except Exception as e:
            raise RuntimeError(f"Error listing files in {directory}: {e}")

    async def _create_directory(self, path: str | None) -> str:
        """Create a directory (and parents)."""
        if not path:
            raise ValueError("Path is required for create_directory")

        dir_path = self._resolve_within_project(path)
        try:
            dir_path.mkdir(parents=True, exist_ok=True)
            return f"Successfully created directory {path}"
        except Exception as e:
            raise RuntimeError(f"Error creating directory {path}: {e}")

    async def _run_command(self, command: str | None, cwd: str | None = None) -> str:
        """Run a shell command.

        Note: uses subprocess shell mode intentionally so the agent can issue
        composite commands (pipes, redirections) needed by the prompt template.
        The cwd is constrained to project_dir; the command itself is not
        sanitized — callers must ensure the LLM is constrained by the system
        prompt and untrusted output is not relayed back into tool args.
        """
        if not command:
            raise ValueError("Command is required for run_command")

        work_dir = self._resolve_within_project(cwd) if cwd else self.project_dir

        try:
            process = await asyncio.create_subprocess_shell(
                command,
                cwd=str(work_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            stdout_bytes, stderr_bytes = await process.communicate()
            stdout = (
                stdout_bytes.decode("utf-8", errors="replace") if stdout_bytes else ""
            )
            stderr = (
                stderr_bytes.decode("utf-8", errors="replace") if stderr_bytes else ""
            )

            if process.returncode != 0:
                # Include both stdout and stderr: many tools (dotnet, msbuild,
                # npm, ...) write their diagnostics to stdout, not stderr.
                combined = ""
                if stdout:
                    combined += stdout
                if stderr:
                    combined += ("\n" if combined else "") + stderr

                # Exit code 1 with no output is the "no matches found" behavior
                # for search tools (findstr, grep, etc.). Return a clear message
                # so the agent knows the pattern was not found.
                if process.returncode == 1 and not combined.strip():
                    return "(no matches found)"

                raise RuntimeError(
                    f"Command failed with code {process.returncode}: {combined}"
                )

            return stdout
        except Exception as e:
            raise RuntimeError(f"Error running command {command}: {e}")


def get_tool_definitions(agent_type: str) -> list[dict[str, Any]]:
    """
    Get tool definitions for a specific agent type.

    Args:
        agent_type: Type of agent (e.g., 'coder', 'planner')

    Returns:
        List of tool definitions
    """
    # Basic tool definitions - can be extended based on agent type
    base_tools = [
        {
            "name": "read_file",
            "description": "Read the contents of a file",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file to read",
                    }
                },
                "required": ["path"],
            },
        },
        {
            "name": "write_file",
            "description": "Write content to a file",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file to write",
                    },
                    "content": {
                        "type": "string",
                        "description": "Content to write to the file",
                    },
                },
                "required": ["path", "content"],
            },
        },
        {
            "name": "list_files",
            "description": "List files in a directory",
            "parameters": {
                "type": "object",
                "properties": {
                    "directory": {
                        "type": "string",
                        "description": "Directory to list files from",
                        "default": ".",
                    }
                },
            },
        },
        {
            "name": "run_command",
            "description": "Run a shell command",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Command to run"},
                    "cwd": {
                        "type": "string",
                        "description": "Working directory for the command",
                    },
                },
                "required": ["command"],
            },
        },
    ]

    # Add agent-specific tools
    if agent_type == "coder":
        base_tools.extend(
            [
                {
                    "name": "create_directory",
                    "description": "Create a directory",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {
                                "type": "string",
                                "description": "Path to the directory to create",
                            }
                        },
                        "required": ["path"],
                    },
                }
            ]
        )
    elif agent_type in ("planner", "spec_writer"):
        # The spec pipeline runs the planner.md prompt under agent_type
        # "spec_writer" (see spec/pipeline/agent_runner.py). That prompt
        # repeatedly instructs the agent to "use the Write tool" to create
        # implementation_plan.json. Without exposing the "Write" tool here,
        # non-Claude providers (Copilot, Windsurf, ...) only see write_file and
        # never call the tool the prompt asks for, so the plan file is never
        # written and the planning phase fails with "Did not create plan file".
        base_tools.extend(
            [
                {
                    "name": "Write",
                    "description": "Write content to a file (for creating implementation_plan.json)",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "file_path": {
                                "type": "string",
                                "description": "Path to the file to write",
                            },
                            "CodeContent": {
                                "type": "string",
                                "description": "Content to write to the file",
                            },
                            "EmptyFile": {
                                "type": "boolean",
                                "description": "Whether to create an empty file",
                                "default": False,
                            },
                        },
                        "required": ["file_path", "CodeContent", "EmptyFile"],
                    },
                },
                {
                    "name": "analyze_project",
                    "description": "Analyze the project structure",
                    "parameters": {"type": "object", "properties": {}},
                },
            ]
        )

    return base_tools
