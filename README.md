# WorkPilot AI

**Autonomous multi-agent coding framework that plans, builds, and validates software for you.**

![WorkPilot AI Kanban Board](.github/assets/WorkPilot-AI-Kanban.png)

[![License](https://img.shields.io/badge/license-AGPL--3.0-green?style=flat-square)](./agpl-3.0.txt)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/KCXaPBr4Dj)
[![YouTube](https://img.shields.io/badge/YouTube-Subscribe-FF0000?style=flat-square&logo=youtube&logoColor=white)](https://www.youtube.com/@AndreMikalsen)
[![CI](https://img.shields.io/github/actions/workflow/status/tleub-ebp/WorkPilot-AI/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/tleub-ebp/WorkPilot-AI/actions)

---

## Download

### Stable Release

<!-- STABLE_VERSION_BADGE -->
[![Stable](https://img.shields.io/badge/stable-1.0.0-blue?style=flat-square)](https://github.com/tleub-ebp/WorkPilot-AI/releases/tag/v1.0.0)
<!-- STABLE_VERSION_BADGE_END -->

<!-- STABLE_DOWNLOADS -->
| Platform | Download |
|----------|----------|
| **Windows** | [WorkPilot-AI-1.0.0-win32-x64.exe](https://github.com/tleub-ebp/WorkPilot-AI/releases/download/v1.0.0/WorkPilot-AI-1.0.0-win32-x64.exe) |
| **macOS (Apple Silicon)** | [WorkPilot-AI-1.0.0-darwin-arm64.dmg](https://github.com/tleub-ebp/WorkPilot-AI/releases/download/v1.0.0/WorkPilot-AI-1.0.0-darwin-arm64.dmg) |
| **macOS (Intel)** | [WorkPilot-AI-1.0.0-darwin-x64.dmg](https://github.com/tleub-ebp/WorkPilot-AI/releases/download/v1.0.0/WorkPilot-AI-1.0.0-darwin-x64.dmg) |
| **Linux** | [WorkPilot-AI-1.0.0-linux-x86_64.AppImage](https://github.com/tleub-ebp/WorkPilot-AI/releases/download/v1.0.0/WorkPilot-AI-1.0.0-linux-x86_64.AppImage) |
| **Linux (Debian)** | [WorkPilot-AI-1.0.0-linux-amd64.deb](https://github.com/tleub-ebp/WorkPilot-AI/releases/download/v1.0.0/WorkPilot-AI-1.0.0-linux-amd64.deb) |
| **Linux (Flatpak)** | [WorkPilot-AI-1.0.0-linux-x86_64.flatpak](https://github.com/tleub-ebp/WorkPilot-AI/releases/download/v1.0.0/WorkPilot-AI-1.0.0-linux-x86_64.flatpak) |
<!-- STABLE_DOWNLOADS_END -->

### Beta Release

> Beta releases may contain bugs and breaking changes. [View all releases](https://github.com/tleub-ebp/WorkPilot-AI/releases)

<!-- BETA_VERSION_BADGE -->
[![Beta](https://img.shields.io/badge/beta-1.0.0--alpha-orange?style=flat-square)](https://github.com/tleub-ebp/WorkPilot-AI/releases/tag/v1.0.0-alpha.1)
<!-- BETA_VERSION_BADGE_END -->

<!-- BETA_DOWNLOADS -->
| Platform | Download |
|----------|----------|
| **Windows** | [WorkPilot-AI-1.0.0-alpha.1-win32-x64.exe](https://github.com/tleub-ebp/WorkPilot-AI/releases/download/v1.0.0-alpha.1/WorkPilot-AI-1.0.0-alpha.1-win32-x64.exe) |
| **macOS (Apple Silicon)** | [WorkPilot-AI-1.0.0-alpha.1-darwin-arm64.dmg](https://github.com/tleub-ebp/WorkPilot-AI/releases/download/v1.0.0-alpha.1/WorkPilot-AI-1.0.0-alpha.1-darwin-arm64.dmg) |
| **macOS (Intel)** | [WorkPilot-AI-1.0.0-alpha.1-darwin-x64.dmg](https://github.com/tleub-ebp/WorkPilot-AI/releases/download/v1.0.0-alpha.1/WorkPilot-AI-1.0.0-alpha.1-darwin-x64.dmg) |
| **Linux** | [WorkPilot-AI-1.0.0-alpha.1-linux-x86_64.AppImage](https://github.com/tleub-ebp/WorkPilot-AI/releases/download/v1.0.0-alpha.1/WorkPilot-AI-1.0.0-alpha.1-linux-x86_64.AppImage) |
| **Linux (Debian)** | [WorkPilot-AI-1.0.0-alpha.1-linux-amd64.deb](https://github.com/tleub-ebp/WorkPilot-AI/releases/download/v1.0.0-alpha.1/WorkPilot-AI-1.0.0-alpha.1-linux-amd64.deb) |
| **Linux (Flatpak)** | [WorkPilot-AI-1.0.0-alpha.1-linux-x86_64.flatpak](https://github.com/tleub-ebp/WorkPilot-AI/releases/download/v1.0.0-alpha.1/WorkPilot-AI-1.0.0-alpha.1-linux-x86_64.flatpak) |
<!-- BETA_DOWNLOADS_END -->

> All releases include SHA256 checksums and VirusTotal scan results for security verification.

---

## Quick Start

1. **Download and install** the app for your platform
2. **Open your project** — select a git repository folder
3. **Connect your AI provider** — Claude (OAuth), API key, or any OpenAI-compatible endpoint
4. **Create a task** — describe what you want to build
5. **Watch it work** — agents plan, code, and validate autonomously

Or from source:

```sh
pnpm install
pnpm run dev
```

See the [Setup Guide](docs/SETUP.md) for detailed instructions.

---

## Features

### Autonomous Development Pipeline

| Feature | Description |
|---------|-------------|
| **Kanban Board** | Visual task management from planning through completion with real-time agent progress |
| **Multi-Agent Pipeline** | Planner → Coder → QA Reviewer → QA Fixer pipeline runs autonomously end-to-end |
| **Parallel Execution** | Up to 12 simultaneous agent terminals for parallel builds |
| **Isolated Workspaces** | Every task runs in a dedicated git worktree — your main branch stays safe |
| **AI-Powered Merge** | Semantic conflict resolution when integrating worktrees back to main |
| **QA Auto-Fix Loop** | Agents automatically detect, fix, and revalidate failing acceptance criteria |
| **Spec Approval Workflow** | Review and approve AI-generated specifications before implementation begins |
| **Hot-Swap LLM** | Change provider, model, or reasoning effort mid-task — the next turn resumes on the new engine with context replayed |
| **Pause & Resume** | Suspend a running task and resume later with full context preserved, optionally on a different provider |
| **Per-Phase Re-run** | Redo any phase (planning, coding, validation) on demand without restarting the whole task |
| **PR-First Review Flow** | Guided human-review with a DoD checklist, "approve & close", and reversible task abandon |

### Multi-Agent Orchestration

| Feature | Description |
|---------|-------------|
| **Mission Control** | NASA-style dashboard for orchestrating multiple agents simultaneously — live status, token consumption, file changes, and per-agent reasoning |
| **Agent Replay & Debug** | Step-by-step replay of any agent session with timeline navigation, file diffs, breakpoints, and token heatmaps |
| **Decision Logger** | Real-time visualization of agent decision trees and trade-off rationale |
| **Consensus Arbiter** | Reconciles conflicting opinions from security scans and QA reviewers into a single verdict |
| **Agent Coach** | Analyzes real usage to suggest cheaper models, better effort levels, and prompt tweaks per agent |
| **Pair Programming** | Interactive real-time AI coding partner with live suggestions and conversation-driven development |
| **Learning Mode** | Educational mode with step-by-step explanations of agent decisions |

### Specialized Agents

| Agent | Role |
|-------|------|
| **Planner** | Complexity assessment, phased subtask breakdown, dependency analysis |
| **Coder** | Context-aware implementation with parallel subagent spawning |
| **QA Reviewer / Fixer** | Acceptance criteria validation and automated issue resolution |
| **Test Generator** | Unit and integration test generation with live streaming of the code as it is written |
| **Flaky Test Detective** | Parses test reports (JUnit XML, .NET TRX, …) to surface intermittently failing tests |
| **Refactorer** | Safe code refactoring with pattern detection and API migration |
| **Documenter** | README, API docs, and architecture documentation generation |
| **Migration Agent** | Framework and library migration with breaking change detection |
| **Release Coordinator** | Orchestrates release readiness, changelog, and version bumps |
| **Memory Manager** | Graphiti-based knowledge graph management across sessions |

### Integrations

| Platform | Capabilities |
|----------|-------------|
| **GitHub** | Import issues, AI investigation, PR review, batch review wizard, auto-PR creation |
| **GitLab** | Issues and merge request management with AI severity categorization |
| **Azure DevOps** | Work item import, PR review, batch operations — _experimental: backend still returns mock data for several endpoints, see [shared_docs/CONFIGURATION.md](shared_docs/CONFIGURATION.md)_ |
| **Linear** | Bulk issue import with team/project filtering |
| **Jira** | Issue management integration |
| **MCP Marketplace** | Browse, install, and configure Model Context Protocol servers |
| **Custom MCPs** | Define and host custom MCP servers with local authentication |
| **Windsurf** | Windsurf IDE integration via Connect protocol |

### AI Providers & Authentication

| Provider | Auth Method |
|----------|-------------|
| **Anthropic Claude** | OAuth (subscription) or API key |
| **OpenAI** | OAuth (subscription) or API key |
| **Google Gemini** | API key |
| **Grok / xAI** | API key |
| **Ollama** | Local endpoint |
| **Azure OpenAI** | API key + endpoint |
| **GitHub Copilot** | OAuth (subscription) or API key |
| **Custom endpoints** | Any OpenAI-compatible API (e.g. z.ai for GLM models) |

**Multi-account switching** — Register multiple profiles per provider. WorkPilot AI automatically switches to an available account when one hits a rate limit.

### Code Intelligence

| Feature | Description |
|---------|-------------|
| **Insights** | AI chat interface for exploring and understanding your codebase with semantic search |
| **Ideation** | Discovers performance bottlenecks, security vulnerabilities, code quality issues, and UI/UX improvements |
| **Architecture Visualizer** | Dependency graphs, module hierarchy, and component relationship diagrams |
| **Performance Profiler** | AI-powered bottleneck identification with optimization suggestions |
| **Dependency Sentinel** | Monitors security vulnerabilities, version conflicts, and outdated dependencies |
| **Self-Healing Codebase** | Automatically generates fixes when CI tests fail; integrates with Sentry, Datadog, PagerDuty for production incidents |
| **Technical Debt Tracker** | Continuously scores code health, tracks and ages debt items, and proposes auto-fixes with PRs |
| **Risk Classifier** | Scores code changes by risk level with impact assessment |

### Developer Productivity

| Feature | Description |
|---------|-------------|
| **Guided Onboarding** | Setup Hub checklist plus a step-by-step coachmark tour to configure providers and integrations |
| **Roadmap** | AI-assisted feature planning with prioritization and phased rollout |
| **Changelog** | Auto-generates release notes from completed tasks |
| **Natural Language Git** | AI-generated semantic commit messages from diffs |
| **Auto-Refactoring** | Pattern-based and architectural code transformations |
| **Code Migration** | Large-scale codebase migrations across frameworks and libraries |
| **Design to Code** | Converts UI mockups and screenshots to React/HTML |
| **Pipeline Generator** | Generates GitHub Actions, GitLab CI, and Azure Pipelines configurations |
| **Browser Agent** | Autonomous browser interaction for E2E test generation and visual regression |
| **Arena Mode** | Side-by-side comparison of different AI models on the same task |
| **Voice Control** | Hands-free task and terminal control via speech-to-text |
| **Multi-Repo Orchestration** | Coordinate changes across multiple repositories simultaneously |
| **Code Playground** | Sandbox environment for testing code snippets in isolation |
| **Prompt Optimizer** | Analyzes and rewrites prompts for better AI output |

### Memory & Context

| Feature | Description |
|---------|-------------|
| **Memory System (Graphiti)** | Graph-based semantic memory — agents retain insights across sessions |
| **Skills System** | Token-optimized dynamic skill execution with checkpoint-based context management |
| **Context Management** | Intelligent context building with file relevance ranking and dependency graph analysis |
| **Session History** | Browse and replay past agent sessions with full statistics |

### Analytics & Monitoring

| Feature | Description |
|---------|-------------|
| **Analytics Dashboard** | Token consumption, cost tracking, success rates, and execution time metrics — live SQLite-backed API; falls back to an explicit 503 when the analytics DB is unavailable |
| **Formula Lab** | Pre-flight cost/success estimation per Provider × Model × Effort, calibrated on your real usage history |
| **Cost Estimator** | Per-task cost calculation with provider comparison and budget alerts |
| **Carbon Profiler** | Estimates the energy (kWh) and carbon footprint of your agent runs |
| **Rate Limit Monitor** | Real-time usage tracking with proactive warnings and auto-switching triggers |
| **Workflow Logger** | Structured execution logs with trace IDs for all agents, skills, and hooks |

### Customization

| Feature | Description |
|---------|-------------|
| **7+ Color Themes** | Default, Dusk, Lime, Ocean, Retro, Neo — each with light and dark variants |
| **Custom Theme Editor** | Color picker with live preview, export, and import |
| **Bilingual UI** | Full French and English interface |
| **Command Palette** | Keyboard-driven access to all features with fuzzy search |
| **Plugin Marketplace** | Browse and install community plugins |

### Deployment & Team

| Feature | Description |
|---------|-------------|
| **Multi-User Server Mode** | Central deployment with JWT / Microsoft Entra auth, per-user claims, and a shared run manager |
| **Invitation-Only Signup** | Self-service registration gated by admin invitations, with SMTP delivery and rate limiting |
| **Notifications** | Multi-channel "PR ready" alerts (Slack, email, webhook) with SSRF hardening |

---

## Interface

### Kanban Board
Visual task management from planning through completion. Create tasks and monitor agent progress in real-time.

### Agent Terminals
AI-powered terminals with one-click task context injection. Spawn multiple agents for parallel work.

![Agent Terminals](.github/assets/WorkPilot-AI-Agents-terminals.png)

### Mission Control
NASA-style multi-agent orchestration hub with per-agent monitoring, model assignment, and live decision visualization.

### Roadmap
AI-assisted feature planning with competitor analysis and audience targeting.

![Roadmap](.github/assets/WorkPilot-AI-roadmap.png)

### Additional Views
- **Insights** — AI chat for codebase exploration and semantic search
- **Ideation** — Discover improvements, vulnerabilities, and performance issues
- **Changelog** — Generate release notes from completed tasks
- **Architecture Visualizer** — Interactive dependency and module graphs
- **Agent Replay** — Step-by-step session replay with breakpoints and diffs
- **Analytics** — Usage, cost, and performance dashboards

---

## Architecture Détaillée

### Vue d'Ensemble

WorkPilot AI est une application de bureau autonome basée sur une architecture multi-agents qui orchestre le cycle de vie complet du développement logiciel. Le système combine un backend Python puissant avec une interface utilisateur Electron moderne pour offrir une expérience de développement transparente.

### Architecture Multi-Agents

#### Pipeline Autonome de Développement
1. **Agent Planner** - Analyse la complexité et décompose les tâches en sous-tâches
2. **Agent Coder** - Implémente les fonctionnalités avec des sous-agents parallèles
3. **Agent QA Reviewer** - Valide les implémentations selon les critères d'acceptation
4. **Agent QA Fixer** - Résout automatiquement les problèmes identifiés

#### Agents Spécialisés
- **Test Generator** - Génération de tests unitaires et d'intégration
- **Refactorer** - Refactoring sécurisé du code avec détection de patterns
- **Documenter** - Génération automatique de documentation
- **Migration Agent** - Migration de frameworks et bibliothèques
- **Memory Manager** - Gestion de la base de connaissances Graphiti

### Architecture Technique

#### Backend Python (`apps/backend/`)
```
apps/backend/
├── core/                # Client, authentification, worktree, plateforme
│   ├── client.py        # Client Claude Agent SDK
│   ├── auth.py          # Gestion multi-profils OAuth
│   ├── worktree.py      # Isolation des espaces de travail Git
│   └── platform.py      # Abstraction cross-plateforme
├── agents/              # Logique d'exécution des agents
│   ├── planner/         # Agent de planification
│   ├── coder/           # Agent de développement
│   └── session/         # Gestion des sessions
├── qa/                  # Pipeline de validation QA
│   ├── reviewer/        # Validation des critères
│   ├── fixer/           # Résolution automatique
│   └── loop/            # Boucle de validation
├── spec/                # Création et gestion des specs
├── skills/              # Système de compétences AI optimisé
├── cli/                 # Interface ligne de commande
├── context/             # Construction du contexte des tâches
├── services/            # Services d'intégration externes
├── integrations/        # Connecteurs (GitHub, GitLab, etc.)
├── project/             # Analyse et détection de projets
├── merge/               # Système de fusion sémantique
├── self_healing/        # Surveillance de santé + auto-réparation
├── tech_debt/           # Suivi et résolution de la dette technique
├── consensus_arbiter/   # Arbitrage des avis d'agents (sécurité/QA)
├── agent_coach/         # Conseils coût/modèle basés sur l'usage réel
├── carbon_profiler/     # Empreinte énergie/carbone des exécutions
├── release_coordinator/ # Préparation des releases
├── flaky_test_detective/# Détection des tests instables
├── streaming/           # Diffusion temps réel des sessions d'agents
├── server/              # Mode serveur multi-utilisateurs (auth, claims)
└── prompts/             # Prompts des agents (60+ agents spécialisés)
```

> Le backend s'est étoffé en **90+ modules spécialisés** (accessibilité, dérive d'architecture, gouvernance de licences, orchestration multi-repo, etc.). Voir [apps/backend/README.md](apps/backend/README.md) et la [table des modules du wiki](https://github.com/tleub-ebp/WorkPilot-AI/wiki) pour l'inventaire complet auto-généré.

#### Frontend Electron (`apps/frontend/`)
```
apps/frontend/src/
├── main/                # Processus principal Electron
│   ├── agent/           # Gestion des files d'attente
│   ├── claude-profile/  # Gestion multi-profils
│   ├── terminal/        # Daemon PTY et cycle de vie
│   ├── platform/        # Abstraction cross-plateforme
│   ├── ipc-handlers/    # 40+ modules de gestion IPC
│   └── services/        # Récupération de session SDK
├── renderer/            # Interface React
│   ├── features/        # Modules fonctionnels auto-contenus
│   │   ├── tasks/       # Gestion des tâches, kanban
│   │   ├── terminals/   # Émulation de terminal
│   │   ├── projects/    # Gestion de projet, explorateur
│   │   ├── settings/    # Paramètres application/projet
│   │   ├── roadmap/     # Génération de roadmap
│   │   ├── insights/    # Analyse de code
│   │   └── agents/      # Gestion profils Claude
│   ├── shared/          # Ressources partagées
│   └── hooks/           # Hooks au niveau application
└── shared/              # Partagé main/renderer
    ├── types/           # Définitions TypeScript
    ├── constants/       # Constantes application
    └── utils/           # Utilitaires partagés
```

### Flux de Données et État

#### Flux d'Exécution des Agents
1. **Création de Tâche** → Utilisateur crée une tâche dans l'UI/CLI
2. **Génération de Spec** → L'AI analyse la complexité et crée une spécification
3. **Phase de Planification** → Le Planner décompose en sous-tâches
4. **Implémentation** → Le Coder exécute avec des sous-agents parallèles
5. **Validation QA** → Le Reviewer valide l'implémentation
6. **Résolution des Problèmes** → Le Fixer résout les problèmes identifiés
7. **Phase de Fusion** → Fusion sémantique vers la branche principale

#### Gestion d'État
- **État Projet** → `project-store.ts`
- **État Tâche/Spec** → `task-store.ts`
- **État Terminal** → `terminal-store.ts`
- **État Agent** → `agent-state.ts`
- **État Paramètres** → `settings-store.ts`

### Sécurité et Isolation

#### Modèle de Sécurité à 3 Couches
1. **Sandbox OS** → Commandes Bash exécutées en isolation
2. **Restrictions Filesystem** → Opérations limitées au répertoire projet
3. **Allowlist Dynamique** → Commandes approuvées selon la stack détectée

#### Gestion des Credentials
- **Système de Profils Claude** → Gestion OAuth multi-comptes
- **Stockage Secure** → Keychain OS / Credential Manager
- **Rotation Automatique** → Cycle de vie des tokens OAuth
- **Validation Input** → Chemins et commandes sanitizées

### Performance et Scalabilité

#### Modèle de Concurrence
- **Parallélisme d'Agents** → Jusqu'à 12 terminaux AI parallèles
- **Opérations Async** → I/O non-bloquant partout
- **Pooling de Ressources** → Connexions et sessions réutilisées
- **Load Balancing** → Switching automatique multi-comptes

#### Optimisations
- **Optimisation Tokens** → Compression et cache du contexte
- **Gestion Mémoire** → Cleanup agressif et checkpoints
- **Optimisation Réseau** → Pooling de connexions et retries
- **Performance UI** → Virtual scrolling et lazy loading

---

## Installation et Configuration

### Prérequis Système

#### Configuration Matérielle Minimale
- **OS** : Windows 10+, macOS 10.15+, Ubuntu 20.04+
- **RAM** : 8GB minimum (16GB recommandé)
- **Stockage** : 2GB d'espace libre
- **Réseau** : Connexion internet stable

#### Dépendances Logicielles
- **Node.js v24.12.0 LTS** (Requis)
- **Python 3.12+** (Pour le backend)
- **Git** (Dépôt initialisé obligatoire)
- **Claude Code CLI** : `pnpm install -g @anthropic-ai/claude-code`

### Méthodes d'Installation

#### Option 1 : Application Bureau (Recommandé)

1. **Téléchargement**
   - Visitez [GitHub Releases](https://github.com/tleub-ebp/WorkPilot-AI/releases)
   - Téléchargez la version stable pour votre plateforme

2. **Installation**
   - **Windows** : Exécutez `WorkPilot-AI-1.0.0-win32-x64.exe`
   - **macOS** : Ouvrez `WorkPilot-AI-1.0.0-darwin-arm64.dmg`
   - **Linux** : Lancez `WorkPilot-AI-1.0.0-linux-x86_64.AppImage`

3. **Premier Lancement**
   - Lancez l'application
   - Suivez l'assistant de configuration
   - Connectez votre provider AI

#### Option 2 : Développement depuis Source

1. **Clonage du Dépôt**
   ```bash
   git clone https://github.com/tleub-ebp/WorkPilot-AI.git
   cd Auto-Claude_EBP
   ```

2. **Installation Automatique**
   ```bash
   pnpm install
   pnpm run dev
   ```
   *Crée automatiquement l'environnement virtuel Python et installe toutes les dépendances*

3. **Lancement Manuel**
   ```bash
   # Backend
   cd apps/backend
   python -m pip install -r requirements.txt
   
   # Frontend
   cd ../frontend
   pnpm install
   pnpm run dev
   ```

### Configuration des Providers AI

#### Authentification Claude (Recommandé)
```bash
claude
# Tapez : /login
# Appuyez sur Entrée pour ouvrir le navigateur
```
*Le token est automatiquement sauvegardé dans le Keychain OS*

#### Configuration Multi-Providers
| Provider | Méthode | Configuration |
|----------|---------|---------------|
| **Anthropic Claude** | OAuth ou API Key | `ANTHROPIC_API_KEY` |
| **OpenAI** | API Key | `OPENAI_API_KEY` |
| **Google Gemini** | API Key | `GOOGLE_API_KEY` |
| **Grok / xAI** | API Key | `XAI_API_KEY` |
| **Ollama** | Endpoint local | `OLLAMA_BASE_URL` |
| **GitHub Copilot** | OAuth | Via interface |
| **Azure OpenAI** | API Key + Endpoint | `AZURE_OPENAI_*` |

#### Variables d'Environnement Optionnelles
```bash
# .env-files/.env
AUTO_BUILD_MODEL=claude-opus-4-8
DEBUG=true
LINEAR_API_KEY=votre_clé_linear
GRAPHITI_ENABLED=true
```

### Configuration du Projet

#### Structure de Projet Requise
```
votre-projet/
├── .git/                # Obligatoire : dépôt Git initialisé
├── package.json         # Pour projets Node.js
├── requirements.txt     # Pour projets Python
├── Cargo.toml           # Pour projets Rust
└── ...                  # Vos fichiers de code
```

#### Détection Automatique de Stack
WorkPilot AI détecte automatiquement :
- **Framework** : React, Vue, Angular, Django, Flask, Express
- **Language** : TypeScript, JavaScript, Python, Rust, Go
- **Build Tools** : Vite, Webpack, Cargo, Poetry
- **Testing** : Jest, Pytest, Vitest, Playwright

### Validation de l'Installation

#### Tests de Connexion
```bash
# Test du provider AI
pnpm test:provider

# Test du backend
pnpm test:backend

# Test complet de l'application
pnpm test
```

#### Vérification de l'Environnement
```bash
# Version Node.js
node --version  # v24.12.0

# Version Python
python --version  # 3.12+

# Configuration Claude
claude --version
```

### Dépannage Courant

#### Problèmes d'Installation
- **Node.js non trouvé** : Réinstallez depuis https://nodejs.org avec "Add to PATH"
- **Modules natifs** : `pnpm run rebuild` dans `apps/frontend`
- **Python manquant** : Installez Python 3.10+ et ajoutez au PATH

#### Problèmes d'Authentification
- **Token Claude expiré** : `claude` puis `/login`
- **API Key invalide** : Vérifiez les variables d'environnement
- **Problèmes OAuth** : Révoquez et réautorisez l'application

#### Problèmes de Performance
- **Mémoire insuffisante** : Fermez les applications inutiles
- **Timeout réseau** : Vérifiez votre connexion internet
- **Lenteur UI** : Redémarrez l'application

---

## Project Structure

```
WorkPilot-AI/
├── apps/
│   ├── backend/     # Python agents, specs, QA pipeline, integrations
│   └── frontend/    # Electron desktop application (React + TypeScript)
├── docs/            # Documentation and guides
├── tests/           # Test suite
└── scripts/         # Build and release utilities
```

---

## CLI Usage

For headless operation, CI/CD integration, or terminal-only workflows:

```bash
cd apps/backend
python spec_runner.py --interactive   # Create a spec interactively
python run.py --spec 001              # Run autonomous build
python run.py --spec 001 --review     # Review
python run.py --spec 001 --merge      # Merge
```

See [docs/CLI-USAGE.md](docs/CLI-USAGE.md) for the full CLI reference.

---

## Security

WorkPilot AI uses a three-layer security model:

1. **OS Sandbox** — Bash commands run in isolation
2. **Filesystem Restrictions** — Operations limited to project directory
3. **Dynamic Command Allowlist** — Only approved commands based on detected project stack

All releases include SHA256 checksums and VirusTotal scans.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Setup Guide](docs/SETUP.md) | Installation, requirements, scripts, dev environment |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Common issues and fixes |
| [Providers Guide](docs/PROVIDERS.md) | Multi-provider LLM setup |
| [CLI Usage](docs/CLI-USAGE.md) | Headless / CI usage |
| [Contributing](CONTRIBUTING.md) | Code style, testing, PR process |
| [Linux Guide](docs/linux.md) | Flatpak, AppImage builds |

---

## Contributing

We welcome contributions! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, testing requirements, and PR process.

---

## Community

- **Issues** — [Report bugs or request features](https://github.com/tleub-ebp/WorkPilot-AI/issues)
- **Discussions** — [Ask questions](https://github.com/tleub-ebp/WorkPilot-AI/discussions)

---

## License

**AGPL-3.0** — GNU Affero General Public License v3.0

WorkPilot AI is free to use. If you modify and distribute it, or run it as a service, your code must also be open source under AGPL-3.0. Commercial licensing available for closed-source use cases.

---

## Star History

[![GitHub Repo stars](https://img.shields.io/github/stars/tleub-ebp/WorkPilot-AI?style=social)](https://github.com/tleub-ebp/WorkPilot-AI/stargazers)

[![Star History Chart](https://api.star-history.com/svg?repos=tleub-ebp/WorkPilot-AI&type=Date)](https://star-history.com/#tleub-ebp/WorkPilot-AI&Date)
