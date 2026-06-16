"""
Cross-Encoder / Reranker Provider
==================================

Optional cross-encoder/reranker for improved search quality.
Primarily useful for Ollama setups.
"""

import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from graphiti_config import GraphitiConfig

logger = logging.getLogger(__name__)


def create_cross_encoder(
    config: "GraphitiConfig", llm_client: Any = None
) -> Any | None:
    """
    Create a cross-encoder/reranker for improved search quality.

    This is optional and primarily useful for Ollama setups.
    Other providers typically have built-in reranking.

    Args:
        config: GraphitiConfig with provider settings
        llm_client: Optional LLM client for reranking

    Returns:
        Cross-encoder instance, or None if not applicable
    """
    # Only create for Ollama provider currently. For other providers we keep
    # graphiti-core's default (OpenAI reranker via OPENAI_API_KEY). Without
    # this, Graphiti's default reranker requires an OpenAI key even on a
    # fully local Ollama setup, and initialization fails.
    if config.llm_provider != "ollama":
        return None

    try:
        from graphiti_core.cross_encoder.openai_reranker_client import (
            OpenAIRerankerClient,
        )
        from graphiti_core.llm_client.config import LLMConfig
    except ImportError:
        logger.debug("Cross-encoder not available (optional)")
        return None

    try:
        # Create LLM config for reranker
        base_url = config.ollama_base_url
        if not base_url.endswith("/v1"):
            base_url = base_url.rstrip("/") + "/v1"

        llm_config = LLMConfig(
            api_key="ollama",
            model=config.ollama_llm_model,
            base_url=base_url,
        )

        # Reuse the underlying AsyncOpenAI client (already pointed at Ollama)
        # when available. OpenAIRerankerClient expects a raw AsyncOpenAI-style
        # client, not graphiti's LLMClient wrapper.
        raw_client = getattr(llm_client, "client", None)
        return OpenAIRerankerClient(client=raw_client, config=llm_config)
    except Exception as e:
        logger.warning(f"Could not create cross-encoder: {e}")
        return None
