---
name: net-advanced
description: Expertise .NET 10 avancée — systèmes distribués, performance et cloud-native. Routeur vers les skills spécialisés Akka.NET, Aspire, BenchmarkDotNet et TestContainers, plus les patterns C# 14 transverses. À utiliser pour des choix d'architecture distribuée, d'optimisation mémoire ou de stratégie de test d'intégration.
---

# .NET 10 — Expertise Avancée

Vue d'ensemble et aiguillage pour le .NET 10 moderne (C# 14) : systèmes distribués, performance, cloud-native. Pour le développement applicatif général, voir le skill `net-developer`.

## Quel skill spécialisé charger ?

| Besoin | Skill |
|--------|-------|
| Acteurs, clustering, persistence, streams, event sourcing | `akka-net-patterns` |
| Orchestration cloud-native, service discovery, observabilité | `aspire-orchestration` |
| Micro-benchmarks, profiling mémoire, gates de performance | `benchmark-dotnet` |
| Tests d'intégration sur conteneurs Docker (Postgres, Redis…) | `testcontainers-integration` |

## Patterns C# 14 transverses

```csharp
// Immutabilité par défaut (records)
public sealed record OrderEvent(Guid OrderId, DateTime Timestamp, OrderEventType Type);

// Nullable reference types + composition par injection
public sealed class OrderService(IOrderRepository repository, IEventPublisher publisher)
{
    public async ValueTask<OrderResult?> ProcessAsync(OrderRequest? request)
        => request is null ? null : await Handle(request);
}

// Zéro-allocation avec Span<T>
public static bool ValidateHeader(ReadOnlySpan<byte> data)
    => data.Length >= 4 && data[..4].SequenceEqual([0x89, 0x50, 0x4E, 0x47]);
```

## Optimisation mémoire

- **`Span<T>` / `ReadOnlySpan<T>`** pour le traitement sans allocation.
- **Object pooling** (`ObjectPool<StringBuilder>`) pour les objets coûteux et fréquents.
- **`IAsyncEnumerable<T>`** (`AsAsyncEnumerable()`) pour streamer les gros datasets sans tout charger.

## Architecture

**Clean Architecture** : `Domain/` (entités, value objects, events) → `Application/` (use cases, services, DTOs) → `Infrastructure/` (EF Core, externes, messaging) → `API/` (controllers, minimal APIs).

**Microservices** : composer via Aspire (skill `aspire-orchestration`) plutôt que docker-compose manuel ; CQRS via MediatR ; event sourcing via Akka.Persistence (skill `akka-net-patterns`).

## Anti-patterns à éviter

- ❌ AutoMapper → préférer un mapping explicite ou Mapster
- ❌ Lazy loading dans les APIs → projections explicites
- ❌ Réflexion lourde → source generators
- ❌ Classes mutables non `sealed` → `sealed record` / immutabilité par défaut
- ❌ Tests sans isolation → TestContainers
