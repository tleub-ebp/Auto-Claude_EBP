from typing import Any, Optional

from .llm_base import BaseLLMProvider


class AnthropicProvider(BaseLLMProvider):
    def __init__(self, api_key: str, model: str = "claude-3-sonnet-20240229"):
        self.api_key = api_key
        self.model = model
        self._client: Optional[Any] = None

    def connect(self) -> None:
        try:
            import anthropic
        except ImportError:
            raise ImportError("anthropic package is required. Install with: pip install anthropic")
        self._client = anthropic.Anthropic(api_key=self.api_key)

    def validate(self) -> bool:
        try:
            self.connect()
            # Try a simple API call (list models is not public, so just check key format)
            return self.api_key.startswith("sk-ant-")
        except Exception:
            return False

    def generate(self, prompt: str, **kwargs) -> str:
        self.connect()
        response = self._client.messages.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=kwargs.get("max_tokens", 1024),
        )
        return response.content[0].text if hasattr(response, "content") and response.content else str(response)

    def get_capabilities(self) -> dict[str, Any]:
        return {"models": [self.model], "provider": "anthropic"}

    def get_config_schema(self) -> dict[str, Any]:
        return {"api_key": "str", "model": "str"}

    @classmethod
    def get_name(cls) -> str:
        return "anthropic"
