from typing import Any, Optional

from .llm_base import BaseLLMProvider


class MistralAIProvider(BaseLLMProvider):
    def __init__(self, api_key: str, model: str = "mistral-large-latest", base_url: str = "https://api.mistral.ai/v1"):
        self.api_key = api_key
        self.model = model
        self.base_url = base_url
        self._client: Optional[Any] = None

    def connect(self) -> None:
        try:
            import openai
        except ImportError:
            raise ImportError("openai package is required for Mistral (OpenAI-compatible). Install with: pip install openai")
        self._client = openai
        self._client.api_key = self.api_key
        self._client.base_url = self.base_url

    def validate(self) -> bool:
        try:
            self.connect()
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
        return {"models": [self.model], "provider": "mistral"}

    def get_config_schema(self) -> dict[str, Any]:
        return {"api_key": "str", "model": "str"}

    @classmethod
    def get_name(cls) -> str:
        return "mistral"
