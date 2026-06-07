"""Advanced Local Model Manager — Enhanced Ollama/LM Studio support.

Extends the existing ollama_model_detector.py with advanced features:
auto-detection, benchmarking, GPU/RAM monitoring, model recommendations,
and hybrid mode (local draft → cloud validation).

Feature 6.2 — Support des modèles locaux avancé.

Example:
    >>> from apps.backend.scheduling.local_model_manager import LocalModelManager
    >>> manager = LocalModelManager()
    >>> status = manager.detect_runtime()
    >>> models = manager.list_models()
    >>> benchmark = manager.benchmark_model("llama3:8b")
"""

import json
import logging
import platform
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_LMSTUDIO_URL = "http://localhost:1234"

# Known model capabilities for recommendation engine
KNOWN_MODELS: dict[str, dict[str, Any]] = {
    "llama3:8b": {
        "params": "8B",
        "ram_gb": 5.0,
        "vram_gb": 5.0,
        "tasks": ["coding", "planning", "review"],
        "quality_tier": "good",
        "speed_tier": "fast",
    },
    "llama3:70b": {
        "params": "70B",
        "ram_gb": 40.0,
        "vram_gb": 40.0,
        "tasks": ["coding", "planning", "review", "complex_reasoning"],
        "quality_tier": "excellent",
        "speed_tier": "slow",
    },
    "codellama:13b": {
        "params": "13B",
        "ram_gb": 8.0,
        "vram_gb": 8.0,
        "tasks": ["coding", "refactoring"],
        "quality_tier": "good",
        "speed_tier": "medium",
    },
    "deepseek-coder-v2:16b": {
        "params": "16B",
        "ram_gb": 10.0,
        "vram_gb": 10.0,
        "tasks": ["coding", "refactoring", "review"],
        "quality_tier": "very_good",
        "speed_tier": "medium",
    },
    "mistral:7b": {
        "params": "7B",
        "ram_gb": 4.5,
        "vram_gb": 4.5,
        "tasks": ["planning", "review", "documentation"],
        "quality_tier": "good",
        "speed_tier": "fast",
    },
    "qwen2.5-coder:7b": {
        "params": "7B",
        "ram_gb": 4.5,
        "vram_gb": 4.5,
        "tasks": ["coding", "refactoring"],
        "quality_tier": "good",
        "speed_tier": "fast",
    },
    "phi3:14b": {
        "params": "14B",
        "ram_gb": 9.0,
        "vram_gb": 9.0,
        "tasks": ["coding", "planning"],
        "quality_tier": "good",
        "speed_tier": "medium",
    },
}

RECOMMENDED_MODELS_BY_TASK: dict[str, list[str]] = {
    "coding": [
        "deepseek-coder-v2:16b",
        "qwen2.5-coder:7b",
        "codellama:13b",
        "llama3:8b",
    ],
    "planning": ["llama3:70b", "llama3:8b", "mistral:7b"],
    "review": ["llama3:70b", "deepseek-coder-v2:16b", "llama3:8b"],
    "documentation": ["mistral:7b", "llama3:8b"],
    "refactoring": ["deepseek-coder-v2:16b", "codellama:13b", "qwen2.5-coder:7b"],
    "quick_feedback": ["mistral:7b", "phi3:14b", "llama3:8b"],
}


# ── Data models ─────────────────────────────────────────────────────


class RuntimeType(Enum):
    """Supported local model runtimes."""

    OLLAMA = "ollama"
    LMSTUDIO = "lmstudio"
    UNKNOWN = "unknown"


@dataclass
class RuntimeStatus:
    """Status of a local model runtime.

    Attributes:
        runtime_type: The detected runtime.
        running: Whether the runtime is accessible.
        url: The runtime's base URL.
        version: Runtime version string.
        gpu_detected: Whether a GPU was detected.
        models_loaded: Number of currently loaded models.
    """

    runtime_type: RuntimeType = RuntimeType.UNKNOWN
    running: bool = False
    url: str = ""
    version: str = ""
    gpu_detected: bool = False
    models_loaded: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "runtime_type": self.runtime_type.value,
            "running": self.running,
            "url": self.url,
            "version": self.version,
            "gpu_detected": self.gpu_detected,
            "models_loaded": self.models_loaded,
        }


@dataclass
class LocalModel:
    """Information about a locally installed model.

    Attributes:
        name: Model name/tag.
        size_bytes: Model file size in bytes.
        size_gb: Model file size in gigabytes.
        family: Model family (e.g., llama, mistral).
        parameter_count: Estimated parameter count.
        quantization: Quantization level (e.g., Q4_0, Q5_K_M).
        modified_at: Last modified datetime.
        runtime: Which runtime hosts the model.
        capabilities: Known capabilities.
        ram_estimate_gb: Estimated RAM needed.
        vram_estimate_gb: Estimated VRAM needed.
    """

    name: str = ""
    size_bytes: int = 0
    size_gb: float = 0.0
    family: str = ""
    parameter_count: str = ""
    quantization: str = ""
    modified_at: str = ""
    runtime: RuntimeType = RuntimeType.OLLAMA
    capabilities: list[str] = field(default_factory=list)
    ram_estimate_gb: float = 0.0
    vram_estimate_gb: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "size_bytes": self.size_bytes,
            "size_gb": self.size_gb,
            "family": self.family,
            "parameter_count": self.parameter_count,
            "quantization": self.quantization,
            "modified_at": self.modified_at,
            "runtime": self.runtime.value,
            "capabilities": self.capabilities,
            "ram_estimate_gb": self.ram_estimate_gb,
            "vram_estimate_gb": self.vram_estimate_gb,
        }


@dataclass
class BenchmarkResult:
    """Result of a model benchmark run.

    Attributes:
        model_name: The model benchmarked.
        prompt_tokens: Number of tokens in the prompt.
        completion_tokens: Number of tokens generated.
        time_to_first_token_ms: Latency to first token.
        tokens_per_second: Generation speed.
        total_time_seconds: Total generation time.
        quality_score: Quality assessment (0-100).
        task_type: The type of benchmark task.
        timestamp: When the benchmark was run.
    """

    model_name: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    time_to_first_token_ms: float = 0.0
    tokens_per_second: float = 0.0
    total_time_seconds: float = 0.0
    quality_score: float = 0.0
    task_type: str = "general"
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        return {
            "model_name": self.model_name,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "time_to_first_token_ms": self.time_to_first_token_ms,
            "tokens_per_second": self.tokens_per_second,
            "total_time_seconds": self.total_time_seconds,
            "quality_score": self.quality_score,
            "task_type": self.task_type,
            "timestamp": self.timestamp.isoformat(),
        }


@dataclass
class SystemResources:
    """System resource information for model compatibility checks.

    Attributes:
        total_ram_gb: Total system RAM in GB.
        available_ram_gb: Available RAM in GB.
        total_vram_gb: Total GPU VRAM in GB.
        available_vram_gb: Available GPU VRAM in GB.
        gpu_name: GPU model name.
        gpu_detected: Whether a GPU was detected.
        os_name: Operating system name.
        cpu_count: Number of CPU cores.
    """

    total_ram_gb: float = 0.0
    available_ram_gb: float = 0.0
    total_vram_gb: float = 0.0
    available_vram_gb: float = 0.0
    gpu_name: str = ""
    gpu_detected: bool = False
    os_name: str = ""
    cpu_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_ram_gb": self.total_ram_gb,
            "available_ram_gb": self.available_ram_gb,
            "total_vram_gb": self.total_vram_gb,
            "available_vram_gb": self.available_vram_gb,
            "gpu_name": self.gpu_name,
            "gpu_detected": self.gpu_detected,
            "os_name": self.os_name,
            "cpu_count": self.cpu_count,
        }


@dataclass
class ResourceAlert:
    """Alert for resource usage issues.

    Attributes:
        alert_type: Type of alert (ram, vram, disk).
        message: Human-readable message.
        current_value: Current usage value.
        threshold: The threshold that was exceeded.
        severity: Alert severity.
    """

    alert_type: str = ""
    message: str = ""
    current_value: float = 0.0
    threshold: float = 0.0
    severity: str = "warning"

    def to_dict(self) -> dict[str, Any]:
        return {
            "alert_type": self.alert_type,
            "message": self.message,
            "current_value": self.current_value,
            "threshold": self.threshold,
            "severity": self.severity,
        }


# ── Benchmark prompts ──────────────────────────────────────────────

BENCHMARK_PROMPTS: dict[str, str] = {
    "coding": (
        "Write a Python function called `merge_sorted_lists` that takes two "
        "sorted lists and returns a single sorted list. Include type hints "
        "and a docstring."
    ),
    "planning": (
        "Create a step-by-step plan to implement a REST API for a task "
        "management system. List the endpoints, HTTP methods, and data models."
    ),
    "review": (
        "Review this Python code and suggest improvements:\n"
        "```python\n"
        "def process(data):\n"
        "    result = []\n"
        "    for i in range(len(data)):\n"
        "        if data[i] != None:\n"
        "            result.append(data[i] * 2)\n"
        "    return result\n"
        "```"
    ),
    "general": (
        "Explain the difference between a mutex and a semaphore in "
        "concurrent programming. Give a brief example."
    ),
}


# ── HTTP helper ────────────────────────────────────────────────────


def _fetch_json(url: str, timeout: int = 5) -> dict[str, Any] | None:
    """Fetch JSON from a URL.

    Args:
        url: The URL to fetch.
        timeout: Request timeout in seconds.

    Returns:
        Parsed JSON dict, or None on failure.
    """
    try:
        req = urllib.request.Request(url)
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        # Bare `except Exception` previously hid every cause (including
        # KeyboardInterrupt-adjacent), making "Ollama down" indistinguishable
        # from "model errored" indistinguishable from "JSON malformed".
        # Narrow to network/parse errors and log so callers can debug.
        logger.warning("HTTP GET %s failed: %s", url, e)
        return None
    except json.JSONDecodeError as e:
        logger.warning("HTTP GET %s returned invalid JSON: %s", url, e)
        return None


def _post_json(
    url: str, data: dict[str, Any], timeout: int = 60
) -> dict[str, Any] | None:
    """POST JSON to a URL and return the response.

    Args:
        url: The URL to post to.
        data: The JSON payload.
        timeout: Request timeout in seconds.

    Returns:
        Parsed JSON dict, or None on failure.
    """
    try:
        payload = json.dumps(data).encode("utf-8")
        req = urllib.request.Request(url, data=payload, method="POST")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        logger.warning("HTTP POST %s failed: %s", url, e)
        return None
    except json.JSONDecodeError as e:
        logger.warning("HTTP POST %s returned invalid JSON: %s", url, e)
        return None


# ── Local Model Manager ────────────────────────────────────────────


class LocalModelManager:
    """Advanced local model manager for Ollama and LM Studio.

    Provides auto-detection, benchmarking, resource monitoring,
    model recommendations, and hybrid mode support.

    Attributes:
        ollama_url: Ollama server URL.
        lmstudio_url: LM Studio server URL.
        _benchmarks: Cached benchmark results.
        _system_resources: Cached system resources.

    Example:
        >>> manager = LocalModelManager()
        >>> status = manager.detect_runtime()
        >>> if status.running:
        ...     models = manager.list_models()
        ...     recommended = manager.recommend_models("coding")
    """

    def __init__(
        self,
        ollama_url: str = DEFAULT_OLLAMA_URL,
        lmstudio_url: str = DEFAULT_LMSTUDIO_URL,
    ) -> None:
        self.ollama_url = ollama_url.rstrip("/")
        self.lmstudio_url = lmstudio_url.rstrip("/")
        self._benchmarks: dict[str, list[BenchmarkResult]] = {}
        self._system_resources: SystemResources | None = None
        self._alerts: list[ResourceAlert] = []

    # ── Runtime detection ───────────────────────────────────────

    def detect_runtime(self) -> RuntimeStatus:
        """Auto-detect available local model runtimes.

        Checks Ollama first, then LM Studio.

        Returns:
            RuntimeStatus with detection results.
        """
        # Try Ollama first
        ollama_status = self._check_ollama()
        if ollama_status.running:
            return ollama_status

        # Try LM Studio
        lmstudio_status = self._check_lmstudio()
        if lmstudio_status.running:
            return lmstudio_status

        return RuntimeStatus(
            runtime_type=RuntimeType.UNKNOWN,
            running=False,
        )

    def _check_ollama(self) -> RuntimeStatus:
        """Check Ollama server status.

        Returns:
            RuntimeStatus for Ollama.
        """
        version_data = _fetch_json(f"{self.ollama_url}/api/version")
        if not version_data:
            return RuntimeStatus(runtime_type=RuntimeType.OLLAMA, running=False)

        tags_data = _fetch_json(f"{self.ollama_url}/api/tags")
        model_count = len(tags_data.get("models", [])) if tags_data else 0

        return RuntimeStatus(
            runtime_type=RuntimeType.OLLAMA,
            running=True,
            url=self.ollama_url,
            version=version_data.get("version", "unknown"),
            models_loaded=model_count,
        )

    def _check_lmstudio(self) -> RuntimeStatus:
        """Check LM Studio server status.

        Returns:
            RuntimeStatus for LM Studio.
        """
        models_data = _fetch_json(f"{self.lmstudio_url}/v1/models")
        if not models_data:
            return RuntimeStatus(runtime_type=RuntimeType.LMSTUDIO, running=False)

        model_count = len(models_data.get("data", []))

        return RuntimeStatus(
            runtime_type=RuntimeType.LMSTUDIO,
            running=True,
            url=self.lmstudio_url,
            models_loaded=model_count,
        )

    # ── Model listing ───────────────────────────────────────────

    def list_models(self, runtime: RuntimeType | None = None) -> list[LocalModel]:
        """List all locally installed models.

        Args:
            runtime: Filter by runtime type. If None, checks all.

        Returns:
            List of LocalModel objects.
        """
        models: list[LocalModel] = []

        if runtime is None or runtime == RuntimeType.OLLAMA:
            models.extend(self._list_ollama_models())

        if runtime is None or runtime == RuntimeType.LMSTUDIO:
            models.extend(self._list_lmstudio_models())

        return models

    def _list_ollama_models(self) -> list[LocalModel]:
        """List models from Ollama.

        Returns:
            List of LocalModel objects.
        """
        data = _fetch_json(f"{self.ollama_url}/api/tags")
        if not data:
            return []

        models: list[LocalModel] = []
        for model_data in data.get("models", []):
            name = model_data.get("name", "")
            size_bytes = model_data.get("size", 0)

            # Look up known capabilities
            known = KNOWN_MODELS.get(name, {})
            capabilities = known.get("tasks", [])
            ram_est = known.get("ram_gb", size_bytes / (1024**3) * 1.2)
            vram_est = known.get("vram_gb", size_bytes / (1024**3))

            # Detect family from name
            family = self._detect_model_family(name)

            # Detect quantization from name
            quantization = self._detect_quantization(name)

            models.append(
                LocalModel(
                    name=name,
                    size_bytes=size_bytes,
                    size_gb=round(size_bytes / (1024**3), 2),
                    family=family,
                    parameter_count=known.get("params", ""),
                    quantization=quantization,
                    modified_at=model_data.get("modified_at", ""),
                    runtime=RuntimeType.OLLAMA,
                    capabilities=capabilities,
                    ram_estimate_gb=round(ram_est, 1),
                    vram_estimate_gb=round(vram_est, 1),
                )
            )

        return models

    def _list_lmstudio_models(self) -> list[LocalModel]:
        """List models from LM Studio.

        Returns:
            List of LocalModel objects.
        """
        data = _fetch_json(f"{self.lmstudio_url}/v1/models")
        if not data:
            return []

        models: list[LocalModel] = []
        for model_data in data.get("data", []):
            name = model_data.get("id", "")
            models.append(
                LocalModel(
                    name=name,
                    runtime=RuntimeType.LMSTUDIO,
                    family=self._detect_model_family(name),
                )
            )

        return models

    def _detect_model_family(self, name: str) -> str:
        """Detect the model family from its name.

        Args:
            name: The model name.

        Returns:
            The detected family name.
        """
        name_lower = name.lower()
        families = [
            "llama",
            "mistral",
            "codellama",
            "deepseek",
            "phi",
            "qwen",
            "gemma",
            "vicuna",
            "starcoder",
            "wizardcoder",
        ]
        for family in families:
            if family in name_lower:
                return family
        return "unknown"

    def _detect_quantization(self, name: str) -> str:
        """Detect quantization level from model name.

        Args:
            name: The model name.

        Returns:
            The detected quantization, or empty string.
        """
        name_upper = name.upper()
        quant_patterns = [
            "Q2_K",
            "Q3_K_S",
            "Q3_K_M",
            "Q3_K_L",
            "Q4_0",
            "Q4_1",
            "Q4_K_S",
            "Q4_K_M",
            "Q5_0",
            "Q5_1",
            "Q5_K_S",
            "Q5_K_M",
            "Q6_K",
            "Q8_0",
            "F16",
            "F32",
        ]
        for pattern in quant_patterns:
            if pattern in name_upper:
                return pattern
        return ""

    # ── Benchmarking ────────────────────────────────────────────

    def benchmark_model(
        self,
        model_name: str,
        task_type: str = "general",
        runtime_url: str | None = None,
    ) -> BenchmarkResult:
        """Benchmark a model on a reference task.

        Measures time-to-first-token, tokens/second, and total time.

        Args:
            model_name: The model to benchmark.
            task_type: The benchmark task type (coding, planning, review, general).
            runtime_url: Override the runtime URL.

        Returns:
            BenchmarkResult with measurements.
        """
        url = runtime_url or self.ollama_url
        prompt = BENCHMARK_PROMPTS.get(task_type, BENCHMARK_PROMPTS["general"])

        logger.info("Benchmarking '%s' on '%s' task...", model_name, task_type)

        start_time = time.monotonic()

        response = _post_json(
            f"{url}/api/generate",
            {
                "model": model_name,
                "prompt": prompt,
                "stream": False,
            },
            timeout=120,
        )

        total_time = time.monotonic() - start_time

        if not response:
            logger.warning("Benchmark failed for '%s' — no response.", model_name)
            return BenchmarkResult(
                model_name=model_name,
                task_type=task_type,
                total_time_seconds=total_time,
            )

        # Extract metrics from Ollama response
        prompt_tokens = response.get("prompt_eval_count", 0)
        completion_tokens = response.get("eval_count", 0)
        eval_duration_ns = response.get("eval_duration", 0)
        prompt_eval_duration_ns = response.get("prompt_eval_duration", 0)

        # Calculate tokens per second
        tokens_per_second = 0.0
        if eval_duration_ns > 0:
            tokens_per_second = completion_tokens / (eval_duration_ns / 1e9)

        # Time to first token (prompt evaluation time)
        ttft_ms = prompt_eval_duration_ns / 1e6 if prompt_eval_duration_ns else 0.0

        # Simple quality score based on response length and relevance
        output_text = response.get("response", "")
        quality_score = self._assess_quality(output_text, task_type)

        result = BenchmarkResult(
            model_name=model_name,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            time_to_first_token_ms=round(ttft_ms, 1),
            tokens_per_second=round(tokens_per_second, 1),
            total_time_seconds=round(total_time, 2),
            quality_score=quality_score,
            task_type=task_type,
        )

        # Cache result
        if model_name not in self._benchmarks:
            self._benchmarks[model_name] = []
        self._benchmarks[model_name].append(result)

        logger.info(
            "Benchmark '%s': %.1f tok/s, quality=%.0f, total=%.1fs",
            model_name,
            tokens_per_second,
            quality_score,
            total_time,
        )

        return result

    def _assess_quality(self, output: str, task_type: str) -> float:
        """Assess the quality of a benchmark output (0-100).

        Args:
            output: The model's output text.
            task_type: The task type for context-specific scoring.

        Returns:
            Quality score between 0 and 100.
        """
        if not output or not output.strip():
            return 0.0

        score = 0.0
        text = output.strip()
        length = len(text)

        # Length scoring (reasonable response length)
        if length >= 50:
            score += 20
        if length >= 200:
            score += 10
        if length >= 500:
            score += 10

        # Task-specific quality signals
        if task_type == "coding":
            if "def " in text or "function " in text:
                score += 20
            if "```" in text:
                score += 10
            if "return" in text:
                score += 10
            if '"""' in text or "docstring" in text.lower():
                score += 10
            if "->" in text or ": " in text:
                score += 10

        elif task_type == "planning":
            # Check for structured output (numbered/bulleted list)
            if any(f"{i}." in text for i in range(1, 6)):
                score += 20
            if "endpoint" in text.lower() or "api" in text.lower():
                score += 15
            if "GET" in text or "POST" in text:
                score += 15
            if len(text.split("\n")) >= 5:
                score += 10

        elif task_type == "review":
            if any(
                w in text.lower() for w in ["improve", "suggest", "instead", "better"]
            ):
                score += 20
            if "None" in text or "is not" in text:
                score += 15
            if "enumerate" in text or "list comprehension" in text:
                score += 15
            if len(text.split("\n")) >= 3:
                score += 10

        else:
            # General: check for structure and content
            if len(text.split("\n")) >= 3:
                score += 15
            if len(text.split()) >= 50:
                score += 15
            if any(c in text for c in [".", ":", "-"]):
                score += 10

        return min(score, 100.0)

    def get_benchmark_results(
        self, model_name: str | None = None
    ) -> dict[str, list[dict[str, Any]]]:
        """Get cached benchmark results.

        Args:
            model_name: Filter by model name. If None, returns all.

        Returns:
            Dict mapping model names to their benchmark results.
        """
        if model_name:
            results = self._benchmarks.get(model_name, [])
            return {model_name: [r.to_dict() for r in results]}

        return {
            name: [r.to_dict() for r in results]
            for name, results in self._benchmarks.items()
        }

    # ── System resources ────────────────────────────────────────

    def get_system_resources(self) -> SystemResources:
        """Detect system resources (RAM, GPU, CPU).

        Uses platform information and psutil if available.

        Returns:
            SystemResources with detected values.
        """
        resources = SystemResources(
            os_name=platform.system(),
        )

        # Try psutil for detailed info
        try:
            import psutil

            mem = psutil.virtual_memory()
            resources.total_ram_gb = round(mem.total / (1024**3), 1)
            resources.available_ram_gb = round(mem.available / (1024**3), 1)
            resources.cpu_count = psutil.cpu_count(logical=True) or 0
        except ImportError:
            # Fallback: basic info
            import os

            resources.cpu_count = os.cpu_count() or 0

        # Try to detect GPU via nvidia-smi (NVIDIA)
        resources = self._detect_gpu(resources)

        self._system_resources = resources
        return resources

    def _detect_gpu(self, resources: SystemResources) -> SystemResources:
        """Attempt GPU detection via nvidia-smi.

        Args:
            resources: The resources object to populate.

        Returns:
            Updated resources with GPU info.
        """
        try:
            import subprocess

            result = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=name,memory.total,memory.free",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0 and result.stdout.strip():
                parts = result.stdout.strip().split(",")
                if len(parts) >= 3:
                    resources.gpu_name = parts[0].strip()
                    resources.total_vram_gb = round(float(parts[1].strip()) / 1024, 1)
                    resources.available_vram_gb = round(
                        float(parts[2].strip()) / 1024, 1
                    )
                    resources.gpu_detected = True
        except (FileNotFoundError, subprocess.TimeoutExpired, ValueError):
            pass

        return resources

    def check_resource_alerts(
        self,
        ram_threshold: float = 0.9,
        vram_threshold: float = 0.9,
    ) -> list[ResourceAlert]:
        """Check for resource usage alerts.

        Args:
            ram_threshold: RAM usage fraction threshold (0-1).
            vram_threshold: VRAM usage fraction threshold (0-1).

        Returns:
            List of active alerts.
        """
        resources = self.get_system_resources()
        alerts: list[ResourceAlert] = []

        # RAM check
        if resources.total_ram_gb > 0:
            used_ram = resources.total_ram_gb - resources.available_ram_gb
            usage_fraction = used_ram / resources.total_ram_gb

            if usage_fraction >= ram_threshold:
                alerts.append(
                    ResourceAlert(
                        alert_type="ram",
                        message=(
                            f"RAM usage is at {usage_fraction:.0%} "
                            f"({used_ram:.1f}/{resources.total_ram_gb:.1f} GB). "
                            f"Consider unloading unused models."
                        ),
                        current_value=round(usage_fraction, 2),
                        threshold=ram_threshold,
                        severity="critical" if usage_fraction >= 0.95 else "warning",
                    )
                )

        # VRAM check
        if resources.total_vram_gb > 0:
            used_vram = resources.total_vram_gb - resources.available_vram_gb
            usage_fraction = used_vram / resources.total_vram_gb

            if usage_fraction >= vram_threshold:
                alerts.append(
                    ResourceAlert(
                        alert_type="vram",
                        message=(
                            f"GPU VRAM usage is at {usage_fraction:.0%} "
                            f"({used_vram:.1f}/{resources.total_vram_gb:.1f} GB). "
                            f"May cause OOM errors with large models."
                        ),
                        current_value=round(usage_fraction, 2),
                        threshold=vram_threshold,
                        severity="critical" if usage_fraction >= 0.95 else "warning",
                    )
                )

        self._alerts = alerts
        return alerts

    # ── Model recommendations ───────────────────────────────────

    def recommend_models(
        self,
        task_type: str,
        max_ram_gb: float | None = None,
    ) -> list[dict[str, Any]]:
        """Recommend models for a specific task type.

        Takes into account system resources and model capabilities.

        Args:
            task_type: The task type (coding, planning, review, etc.).
            max_ram_gb: Maximum RAM to use. Auto-detected if None.

        Returns:
            List of recommended model dictionaries.
        """
        if max_ram_gb is None and self._system_resources:
            max_ram_gb = self._system_resources.available_ram_gb * 0.8

        recommended_names = RECOMMENDED_MODELS_BY_TASK.get(task_type, [])
        installed_models = {m.name for m in self.list_models()}

        recommendations: list[dict[str, Any]] = []
        for model_name in recommended_names:
            known = KNOWN_MODELS.get(model_name, {})
            ram_needed = known.get("ram_gb", 0)

            fits_ram = True
            if max_ram_gb and ram_needed > max_ram_gb:
                fits_ram = False

            recommendations.append(
                {
                    "model": model_name,
                    "installed": model_name in installed_models,
                    "fits_resources": fits_ram,
                    "ram_gb": ram_needed,
                    "quality_tier": known.get("quality_tier", "unknown"),
                    "speed_tier": known.get("speed_tier", "unknown"),
                    "tasks": known.get("tasks", []),
                }
            )

        return recommendations

    # ── Hybrid mode ─────────────────────────────────────────────

    def configure_hybrid_mode(
        self,
        local_model: str,
        cloud_provider: str = "anthropic",
        cloud_model: str = "claude-sonnet-4-20250514",
    ) -> dict[str, Any]:
        """Configure hybrid mode: local model for drafts, cloud for validation.

        Args:
            local_model: Local model name for drafting.
            cloud_provider: Cloud provider for validation.
            cloud_model: Cloud model for validation.

        Returns:
            Hybrid configuration dictionary.
        """
        config = {
            "hybrid_mode": True,
            "draft": {
                "provider": "ollama",
                "model": local_model,
                "url": self.ollama_url,
                "purpose": "Fast draft generation (code, plans)",
            },
            "validation": {
                "provider": cloud_provider,
                "model": cloud_model,
                "purpose": "Quality validation and refinement",
            },
            "pipeline": [
                {"step": "draft", "provider": "local", "model": local_model},
                {"step": "validate", "provider": cloud_provider, "model": cloud_model},
                {
                    "step": "refine",
                    "provider": "local",
                    "model": local_model,
                    "optional": True,
                },
            ],
        }

        logger.info(
            "Hybrid mode configured: %s (local) → %s/%s (cloud)",
            local_model,
            cloud_provider,
            cloud_model,
        )
        return config

    # ── Model installation ──────────────────────────────────────

    def pull_model(self, model_name: str) -> dict[str, Any]:
        """Pull (download) a model from the Ollama registry.

        Args:
            model_name: The model to pull.

        Returns:
            Result dictionary with status.
        """
        logger.info("Pulling model '%s'...", model_name)

        response = _post_json(
            f"{self.ollama_url}/api/pull",
            {"name": model_name, "stream": False},
            timeout=600,
        )

        if response and response.get("status") == "success":
            return {"success": True, "model": model_name, "status": "completed"}

        return {
            "success": False,
            "model": model_name,
            "error": "Pull failed or timed out",
        }

    # ── Compatibility check ─────────────────────────────────────

    def check_model_compatibility(self, model_name: str) -> dict[str, Any]:
        """Check if a model is compatible with the current system.

        Args:
            model_name: The model to check.

        Returns:
            Compatibility report dictionary.
        """
        resources = self._system_resources or self.get_system_resources()
        known = KNOWN_MODELS.get(model_name, {})

        ram_needed = known.get("ram_gb", 0)
        vram_needed = known.get("vram_gb", 0)

        ram_ok = ram_needed <= resources.available_ram_gb if ram_needed else True
        vram_ok = (
            vram_needed <= resources.available_vram_gb
            if vram_needed and resources.gpu_detected
            else True
        )

        return {
            "model": model_name,
            "compatible": ram_ok and vram_ok,
            "ram_required_gb": ram_needed,
            "ram_available_gb": resources.available_ram_gb,
            "ram_ok": ram_ok,
            "vram_required_gb": vram_needed,
            "vram_available_gb": resources.available_vram_gb,
            "vram_ok": vram_ok,
            "gpu_detected": resources.gpu_detected,
            "gpu_name": resources.gpu_name,
            "warnings": [
                w
                for w in [
                    f"Needs {ram_needed}GB RAM, only {resources.available_ram_gb}GB available"
                    if not ram_ok
                    else None,
                    f"Needs {vram_needed}GB VRAM, only {resources.available_vram_gb}GB available"
                    if not vram_ok and resources.gpu_detected
                    else None,
                    "No GPU detected — model will run on CPU (slower)"
                    if not resources.gpu_detected and vram_needed > 0
                    else None,
                ]
                if w
            ],
        }

    # ── Stats ───────────────────────────────────────────────────

    def get_stats(self) -> dict[str, Any]:
        """Get manager statistics.

        Returns:
            Dictionary with runtime status, model count, benchmarks.
        """
        runtime = self.detect_runtime()
        models = self.list_models()

        return {
            "runtime": runtime.to_dict(),
            "models_count": len(models),
            "benchmarks_count": sum(len(v) for v in self._benchmarks.values()),
            "alerts": [a.to_dict() for a in self._alerts],
        }
