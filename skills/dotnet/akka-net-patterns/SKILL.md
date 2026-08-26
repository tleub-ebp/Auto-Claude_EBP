---
name: akka-net-patterns
description: Systèmes distribués Akka.NET — acteurs, supervision, clustering, persistence (event sourcing) et Akka.Streams. À utiliser pour concevoir des applications .NET scalables et résilientes à base d'acteurs, du clustering ou du stream processing avec back-pressure.
paths: "**/*.cs,**/*.csproj,**/*.sln,**/Directory.Build.props"
---

# Akka.NET — Systèmes Distribués Résilients

Patterns production pour acteurs, clustering, persistence et streams. Les exemples de code complets sont dans **[reference.md](reference.md)** — à charger seulement au moment d'implémenter.

## Concepts & décisions

| Domaine | À retenir |
|---------|-----------|
| **Hiérarchie d'acteurs** | Un parent supervise ses enfants. `OneForOneStrategy` (isole la panne) vs `AllForOneStrategy` (redémarre la fratrie). Decider → `Restart` / `Stop` / `Escalate`. |
| **Clustering** | `provider = cluster`, seed-nodes, sérialiseur Hyperion. **Toujours** un split-brain resolver (`keep-majority`). Sharding pour partitionner automatiquement les acteurs. |
| **Persistence** | `ReceivePersistentActor` : `Command<T>` persiste un event puis applique l'état ; `Recover<T>` rejoue. Snapshots périodiques pour borner le temps de recovery. |
| **Streams** | `Source → Via(stages) → Sink`, back-pressure native. `GraphStage` custom pour la logique métier ; connecteurs Kafka/RabbitMQ/SQL. |

## Squelette d'acteur persistant

```csharp
public sealed class OrderAggregate : ReceivePersistentActor
{
    private OrderState _state = OrderState.Empty;
    public override string PersistenceId => $"order-{Self.Path.Name}";

    public OrderAggregate()
    {
        Command<CreateOrder>(cmd => Persist(new OrderCreated(cmd.OrderId), Apply));
        Recover<OrderCreated>(Apply);
    }
    private void Apply(OrderCreated evt) => _state = OrderState.Active;
}
```

Configuration cluster + persistence, event sourcing complet, GraphStages, tests TestKit, Docker/K8s et observabilité : voir **[reference.md](reference.md)**.

## Anti-patterns

- ❌ État mutable partagé hors de l'acteur (casser l'isolation)
- ❌ Appels bloquants dans un acteur (utiliser `PipeTo`/`async`)
- ❌ Messages volumineux (>1 Mo) — passer une référence/clé
- ❌ Clustering sans split-brain resolver
- ❌ Persistence sans snapshots (recovery lent)
- ❌ Streams sans gestion de back-pressure

## Cas d'usage typiques

E-commerce (commandes/inventory/paiement résilients) · plateformes financières (transactions haute perf + audit trail event-sourcé) · IoT/edge (un acteur par device, stream temps réel, clustering edge).
