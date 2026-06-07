"""
Tests d'intégration pour les providers LLM concrets (OpenAI, Claude, Ollama, Google, Anthropic).
Utilise des clés factices et vérifie la robustesse de l'instanciation et de la validation.
"""
import importlib.util
import sys
from pathlib import Path

import pytest

# S'assurer que la racine du projet est dans le chemin
project_root = Path(__file__).parent.parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

# Import direct des modules pour éviter les problèmes d'import imbriqués
def import_module_from_file(module_name, file_path):
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module

# Import des modules dépendants d'abord
connectors_dir = project_root / "src" / "connectors"
llm_base = import_module_from_file("src.connectors.llm_base", connectors_dir / "llm_base.py")
sys.modules["src.connectors.llm_base"] = llm_base

# Import des providers
OpenAIProvider = import_module_from_file("src.connectors.llm_openai", connectors_dir / "llm_openai.py").OpenAIProvider
ClaudeProvider = import_module_from_file("src.connectors.llm_claude", connectors_dir / "llm_claude.py").ClaudeProvider
OllamaProvider = import_module_from_file("src.connectors.llm_ollama", connectors_dir / "llm_ollama.py").OllamaProvider
GoogleLLMProvider = import_module_from_file("src.connectors.llm_google", connectors_dir / "llm_google.py").GoogleLLMProvider
AnthropicProvider = import_module_from_file("src.connectors.llm_anthropic", connectors_dir / "llm_anthropic.py").AnthropicProvider

@pytest.mark.parametrize("provider_cls,kwargs,should_validate", [
    (OpenAIProvider, {"api_key": "sk-test", "model": "gpt-3.5-turbo"}, False),
    (ClaudeProvider, {"api_key": "sk-ant-test", "model": "claude-3-sonnet-20240229"}, True),
    (OllamaProvider, {"model": "llama2"}, False),
    (GoogleLLMProvider, {"api_key": "test", "model": "gemini-2.0-flash"}, True),
    (AnthropicProvider, {"api_key": "sk-ant-test", "model": "claude-3-sonnet-20240229"}, True),
])
def test_provider_instantiation_and_validation(provider_cls, kwargs, should_validate):
    provider = provider_cls(**kwargs)
    assert hasattr(provider, "connect")
    assert hasattr(provider, "validate")
    assert hasattr(provider, "generate")
    assert hasattr(provider, "get_capabilities")
    assert hasattr(provider, "get_config_schema")
    assert hasattr(provider, "get_name")
    # New: get_name should be callable on the class
    assert isinstance(provider_cls.get_name(), str)
    assert provider.validate() == should_validate
