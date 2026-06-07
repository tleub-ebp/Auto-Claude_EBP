"""
Cursor LLM Provider Connector

Fournit l'accès aux modèles LLM via l'API Cursor.
Cursor supporte les endpoints API compatibles OpenAI et peut être configuré
pour utiliser des providers personnalisés via LLM Gateway.
"""

import logging
from typing import Any, Optional

from .llm_base import BaseLLMProvider

logger = logging.getLogger(__name__)


class CursorProvider(BaseLLMProvider):
    """Provider pour Cursor IDE."""

    def __init__(self, api_key: str, model: str = "cursor-default", base_url: str = "https://api.cursor.com/v1"):
        self.api_key = api_key
        self.model = model
        self.base_url = base_url
        self._client: Optional[Any] = None

    def connect(self) -> None:
        """Établit la connexion avec l'API Cursor."""
        try:
            import openai
        except ImportError:
            raise ImportError("openai package is required. Install with: pip install openai")
        
        self._client = openai.OpenAI(
            api_key=self.api_key,
            base_url=self.base_url
        )
        logger.info(f"Cursor provider connected with model: {self.model}")

    def validate(self) -> bool:
        """Valide la configuration du provider Cursor."""
        try:
            self.connect()
            # Test de connexion basique
            response = self._client.models.list()
            available_models = [model.id for model in response.data]
            return self.model in available_models or any("cursor" in model.lower() for model in available_models)
        except Exception as e:
            logger.warning(f"Cursor provider validation failed: {e}")
            return False

    def generate(self, prompt: str, **kwargs) -> str:
        """Génère une réponse via l'API Cursor."""
        self.connect()
        try:
            response = self._client.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                **kwargs
            )
            return response.choices[0].message.content
        except Exception as e:
            logger.error(f"Cursor generation failed: {e}")
            raise

    def get_capabilities(self) -> dict[str, Any]:
        """Retourne les capacités du provider Cursor."""
        return {
            "models": [
                "cursor-default",
                "cursor-pro",
                "gpt-4o",
                "gpt-4-turbo",
                "claude-3.5-sonnet",
                "claude-3-opus"
            ],
            "provider": "cursor",
            "features": [
                "chat",
                "inline_edit",
                "autocomplete",
                "code_generation",
                "ask_mode",
                "plan_mode",
                "agent_mode"
            ],
            "api_compatibility": "openai",
            "llm_gateway_support": True
        }

    def get_config_schema(self) -> dict[str, Any]:
        """Retourne le schéma de configuration pour Cursor."""
        return {
            "api_key": "str (required)",
            "model": "str (optional, default: cursor-default)",
            "base_url": "str (optional, default: https://api.cursor.com/v1)",
            "llm_gateway_url": "str (optional, for LLM Gateway integration)"
        }

    @classmethod
    def get_name(cls) -> str:
        """Nom unique du provider."""
        return "cursor"
