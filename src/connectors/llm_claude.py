from typing import Any, Optional

from .llm_base import BaseLLMProvider


class ClaudeProvider(BaseLLMProvider):
    def __init__(self, api_key: str, model: str = "claude-3-sonnet-20240229"):
        self.api_key = api_key
        self.model = model
        self._client: Optional[Any] = None

    def connect(self) -> None:
        try:
            from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
        except ImportError:
            raise ImportError("claude-agent-sdk package is required. Install with: pip install claude-agent-sdk")
        self._ClaudeSDKClient = ClaudeSDKClient
        self._ClaudeAgentOptions = ClaudeAgentOptions

    def validate(self) -> bool:
        try:
            self.connect()
            # There is no public 'list models' endpoint, so just check API key format
            return self.api_key.startswith("sk-ant-")
        except Exception:
            return False

    def generate(self, prompt: str, **kwargs) -> str:
        self.connect()
        options = self._ClaudeAgentOptions(
            model=self.model,
            system_prompt=kwargs.get("system_prompt", "You are Claude."),
            allowed_tools=kwargs.get("allowed_tools", []),
            max_turns=kwargs.get("max_turns", 10),
        )
        client = self._ClaudeSDKClient(options=options)
        # Synchronous call for simplicity; adapt if async needed
        response = client.query_sync(prompt)
        return response["content"] if isinstance(response, dict) and "content" in response else str(response)

    def get_capabilities(self) -> dict[str, Any]:
        return {"models": [self.model], "provider": "claude"}

    def get_config_schema(self) -> dict[str, Any]:
        return {"api_key": "str", "model": "str"}

    @classmethod
    def get_name(cls) -> str:
        return "claude"
