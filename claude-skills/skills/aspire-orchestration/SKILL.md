---
name: aspire-orchestration
description: Orchestration cloud-native .NET Aspire — applications distribuées, microservices, conteneurs, service discovery et observabilité (OpenTelemetry, health checks). À utiliser pour composer un AppHost Aspire, câbler des dépendances (Postgres/Redis/RabbitMQ) ou instrumenter des services distribués.
---

# .NET Aspire — Orchestration Cloud-Native

Aspire décrit toute l'application distribuée en C# dans un projet **AppHost** : services, dépendances (BD, cache, broker), endpoints et observabilité. Les exemples complets sont dans **[reference.md](reference.md)**.

## Modèle AppHost

```csharp
var builder = DistributedApplication.CreateBuilder(args);

builder.AddProject<Projects.OrderService>("orderservice")
    .WithReference(builder.AddPostgres("ordersdb"))   // injecte la connection string
    .WithReference(builder.AddRedis("orderscache"))
    .WithHttpEndpoint(port: 8080, name: "orderservice-http");

builder.Build().Run();
```

| Brique | Rôle |
|--------|------|
| `AddProject<T>("name")` | Déclare un service .NET orchestré |
| `AddPostgres / AddRedis / AddRabbitMQ(...)` | Provisionne une ressource conteneurisée |
| `.WithReference(resource)` | Injecte automatiquement la connection string + service discovery |
| `.WithHttpEndpoint(...)` | Expose un endpoint nommé |
| `AddServiceDefaults()` (côté service) | Active télémétrie + discovery + résilience par défaut |

## Observabilité (intégrée)

Chaque service appelle `builder.AddServiceDefaults()` puis configure OpenTelemetry (tracing + metrics) et des health checks taggés `ready`. Exposer `/health` (readiness), `/health/live` (liveness) et le scraping Prometheus. Détails et health checks custom : **[reference.md](reference.md)**.

## Déploiement

- **Dev** : docker-compose pour les dépendances, chaque conteneur avec `healthcheck` + `depends_on`.
- **Prod** : Kubernetes avec `livenessProbe` → `/health/live`, `readinessProbe` → `/health`, secrets pour les connection strings, requests/limits CPU+mémoire.
- **Résilience** : Polly (retry exponentiel + circuit breaker + timeout) sur chaque appel inter-services.

## Anti-patterns

- ❌ Service sans health checks
- ❌ Configuration hardcodée (utiliser les références Aspire + secrets)
- ❌ Appels externes sans retry/circuit breaker
- ❌ Logs non structurés / pas de tracing distribué
- ❌ Circuit breaker mal configuré (seuils/délais par défaut non revus)

## Cas d'usage

E-commerce (commandes distribuées, inventory temps réel) · SaaS multi-tenant (isolation + scaling + monitoring tenant-aware) · services financiers (haute dispo, audit trail, monitoring de latence).
