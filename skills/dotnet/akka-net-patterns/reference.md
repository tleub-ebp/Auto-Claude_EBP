# Akka.NET — Exemples de référence

Code production complet, à charger uniquement lors de l'implémentation. Le SKILL.md couvre les décisions et les gotchas.

## Hiérarchie d'acteurs + supervision

```csharp
public sealed class OrderManagerActor : ReceivePersistentActor
{
    private readonly IActorRef _orderProcessor;
    private readonly IActorRef _inventoryManager;

    public OrderManagerActor()
    {
        var strategy = new OneForOneStrategy(
            maxNumberOfRetries: 3,
            withinTimeRange: TimeSpan.FromMinutes(1),
            decider: Decider.From(Directive.Restart, Directive.Stop, Directive.Escalate));

        _orderProcessor = Context.ActorOf(
            Props.Create<OrderProcessorActor>().WithSupervisorStrategy(strategy), "order-processor");
        _inventoryManager = Context.ActorOf<InventoryManagerActor>("inventory-manager");
    }

    protected override void OnCommand(object message)
    {
        switch (message)
        {
            case CreateOrder cmd:
                Persist(new OrderCreated(cmd.OrderId, cmd.CustomerId), OnOrderCreated);
                break;
            case GetOrderStatus query:
                Sender.Tell(_orderProcessor.Ask<OrderStatus>(query));
                break;
        }
    }

    private void OnOrderCreated(OrderCreated evt) => _orderProcessor.Tell(evt);
}
```

## Configuration cluster (HOCON)

```csharp
var config = ConfigurationFactory.ParseString(@"
    akka {
        actor {
            provider = cluster
            serializers { hyperion = ""Akka.Serialization.Hyperion.HyperionSerializer, Akka.Serialization.Hyperion"" }
            serialization-bindings { ""System.Object"" = hyperion }
        }
        remote.dot-netty.tcp {
            hostname = ""0.0.0.0""
            port = 0
            public-hostname = ""localhost""
            public-port = 4053
        }
        cluster {
            seed-nodes = [""akka.tcp://OrderSystem@localhost:4051""]
            downing-provider-class = ""Akka.Cluster.SplitBrainResolver, Akka.Cluster""
            split-brain-resolver {
                active-strategy = keep-majority
                keep-majority { role = """" }
            }
        }
        persistence {
            journal.plugin = ""akka.persistence.journal.sql-server""
            journal.sql-server {
                connection-string = ""Server=localhost;Database=OrderSystem;Trusted_Connection=true;""
                table-name = ""EventJournal""
                auto-initialize = on
            }
            snapshot-store.plugin = ""akka.persistence.snapshot-store.sql-server""
            snapshot-store.sql-server {
                connection-string = ""Server=localhost;Database=OrderSystem;Trusted_Connection=true;""
                table-name = ""SnapshotStore""
                auto-initialize = on
            }
        }
    }");
```

## Event sourcing (aggregate)

```csharp
public sealed class OrderAggregate : ReceivePersistentActor
{
    private OrderState _state = OrderState.Empty;

    public OrderAggregate()
    {
        Command<CreateOrder>(HandleCreateOrder);
        Command<AddItem>(HandleAddItem);
        Command<ConfirmOrder>(HandleConfirmOrder);

        Recover<OrderCreated>(Apply);
        Recover<ItemAdded>(Apply);
        Recover<OrderConfirmed>(Apply);
    }

    private void HandleCreateOrder(CreateOrder cmd)
    {
        if (_state != OrderState.Empty) { Sender.Tell(new CommandFailed("Order already exists")); return; }
        Persist(new OrderCreated(cmd.OrderId, cmd.CustomerId, DateTime.UtcNow), Apply);
    }

    private void HandleAddItem(AddItem cmd)
    {
        if (_state == OrderState.Empty) { Sender.Tell(new CommandFailed("Order not created")); return; }
        if (_state == OrderState.Confirmed) { Sender.Tell(new CommandFailed("Order already confirmed")); return; }
        Persist(new ItemAdded(cmd.OrderId, cmd.ProductId, cmd.Quantity, cmd.Price), Apply);
    }

    private void Apply(OrderCreated evt) { _state = OrderState.Active; Context.System.EventStream.Publish(evt); }
    private void Apply(ItemAdded evt) { Context.System.EventStream.Publish(evt); }
}
```

## State machine immutable (pattern matching)

```csharp
public abstract record OrderState
{
    public static readonly OrderState Empty = new EmptyState();
    public sealed record ActiveState(ImmutableList<OrderItem> Items, decimal TotalAmount) : OrderState;
    public sealed record ConfirmedState(ImmutableList<OrderItem> Items, decimal TotalAmount, DateTime ConfirmedAt) : OrderState;
    public sealed record EmptyState() : OrderState;
}

public OrderState Transition(OrderState state, IOrderEvent evt) => (state, evt) switch
{
    (OrderState.EmptyState, OrderCreated) => new OrderState.ActiveState(ImmutableList<OrderItem>.Empty, 0m),
    (OrderState.ActiveState a, ItemAdded i) => a with
    {
        Items = a.Items.Add(new OrderItem(i.ProductId, i.Quantity, i.Price)),
        TotalAmount = a.TotalAmount + i.Quantity * i.Price
    },
    (OrderState.ActiveState a, OrderConfirmed c) => new OrderState.ConfirmedState(a.Items, a.TotalAmount, c.ConfirmedAt),
    _ => throw new InvalidOperationException($"Invalid transition: {state} -> {evt.GetType().Name}")
};
```

## Stream processing (GraphStage custom)

```csharp
var source = Source.From(new[] { new ProcessOrders() })
    .Via(new OrderValidationStage())
    .Via(new InventoryCheckStage())
    .Via(new PaymentProcessingStage())
    .To(Sink.ActorRef<OrderProcessed>(_orderProcessor))
    .Run(Context.System.Materializer());

public sealed class OrderValidationStage : GraphStage<FlowShape<OrderEvent, ValidatedOrder>>
{
    private readonly Inlet<OrderEvent> _in = new("validation.in");
    private readonly Outlet<ValidatedOrder> _out = new("validation.out");
    public override FlowShape<OrderEvent, ValidatedOrder> Shape { get; }

    public OrderValidationStage() => Shape = new FlowShape<OrderEvent, ValidatedOrder>(_in, _out);

    protected override GraphStageLogic CreateLogic(Attributes inheritedAttributes) => new Logic(this);

    private sealed class Logic : GraphStageLogic
    {
        public Logic(OrderValidationStage stage) : base(stage.Shape)
        {
            SetHandler(stage._in, () => Push(stage._out, Validate(Grab(stage._in))));
            SetHandler(stage._out, () => Pull(stage._in));
        }
        private static ValidatedOrder Validate(OrderEvent e) => new(e.OrderId, true);
    }
}
```

## Parsing zéro-allocation (Span<T>)

```csharp
public static OrderEvent ParseEvent(ReadOnlySpan<char> data)
{
    var reader = new SpanReader(data);
    var eventType = reader.ReadUntil('|');
    var payload = reader.Remaining;
    return eventType switch
    {
        "ORDER_CREATED" => ParseOrderCreated(payload),
        "ITEM_ADDED" => ParseItemAdded(payload),
        _ => throw new InvalidOperationException($"Unknown event type: {eventType}")
    };
}
```

## Tests (Akka.TestKit)

```csharp
public class OrderManagerActorTests : TestKit
{
    [Fact]
    public async Task OrderManager_ShouldCreateOrder_WhenValidCommand()
    {
        var probe = CreateTestProbe();
        var orderManager = Sys.ActorOf<OrderManagerActor>("order-manager");
        var cmd = new CreateOrder(Guid.NewGuid(), Guid.NewGuid());

        orderManager.Tell(cmd, probe.Ref);

        var status = await probe.ExpectMsgAsync<OrderStatus>(TimeSpan.FromSeconds(3));
        status.State.Should().Be(OrderState.Active);
    }
}
```

Tests d'intégration journal/snapshot : utiliser le skill `testcontainers-integration` (conteneur SQL Server) et pointer la connection-string de persistence Akka vers le conteneur.

## Déploiement

**Dockerfile** : exposer le port HTTP (8080) **et** le port remoting Akka (4053).

```dockerfile
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS base
WORKDIR /app
EXPOSE 8080
EXPOSE 4053
# ... build/publish multi-stage standard ...
ENTRYPOINT ["dotnet", "OrderSystem.Api.dll"]
```

**Kubernetes** : injecter les seed-nodes via env, ouvrir les deux ports.

```yaml
env:
- name: AKKA__CLUSTER__SEED_NODES
  value: "akka.tcp://OrderSystem@order-system-0:4053,akka.tcp://OrderSystem@order-system-1:4053"
ports:
- containerPort: 8080
- containerPort: 4053
```

## Observabilité

```csharp
// Métriques via IMeterFactory dans un acteur dédié
_ordersCreated = meterFactory.CreateCounter("orders_created_total");
_orderProcessingTime = meterFactory.CreateHistogram("order_processing_duration_seconds");

// Health check : cluster sain si tous les membres sont Up
public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext ctx, CancellationToken ct = default)
{
    var status = await Cluster.Get(_system).Ask<ClusterStatus>(GetClusterStatus.Instance, TimeSpan.FromSeconds(5));
    return status.Members.All(m => m.Status == MemberStatus.Up)
        ? HealthCheckResult.Healthy("All cluster members up")
        : HealthCheckResult.Degraded("Some members down");
}
```
