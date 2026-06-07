"""Task Dependency Graph — Visualize and manage task dependencies as a DAG.

Provides a directed acyclic graph (DAG) of tasks and their dependencies,
critical path identification, cycle detection, topological sorting, and
data export compatible with reactflow for the frontend visualization.

Feature 9.2 — Vue graphe des dépendances de tâches.

Example:
    >>> from apps.backend.scheduling.task_dependency_graph import TaskDependencyGraph
    >>> graph = TaskDependencyGraph()
    >>> graph.add_task("task-1", "Design API", status="completed")
    >>> graph.add_task("task-2", "Implement API", status="in_progress")
    >>> graph.add_dependency("task-2", "task-1")
    >>> critical = graph.get_critical_path()
    >>> export = graph.export_reactflow()
"""

import logging
import uuid
from collections import defaultdict, deque
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class TaskNodeStatus(str, Enum):
    """Status of a task in the graph."""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    BLOCKED = "blocked"
    FAILED = "failed"
    CANCELLED = "cancelled"


class DependencyType(str, Enum):
    """Type of dependency between tasks."""

    BLOCKS = "blocks"
    DEPENDS_ON = "depends_on"
    RELATED = "related"


class GraphLayout(str, Enum):
    """Layout algorithm for graph visualization."""

    DAGRE = "dagre"
    FORCE = "force"
    TREE = "tree"
    LAYERED = "layered"


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass
class TaskNode:
    """A task represented as a node in the dependency graph."""

    task_id: str = ""
    title: str = ""
    status: str = "pending"
    priority: int = 5
    estimated_hours: float = 0.0
    actual_hours: float = 0.0
    assignee: str = ""
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def is_completed(self) -> bool:
        return self.status in (
            TaskNodeStatus.COMPLETED.value,
            TaskNodeStatus.CANCELLED.value,
        )


@dataclass
class DependencyEdge:
    """A directed edge representing a dependency between two tasks."""

    edge_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    source_id: str = ""
    target_id: str = ""
    dependency_type: str = "depends_on"
    label: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CriticalPath:
    """Result of critical path analysis."""

    path: list[str] = field(default_factory=list)
    total_estimated_hours: float = 0.0
    total_actual_hours: float = 0.0
    bottleneck_task_id: str | None = None
    completed_pct: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class GraphAnalysis:
    """Complete analysis of the task dependency graph."""

    total_tasks: int = 0
    total_edges: int = 0
    tasks_by_status: dict[str, int] = field(default_factory=dict)
    blocked_tasks: list[str] = field(default_factory=list)
    root_tasks: list[str] = field(default_factory=list)
    leaf_tasks: list[str] = field(default_factory=list)
    critical_path: CriticalPath | None = None
    has_cycles: bool = False
    longest_chain: int = 0
    parallelizable_groups: list[list[str]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        if self.critical_path:
            result["critical_path"] = self.critical_path.to_dict()
        return result


# ---------------------------------------------------------------------------
# Main class
# ---------------------------------------------------------------------------


class TaskDependencyGraph:
    """Directed acyclic graph of task dependencies.

    Manages tasks as nodes and their dependencies as directed edges.
    Provides topological sorting, critical path analysis, cycle detection,
    blocking analysis, and export to reactflow format for UI rendering.
    """

    def __init__(self) -> None:
        self._nodes: dict[str, TaskNode] = {}
        self._edges: dict[str, DependencyEdge] = {}
        # Adjacency: task_id -> list of task_ids it depends on
        self._dependencies: dict[str, set[str]] = defaultdict(set)
        # Reverse adjacency: task_id -> list of task_ids that depend on it
        self._dependents: dict[str, set[str]] = defaultdict(set)

    # -- Task CRUD -----------------------------------------------------------

    def add_task(
        self,
        task_id: str,
        title: str,
        status: str = "pending",
        priority: int = 5,
        estimated_hours: float = 0.0,
        assignee: str = "",
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> TaskNode:
        """Add a task node to the graph."""
        if task_id in self._nodes:
            raise ValueError(f"Task '{task_id}' already exists in the graph")
        node = TaskNode(
            task_id=task_id,
            title=title,
            status=status,
            priority=priority,
            estimated_hours=estimated_hours,
            assignee=assignee,
            tags=tags or [],
            metadata=metadata or {},
        )
        self._nodes[task_id] = node
        return node

    def update_task(self, task_id: str, **kwargs: Any) -> TaskNode:
        """Update a task node's properties."""
        node = self._get_node(task_id)
        for key, value in kwargs.items():
            if hasattr(node, key):
                setattr(node, key, value)
        self._refresh_blocked_status()
        return node

    def remove_task(self, task_id: str) -> None:
        """Remove a task and all its edges from the graph."""
        self._get_node(task_id)
        # Remove all edges involving this task
        edges_to_remove = [
            eid
            for eid, e in self._edges.items()
            if e.source_id == task_id or e.target_id == task_id
        ]
        for eid in edges_to_remove:
            edge = self._edges.pop(eid)
            self._dependencies[edge.source_id].discard(edge.target_id)
            self._dependents[edge.target_id].discard(edge.source_id)

        self._dependencies.pop(task_id, None)
        self._dependents.pop(task_id, None)
        del self._nodes[task_id]

    def get_task(self, task_id: str) -> TaskNode:
        """Get a task node by ID."""
        return self._get_node(task_id)

    def list_tasks(self, status: str | None = None) -> list[TaskNode]:
        """List all tasks, optionally filtered by status."""
        nodes = list(self._nodes.values())
        if status:
            nodes = [n for n in nodes if n.status == status]
        return nodes

    # -- Dependency management -----------------------------------------------

    def add_dependency(
        self,
        task_id: str,
        depends_on_id: str,
        dependency_type: str = "depends_on",
        label: str = "",
    ) -> DependencyEdge:
        """Add a dependency: task_id depends on depends_on_id.

        Returns the created edge. Raises ValueError on cycle detection.
        """
        self._get_node(task_id)
        self._get_node(depends_on_id)

        if task_id == depends_on_id:
            raise ValueError("A task cannot depend on itself")

        # Check for cycle
        self._dependencies[task_id].add(depends_on_id)
        self._dependents[depends_on_id].add(task_id)
        if self._has_cycle():
            self._dependencies[task_id].discard(depends_on_id)
            self._dependents[depends_on_id].discard(task_id)
            raise ValueError(
                f"Adding dependency {task_id} -> {depends_on_id} would create a cycle"
            )

        edge = DependencyEdge(
            source_id=task_id,
            target_id=depends_on_id,
            dependency_type=dependency_type,
            label=label,
        )
        self._edges[edge.edge_id] = edge
        self._refresh_blocked_status()
        return edge

    def remove_dependency(self, task_id: str, depends_on_id: str) -> None:
        """Remove a dependency between two tasks."""
        self._dependencies[task_id].discard(depends_on_id)
        self._dependents[depends_on_id].discard(task_id)
        edges_to_remove = [
            eid
            for eid, e in self._edges.items()
            if e.source_id == task_id and e.target_id == depends_on_id
        ]
        for eid in edges_to_remove:
            del self._edges[eid]
        self._refresh_blocked_status()

    def get_dependencies(self, task_id: str) -> list[str]:
        """Get the list of task IDs that this task depends on."""
        self._get_node(task_id)
        return list(self._dependencies.get(task_id, set()))

    def get_dependents(self, task_id: str) -> list[str]:
        """Get the list of task IDs that depend on this task."""
        self._get_node(task_id)
        return list(self._dependents.get(task_id, set()))

    def get_edges(self) -> list[DependencyEdge]:
        """Get all edges."""
        return list(self._edges.values())

    # -- Graph analysis ------------------------------------------------------

    def topological_sort(self) -> list[str]:
        """Return tasks in topological order (dependencies first).

        Raises ValueError if the graph contains cycles.
        """
        if self._has_cycle():
            raise ValueError("Graph contains cycles — topological sort impossible")

        in_degree: dict[str, int] = dict.fromkeys(self._nodes, 0)
        for tid, deps in self._dependencies.items():
            in_degree.setdefault(tid, 0)
            for dep in deps:
                in_degree.setdefault(dep, 0)

        # For each edge (source depends on target), target must come first
        for tid, deps in self._dependencies.items():
            in_degree[tid] = len(deps)

        queue = deque(tid for tid, deg in in_degree.items() if deg == 0)
        result: list[str] = []

        while queue:
            tid = queue.popleft()
            result.append(tid)
            for dependent in self._dependents.get(tid, set()):
                in_degree[dependent] -= 1
                if in_degree[dependent] == 0:
                    queue.append(dependent)

        return result

    def detect_cycles(self) -> list[list[str]]:
        """Detect all cycles in the graph. Returns a list of cycle paths.

        Iterative DFS with an explicit stack — the recursive form blew the
        default 1000-frame Python recursion limit on graphs with thousands
        of nodes (RecursionError aborted cycle detection entirely on large
        spec hierarchies).
        """
        cycles: list[list[str]] = []
        visited: set[str] = set()

        # Each stack frame: (node, iterator over its dependents). When the
        # iterator is exhausted we pop, mirroring recursion.
        for start in list(self._nodes):
            if start in visited:
                continue
            rec_stack: set[str] = set()
            path: list[str] = []
            stack: list[tuple[str, Any]] = [
                (start, iter(self._dependents.get(start, set())))
            ]
            visited.add(start)
            rec_stack.add(start)
            path.append(start)

            while stack:
                node, it = stack[-1]
                try:
                    dep = next(it)
                except StopIteration:
                    stack.pop()
                    rec_stack.discard(node)
                    if path:
                        path.pop()
                    continue

                if dep not in visited:
                    visited.add(dep)
                    rec_stack.add(dep)
                    path.append(dep)
                    stack.append((dep, iter(self._dependents.get(dep, set()))))
                elif dep in rec_stack:
                    cycle_start = path.index(dep)
                    cycles.append(path[cycle_start:] + [dep])

        return cycles

    def get_critical_path(self) -> CriticalPath:
        """Identify the critical path (longest weighted path through the DAG).

        DP definition: `dist[tid]` is the total estimated_hours of the
        longest path that ENDS at `tid` (inclusive of tid's own hours).
        Computed by `dist[tid] = tid.hours + max(dist[d] for d in deps)`.
        Previously the code used a "distance to enter" semantic and added
        the leaf's hours back when picking end_node, which selected the
        wrong end node on multi-branch graphs.
        """
        if not self._nodes:
            return CriticalPath()

        topo = self.topological_sort()

        dist: dict[str, float] = {}
        parent: dict[str, str | None] = {}

        for tid in topo:
            node = self._nodes[tid]
            deps = self._dependencies.get(tid, set())
            best_dep_dist = 0.0
            best_parent: str | None = None
            for dep_id in deps:
                d = dist.get(dep_id, 0.0)
                if d > best_dep_dist:
                    best_dep_dist = d
                    best_parent = dep_id
            dist[tid] = best_dep_dist + node.estimated_hours
            parent[tid] = best_parent

        if not dist:
            return CriticalPath()
        end_node = max(dist, key=dist.get)

        # Reconstruct path
        path: list[str] = [end_node]
        current = end_node
        while parent.get(current):
            current = parent[current]
            path.append(current)
        path.reverse()

        total_estimated = sum(self._nodes[tid].estimated_hours for tid in path)
        total_actual = sum(self._nodes[tid].actual_hours for tid in path)
        completed_count = sum(1 for tid in path if self._nodes[tid].is_completed)
        completed_pct = (completed_count / len(path) * 100) if path else 0.0

        # Bottleneck = task with highest estimated hours on critical path
        bottleneck = (
            max(path, key=lambda tid: self._nodes[tid].estimated_hours)
            if path
            else None
        )

        return CriticalPath(
            path=path,
            total_estimated_hours=total_estimated,
            total_actual_hours=total_actual,
            bottleneck_task_id=bottleneck,
            completed_pct=completed_pct,
        )

    def get_blocked_tasks(self) -> list[str]:
        """Return task IDs that are blocked by incomplete dependencies."""
        blocked: list[str] = []
        for tid, deps in self._dependencies.items():
            node = self._nodes.get(tid)
            if not node or node.is_completed:
                continue
            for dep_id in deps:
                dep_node = self._nodes.get(dep_id)
                if dep_node and not dep_node.is_completed:
                    blocked.append(tid)
                    break
        return blocked

    def get_ready_tasks(self) -> list[str]:
        """Return task IDs that have all dependencies met and are not completed."""
        ready: list[str] = []
        for tid, node in self._nodes.items():
            if node.is_completed:
                continue
            deps = self._dependencies.get(tid, set())
            all_met = all(
                self._nodes.get(d) and self._nodes[d].is_completed for d in deps
            )
            if all_met:
                ready.append(tid)
        return ready

    def get_root_tasks(self) -> list[str]:
        """Return tasks with no dependencies (entry points)."""
        return [tid for tid in self._nodes if not self._dependencies.get(tid)]

    def get_leaf_tasks(self) -> list[str]:
        """Return tasks with no dependents (endpoints)."""
        return [tid for tid in self._nodes if not self._dependents.get(tid)]

    def get_parallelizable_groups(self) -> list[list[str]]:
        """Return groups of tasks that can be executed in parallel (same topological level)."""
        if not self._nodes:
            return []

        levels: dict[str, int] = {}
        topo = self.topological_sort()

        for tid in topo:
            deps = self._dependencies.get(tid, set())
            if not deps:
                levels[tid] = 0
            else:
                levels[tid] = max(levels.get(d, 0) for d in deps) + 1

        groups: dict[int, list[str]] = defaultdict(list)
        for tid, level in levels.items():
            groups[level].append(tid)

        return [groups[level] for level in sorted(groups.keys())]

    def analyze(self) -> GraphAnalysis:
        """Produce a complete analysis of the graph."""
        status_counts: dict[str, int] = {}
        for node in self._nodes.values():
            status_counts[node.status] = status_counts.get(node.status, 0) + 1

        # Longest chain
        topo = self.topological_sort() if not self._has_cycle() else []
        longest = 0
        chain_len: dict[str, int] = {}
        for tid in topo:
            deps = self._dependencies.get(tid, set())
            if not deps:
                chain_len[tid] = 1
            else:
                chain_len[tid] = max(chain_len.get(d, 1) for d in deps) + 1
            longest = max(longest, chain_len[tid])

        return GraphAnalysis(
            total_tasks=len(self._nodes),
            total_edges=len(self._edges),
            tasks_by_status=status_counts,
            blocked_tasks=self.get_blocked_tasks(),
            root_tasks=self.get_root_tasks(),
            leaf_tasks=self.get_leaf_tasks(),
            critical_path=self.get_critical_path(),
            has_cycles=self._has_cycle(),
            longest_chain=longest,
            parallelizable_groups=self.get_parallelizable_groups(),
        )

    # -- Export for UI -------------------------------------------------------

    def export_reactflow(self, layout: str = "dagre") -> dict[str, Any]:
        """Export the graph in reactflow-compatible format for frontend rendering.

        Returns a dict with 'nodes' and 'edges' arrays ready for reactflow.
        """
        status_colors = {
            "pending": "#94a3b8",
            "in_progress": "#3b82f6",
            "completed": "#22c55e",
            "blocked": "#ef4444",
            "failed": "#dc2626",
            "cancelled": "#6b7280",
        }

        rf_nodes = []
        positions = self._compute_positions(layout)

        for tid, node in self._nodes.items():
            pos = positions.get(tid, {"x": 0, "y": 0})
            rf_nodes.append(
                {
                    "id": tid,
                    "type": "taskNode",
                    "position": pos,
                    "data": {
                        "label": node.title,
                        "status": node.status,
                        "priority": node.priority,
                        "assignee": node.assignee,
                        "estimatedHours": node.estimated_hours,
                        "tags": node.tags,
                        "color": status_colors.get(node.status, "#94a3b8"),
                        "isBlocked": tid in self.get_blocked_tasks(),
                        "isReady": tid in self.get_ready_tasks(),
                    },
                }
            )

        rf_edges = []
        for edge in self._edges.values():
            rf_edges.append(
                {
                    "id": edge.edge_id,
                    "source": edge.target_id,
                    "target": edge.source_id,
                    "type": "smoothstep",
                    "animated": self._nodes.get(edge.target_id, TaskNode()).status
                    == "in_progress",
                    "label": edge.label,
                    "style": {"stroke": "#64748b"},
                    "data": {
                        "dependencyType": edge.dependency_type,
                    },
                }
            )

        return {
            "nodes": rf_nodes,
            "edges": rf_edges,
            "layout": layout,
        }

    def export_mermaid(self) -> str:
        """Export the graph as a Mermaid diagram string."""
        lines = ["graph TD"]
        status_styles = {
            "completed": ":::completed",
            "in_progress": ":::inprogress",
            "failed": ":::failed",
            "blocked": ":::blocked",
        }

        for tid, node in self._nodes.items():
            safe_id = tid.replace("-", "_")
            style = status_styles.get(node.status, "")
            lines.append(f'    {safe_id}["{node.title}"){style}')

        for edge in self._edges.values():
            src = edge.source_id.replace("-", "_")
            tgt = edge.target_id.replace("-", "_")
            label = f"|{edge.label}|" if edge.label else ""
            lines.append(f"    {tgt} -->{label} {src}")

        lines.append("")
        lines.append("    classDef completed fill:#22c55e,color:#fff")
        lines.append("    classDef inprogress fill:#3b82f6,color:#fff")
        lines.append("    classDef failed fill:#dc2626,color:#fff")
        lines.append("    classDef blocked fill:#ef4444,color:#fff")

        return "\n".join(lines)

    def get_stats(self) -> dict[str, Any]:
        """Global graph statistics."""
        analysis = self.analyze()
        return {
            "total_tasks": analysis.total_tasks,
            "total_edges": analysis.total_edges,
            "tasks_by_status": analysis.tasks_by_status,
            "blocked_count": len(analysis.blocked_tasks),
            "ready_count": len(self.get_ready_tasks()),
            "root_count": len(analysis.root_tasks),
            "leaf_count": len(analysis.leaf_tasks),
            "has_cycles": analysis.has_cycles,
            "longest_chain": analysis.longest_chain,
            "critical_path_length": len(analysis.critical_path.path)
            if analysis.critical_path
            else 0,
            "parallelizable_groups_count": len(analysis.parallelizable_groups),
        }

    # -- Internal helpers ----------------------------------------------------

    def _get_node(self, task_id: str) -> TaskNode:
        if task_id not in self._nodes:
            raise KeyError(f"Task '{task_id}' not found in graph")
        return self._nodes[task_id]

    def _has_cycle(self) -> bool:
        """Detect if the graph has any cycles using DFS."""
        visited: set[str] = set()
        rec_stack: set[str] = set()

        def _dfs(node: str) -> bool:
            visited.add(node)
            rec_stack.add(node)
            for dep in self._dependents.get(node, set()):
                if dep not in visited:
                    if _dfs(dep):
                        return True
                elif dep in rec_stack:
                    return True
            rec_stack.discard(node)
            return False

        for tid in self._nodes:
            if tid not in visited:
                if _dfs(tid):
                    return True
        return False

    def _refresh_blocked_status(self) -> None:
        """Refresh the 'blocked' status for all tasks."""
        blocked_ids = set(self.get_blocked_tasks())
        for tid, node in self._nodes.items():
            if node.status in (
                TaskNodeStatus.COMPLETED.value,
                TaskNodeStatus.CANCELLED.value,
                TaskNodeStatus.FAILED.value,
            ):
                continue
            if tid in blocked_ids and node.status != TaskNodeStatus.BLOCKED.value:
                node.status = TaskNodeStatus.BLOCKED.value
            elif tid not in blocked_ids and node.status == TaskNodeStatus.BLOCKED.value:
                node.status = TaskNodeStatus.PENDING.value

    def _compute_positions(self, layout: str) -> dict[str, dict[str, float]]:
        """Compute node positions for reactflow layout."""
        positions: dict[str, dict[str, float]] = {}
        groups = self.get_parallelizable_groups()

        x_spacing = 250
        y_spacing = 100

        for level_idx, group in enumerate(groups):
            for node_idx, tid in enumerate(group):
                positions[tid] = {
                    "x": float(level_idx * x_spacing),
                    "y": float(node_idx * y_spacing),
                }

        # Position any orphan nodes not in groups
        for tid in self._nodes:
            if tid not in positions:
                positions[tid] = {"x": 0.0, "y": float(len(positions) * y_spacing)}

        return positions
