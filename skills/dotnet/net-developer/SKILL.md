---
name: net-developer
description: Développement .NET moderne (C# 14, ASP.NET Core 10, EF Core 10, Blazor, Azure). À utiliser pour créer, structurer, tester et déployer des applications .NET — APIs REST, microservices, Clean Architecture, DDD, CQRS. Voir aussi le skill net-advanced pour Akka.NET/Aspire/benchmarks/TestContainers.
paths: "**/*.cs,**/*.csproj,**/*.sln,**/Directory.Build.props"
---

# Développeur .NET

Développer des applications .NET robustes, scalables et maintenables.

## Stack de référence

- **Runtime** : .NET 10, C# 14 (params spans, extension types, pattern matching amélioré)
- **Web/API** : ASP.NET Core 10 (minimal APIs), EF Core 10, Blazor
- **Architecture** : Clean Architecture, DDD, CQRS (MediatR), Repository + Specification, Circuit Breaker (Polly)
- **Données** : SQL Server, PostgreSQL, SQLite, Redis, Cosmos DB
- **Tests** : xUnit, Moq, FluentAssertions, TestContainers, BenchmarkDotNet, Playwright
- **Cloud/DevOps** : Azure, Docker, Kubernetes, GitHub Actions / Azure DevOps, Terraform

## Workflow projet

1. **Cadrage** — besoins métier, contraintes, architecture cible (monolithe vs microservices), choix BD/hébergement.
2. **Init** — `python scripts/create_project.py --name MyApp --type webapi --framework net10.0 --database postgresql --architecture clean`
3. **Structure en couches** :
   ```
   src/
   ├── MyApp.Domain/          # entités, value objects, domain events
   ├── MyApp.Application/     # use cases, services, DTOs
   ├── MyApp.Infrastructure/  # EF Core, services externes, messaging
   ├── MyApp.API/             # contrôleurs / minimal APIs
   └── MyApp.Tests/           # unitaires + intégration
   ```
4. **Développement** — entités → services applicatifs → endpoints → tests. Ajouter une entité : `python scripts/add_entity.py --name Product --properties "string:Name,decimal:Price"`
5. **Tests** — `dotnet test --configuration Release --collect:"XPlat Code Coverage"` ; intégration via `--filter Category=Integration`.
6. **Déploiement** — build Release, image Docker, déploiement (Azure App Service / Kubernetes), variables d'env, monitoring.

## Scripts & templates

- `scripts/create_project.py` — `--type` (webapi|blazor|console|classlib|worker) · `--framework` · `--database` · `--architecture` (clean|hexagonal|onion). Lancer `--help`.
- `scripts/add_entity.py` — génère entité + repository + tests.
- `examples/` — modèles prêts à l'emploi : `webapi-template.cs`, `entity-template.cs`, `test-template.cs`, `dockerfile`, `github-actions.yml`.

## Bonnes pratiques

**Qualité** : conventions C# (PascalCase public / camelCase privé), SOLID + composition, `async/await` (ValueTask), nullable reference types activés, immutabilité par défaut (records, readonly structs). Éviter AutoMapper et la réflexion lourde (préférer source generators).

**Performance** : `AsNoTracking()` en lecture seule, caching des données chaudes, connection pooling, `Span<T>` pour le zéro-allocation, object pooling, `IAsyncEnumerable` pour les gros datasets, pas de lazy loading dans les APIs.

**Sécurité** : ASP.NET Core Identity, politiques d'autorisation, validation systématique des entrées, HTTPS forcé en production.

**Observabilité** : logging structuré (Serilog), health checks, OpenTelemetry (+ Application Insights sur Azure), métriques et tracing distribué.
