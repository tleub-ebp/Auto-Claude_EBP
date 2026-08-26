---
name: testcontainers-integration
description: Tests d'intégration .NET sur conteneurs Docker réels avec Testcontainers — PostgreSQL, Redis, RabbitMQ, services cloud-native. À utiliser pour tester du code contre de vraies dépendances dans des environnements jetables et isolés, en local comme en CI.
paths: "**/*.cs,**/*.csproj,**/*.sln,**/Directory.Build.props"
---

# Testcontainers — Tests d'Intégration Distribués

Tester contre de **vraies** dépendances (BD, cache, broker) dans des conteneurs Docker éphémères, à port dynamique, démarrés/détruits automatiquement. Les exemples complets (Postgres/Redis/RabbitMQ, multi-service, CI/CD) sont dans **[reference.md](reference.md)**.

## Modèle (API moderne par module)

Utiliser les builders dédiés (`Testcontainers.PostgreSql`, `.Redis`, `.RabbitMq`…) — l'ancien `TestcontainersBuilder<T>` générique est déprécié.

```csharp
using Testcontainers.PostgreSql;

public sealed class DbFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _db = new PostgreSqlBuilder()
        .WithImage("postgres:16-alpine").Build();

    public string ConnectionString => _db.GetConnectionString();   // port dynamique résolu
    public Task InitializeAsync() => _db.StartAsync();              // wait strategy intégrée
    public Task DisposeAsync() => _db.DisposeAsync().AsTask();
}
```

| Étape | API |
|-------|-----|
| Démarrer | `IAsyncLifetime.InitializeAsync` → `container.StartAsync()` |
| Se connecter | `container.GetConnectionString()` (jamais un port hardcodé) |
| Partager dans une classe | `IClassFixture<TFixture>` |
| Partager entre classes | collection fixture (`ICollectionFixture<T>` + `[Collection]`) — coûteux à démarrer, on mutualise |
| Nettoyer | `DisposeAsync()` (auto via Ryuk même si le process crashe) |

## Bonnes pratiques

- **Toujours `IAsyncLifetime`** (async) plutôt que `.Wait()` bloquant.
- **Port dynamique + `GetConnectionString()`** : jamais de port fixe (collisions en CI).
- **Isolation** : chaque test/collection part d'un état propre ; ne dépend pas de l'ordre d'exécution.
- **CI** : runner avec Docker (`ubuntu-latest` l'a). Filtrer via `dotnet test --filter Category=Integration`.
- **Local rapide** : activer la réutilisation (`.WithReuse(true)` + `TESTCONTAINERS_REUSE_ENABLE=true`).

## Anti-patterns

- ❌ Ports hardcodés
- ❌ Pas de cleanup / pas de `DisposeAsync`
- ❌ Tests dépendants de l'ordre d'exécution
- ❌ Pas de wait strategy / pas de timeout de démarrage
- ❌ Isolation incomplète (état partagé entre tests)
- ❌ Jeux de données trop volumineux (lenteur)

## Cas d'usage

Microservices (intégration inter-services, résilience/retry) · migrations de schéma (validation + perf de requêtes + concurrence) · files de messages (delivery, dead-letter, throughput).
