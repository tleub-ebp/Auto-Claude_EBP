"""
Abstraction de base pour les connecteurs LLM (Large Language Model).
Permet d'assurer une interface cohérente pour tous les providers (OpenAI, Claude, Mistral, etc.).
"""
from abc import ABC, abstractmethod
from typing import Any, TypedDict


class GenerateKwargs(TypedDict, total=False):
    """Paramètres optionnels reconnus par generate()."""
    max_tokens: int
    temperature: float
    top_p: float
    system_prompt: str
    allowed_tools: list[Any]
    max_turns: int
    stop: list[str]
    stream: bool


class BaseLLMProvider(ABC):
    """Interface de base pour un provider LLM."""

    @abstractmethod
    def connect(self) -> None:
        """Établit la connexion et valide la configuration/clé API."""
        pass

    @abstractmethod
    def validate(self) -> bool:
        """Valide la configuration du provider (clé API, endpoint, etc.)."""
        pass

    @abstractmethod
    def generate(self, prompt: str, **kwargs) -> str:
        """Génère une réponse à partir d'un prompt."""
        pass

    @abstractmethod
    def get_capabilities(self) -> dict[str, Any]:
        """Retourne les capacités du provider (modèles, outils, limitations, etc.)."""
        pass

    @abstractmethod
    def get_config_schema(self) -> dict[str, Any]:
        """Retourne le schéma de configuration attendu pour ce provider."""
        pass

    @classmethod
    @abstractmethod
    def get_name(cls) -> str:
        """Nom unique du provider (ex: openai, claude, mistral, etc.)."""
        pass
