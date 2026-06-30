from typing import Any

from .llm_base import BaseLLMProvider


def _normalize_openai_base(base_url: str) -> str:
    """Return an OpenAI-compatible base URL ending in ``/v1``.

    Accepts a bare server root, a ``/v1`` URL, or a full chat-completions URL.
    Works for any OpenAI-compatible local server (Ollama, LM Studio, llama.cpp,
    vLLM, LocalAI).
    """
    base = (base_url or "http://localhost:11434").strip().rstrip("/")
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")].rstrip("/")
    if not base.endswith("/v1"):
        base = base + "/v1"
    return base


class OllamaProvider(BaseLLMProvider):
    """Connector for any OpenAI-compatible local LLM server.

    Despite the name, this works with Ollama, LM Studio, llama.cpp, vLLM and
    LocalAI — all expose an OpenAI-compatible ``/v1`` API. Uses the modern
    ``openai>=1.0`` SDK (``OpenAI`` client), not the removed pre-1.0 module API.
    """

    def __init__(
        self,
        model: str = "llama3.3",
        base_url: str = "http://localhost:11434",
        api_key: str = "ollama",
        **_kwargs: Any,
    ):
        self.model = model
        # Store the OpenAI-compatible base (…/v1) for the SDK client.
        self.base_url = _normalize_openai_base(base_url)
        # Local servers ignore the key; a non-empty placeholder keeps the SDK happy.
        self.api_key = api_key or "ollama"
        self._client: Any | None = None

    def connect(self) -> None:
        try:
            from openai import OpenAI
        except ImportError:
            raise ImportError(
                "openai>=1.0 is required for the local LLM connector. "
                "Install with: pip install openai"
            )
        self._client = OpenAI(base_url=self.base_url, api_key=self.api_key)

    def validate(self) -> bool:
        try:
            self.connect()
            # A reachable server with at least one model is considered valid.
            # We don't require an exact model match: the user may not have
            # pulled `self.model` yet, but the server itself is configured.
            models = list(self._client.models.list())
            return bool(models)
        except Exception:
            return False

    def generate(self, prompt: str, **kwargs) -> str:
        if self._client is None:
            self.connect()
        response = self._client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            **kwargs,
        )
        return response.choices[0].message.content or ""

    def get_capabilities(self) -> dict[str, Any]:
        return {"models": [self.model], "provider": "ollama", "base_url": self.base_url}

    def get_config_schema(self) -> dict[str, Any]:
        return {"model": "str", "base_url": "str (optional)"}

    @classmethod
    def get_name(cls) -> str:
        return "ollama"
