from typing import Any, Optional

from .llm_base import BaseLLMProvider


class OllamaProvider(BaseLLMProvider):
    def __init__(self, model: str = "llama2", base_url: str = "http://localhost:11434"):
        self.model = model
        self.base_url = base_url
        self._client: Optional[Any] = None

    def connect(self) -> None:
        try:
            import openai
        except ImportError:
            raise ImportError("openai package is required for Ollama (OpenAI-compatible). Install with: pip install openai")
        self._client = openai
        self._client.api_key = "ollama"  # Dummy key for local
        self._client.base_url = self.base_url + "/v1" if not self.base_url.endswith("/v1") else self.base_url

    def validate(self) -> bool:
        try:
            self.connect()
            # Try listing models (Ollama exposes /models endpoint)
            models = self._client.Model.list()
            return any(self.model in m.id for m in models.data)
        except Exception:
            return False

    def generate(self, prompt: str, **kwargs) -> str:
        self.connect()
        response = self._client.ChatCompletion.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            **kwargs
        )
        return response.choices[0].message["content"]

    def get_capabilities(self) -> dict[str, Any]:
        return {"models": [self.model], "provider": "ollama"}

    def get_config_schema(self) -> dict[str, Any]:
        return {"model": "str", "base_url": "str (optional)"}

    @classmethod
    def get_name(cls) -> str:
        return "ollama"
