"""
Windsurf LLM Provider Connector (Codeium)

Dual-mode access to Windsurf/Codeium AI models:

Mode 1 (Local gRPC): Communicates with a running Windsurf IDE's language server
    via gRPC on localhost. Requires Windsurf IDE to be running and authenticated.

Mode 2 (REST Fallback): Uses the OpenAI-compatible REST API at
    server.codeium.com/api/v1 with a stored API key or OAuth token.
"""

import asyncio
import logging
import os
from typing import Any, Optional

from .llm_base import BaseLLMProvider

logger = logging.getLogger(__name__)


class WindsurfProvider(BaseLLMProvider):
    """Provider pour Windsurf AI (Codeium).

    Dual-mode:
    - Mode 1: Local gRPC proxy to running Windsurf IDE (preferred)
    - Mode 2: REST API to server.codeium.com (fallback)
    """

    def __init__(
        self,
        api_key: str | None = None,
        model: str = "claude-4-sonnet",
        base_url: str = "https://server.codeium.com/api/v1",
    ):
        # Priority: explicit api_key > WINDSURF_API_KEY > WINDSURF_OAUTH_TOKEN > CODEIUM_API_KEY
        self.api_key = (
            api_key
            or os.environ.get("WINDSURF_API_KEY", "")
            or os.environ.get("WINDSURF_OAUTH_TOKEN", "")
            or os.environ.get("CODEIUM_API_KEY", "")
        )
        self.model = model
        self.base_url = base_url
        self._client: Optional[Any] = None
        self._use_local_grpc: bool = False
        self._credentials: Optional[Any] = None

    def connect(self) -> None:
        """Establish connection — tries REST API first if token available, then local gRPC."""
        # Mode 1: REST API via OpenAI client (preferred when token is available)
        if self.api_key:
            try:
                import openai
            except ImportError:
                raise ImportError("openai package is required. Install with: pip install openai")

            self._client = openai.OpenAI(api_key=self.api_key, base_url=self.base_url)
            self._use_local_grpc = False
            logger.info(f"[WindsurfProvider] Mode 1: REST API to {self.base_url} (model={self.model})")
            return

        # Mode 2: Local gRPC (fallback when no token, requires Windsurf IDE running)
        try:
            from integrations.windsurf_proxy.auth import (
                discover_credentials,
                is_windsurf_running,
            )

            if is_windsurf_running():
                self._credentials = discover_credentials()
                self._use_local_grpc = True
                logger.info(
                    f"[WindsurfProvider] Mode 2: gRPC proxy to localhost:{self._credentials.port}"
                )
                return
        except Exception as e:
            logger.debug(f"[WindsurfProvider] gRPC discovery failed: {e}")

        logger.warning(
            "[WindsurfProvider] No API key and Windsurf IDE not running. "
            "Set WINDSURF_API_KEY or WINDSURF_OAUTH_TOKEN or start Windsurf IDE."
        )

    def validate(self) -> bool:
        """Validate the provider configuration."""
        try:
            self.connect()
            if self._use_local_grpc:
                return self._credentials is not None
            if self._client:
                return True
            return False
        except Exception as e:
            logger.warning(f"Windsurf provider validation failed: {e}")
            return False

    def generate(self, prompt: str, **kwargs) -> str:
        """Generate a response via Windsurf."""
        self.connect()

        if self._use_local_grpc:
            return self._generate_via_grpc(prompt, **kwargs)
        elif self._client:
            return self._generate_via_rest(prompt, **kwargs)
        else:
            raise RuntimeError("Windsurf provider not connected. Start Windsurf IDE or set API key.")

    def _generate_via_grpc(self, prompt: str, **kwargs) -> str:
        """Generate via local gRPC proxy."""
        from integrations.windsurf_proxy.grpc_client import chat
        from integrations.windsurf_proxy.models import resolve_model

        model_enum, model_name = resolve_model(self.model)
        messages = [{"role": "user", "content": prompt}]

        # Run async function in sync context
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                import concurrent.futures

                with concurrent.futures.ThreadPoolExecutor() as pool:
                    result = pool.submit(
                        asyncio.run,
                        chat(self._credentials, messages, model_enum, model_name),
                    ).result()
                return result
            else:
                return loop.run_until_complete(
                    chat(self._credentials, messages, model_enum, model_name)
                )
        except RuntimeError:
            return asyncio.run(
                chat(self._credentials, messages, model_enum, model_name)
            )

    def _generate_via_rest(self, prompt: str, **kwargs) -> str:
        """Generate via REST API to server.codeium.com."""
        try:
            response = self._client.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                **kwargs,
            )
            return response.choices[0].message.content
        except Exception as e:
            logger.error(f"Windsurf REST generation failed: {e}")
            raise

    def get_capabilities(self) -> dict[str, Any]:
        """Return provider capabilities."""
        return {
            "models": [
                "swe-1.5",
                "claude-4-sonnet",
                "claude-4.5-sonnet",
                "claude-4-opus",
                "claude-4.5-opus",
                "gpt-4o",
                "gpt-5",
                "gemini-2.5-pro",
                "gemini-3-flash",
                "deepseek-r1",
                "o3",
                "o4-mini",
            ],
            "provider": "windsurf",
            "features": [
                "chat",
                "code_generation",
                "context_awareness",
                "local_grpc_proxy",
                "rest_fallback",
            ],
            "api_compatibility": "openai",
            "modes": ["grpc_local", "rest_remote"],
        }

    def get_config_schema(self) -> dict[str, Any]:
        """Return configuration schema."""
        return {
            "api_key": "str (optional — auto-detected from Windsurf IDE or env var WINDSURF_API_KEY)",
            "model": "str (optional, default: claude-4-sonnet)",
            "base_url": "str (optional, default: https://server.codeium.com/api/v1 for REST mode)",
        }

    @classmethod
    def get_name(cls) -> str:
        """Unique provider name."""
        return "windsurf"
