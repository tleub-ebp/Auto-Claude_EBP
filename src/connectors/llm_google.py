from typing import Any, Optional

from .llm_base import BaseLLMProvider


class GoogleLLMProvider(BaseLLMProvider):
    def __init__(self, api_key: str, model: str = "gemini-2.0-flash"):
        self.api_key = api_key
        self.model = model
        self._client: Optional[Any] = None

    def connect(self) -> None:
        try:
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", FutureWarning)
                import google.generativeai as genai
        except ImportError:
            raise ImportError("google-generativeai package is required. Install with: pip install google-generativeai")
        genai.configure(api_key=self.api_key)
        self._genai = genai
        self._model = genai.GenerativeModel(self.model)

    def validate(self) -> bool:
        try:
            self.connect()
            # Try a simple model info call
            return hasattr(self._model, "generate_content")
        except Exception:
            return False

    def generate(self, prompt: str, **kwargs) -> str:
        self.connect()
        response = self._model.generate_content([{"role": "user", "parts": [prompt]}])
        return response.text if hasattr(response, "text") else str(response)

    def get_capabilities(self) -> dict[str, Any]:
        return {"models": [self.model], "provider": "google"}

    def get_config_schema(self) -> dict[str, Any]:
        return {"api_key": "str", "model": "str"}

    @classmethod
    def get_name(cls) -> str:
        return "google"
