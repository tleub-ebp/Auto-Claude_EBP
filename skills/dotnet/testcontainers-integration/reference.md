# Testcontainers for .NET — Exemples de référence

Code complet, à charger uniquement lors de l'implémentation. Le SKILL.md couvre le modèle et les décisions.

> **API** : préférer les **builders par module** (`Testcontainers.PostgreSql`, `.Redis`, `.RabbitMq`…) à l'ancien `TestcontainersBuilder<T>` générique (déprécié).

## PostgreSQL — fixture xUnit

```csharp
using Testcontainers.PostgreSql;

public sealed class PostgreSqlTestFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _container = new PostgreSqlBuilder()
        .WithImage("postgres:16-alpine")
        .WithDatabase("testdb")
        .WithUsername("testuser")
        .WithPassword("testpass")
        .Build();   // port dynamique + wait strategy intégrés au module

    public string ConnectionString => _container.GetConnectionString();

    public async Task InitializeAsync()
    {
        await _container.StartAsync();
        await using var conn = new NpgsqlConnection(ConnectionString);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand("""
            CREATE TABLE IF NOT EXISTS customers (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS orders (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                customer_id UUID NOT NULL REFERENCES customers(id),
                total_amount DECIMAL(10,2) NOT NULL,
                status VARCHAR(50) NOT NULL DEFAULT 'pending'
            );
            CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
            """, conn);
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task DisposeAsync() => await _container.DisposeAsync();
}

public class OrderRepositoryTests(PostgreSqlTestFixture fx) : IClassFixture<PostgreSqlTestFixture>
{
    [Fact]
    public async Task CreateOrder_Persists()
    {
        var ctx = new OrderDbContext(new DbContextOptionsBuilder<OrderDbContext>()
            .UseNpgsql(fx.ConnectionString).Options);
        var repo = new OrderRepository(ctx);
        var result = await repo.CreateAsync(new Order { CustomerId = Guid.NewGuid(), TotalAmount = 99.99m });
        result.Id.Should().NotBe(Guid.Empty);
    }
}
```

## Redis & RabbitMQ

```csharp
using Testcontainers.Redis;
using Testcontainers.RabbitMq;

var redis = new RedisBuilder().WithImage("redis:7-alpine").Build();
await redis.StartAsync();
var mux = await ConnectionMultiplexer.ConnectAsync(redis.GetConnectionString());

var rabbit = new RabbitMqBuilder().WithImage("rabbitmq:3-management-alpine").Build();
await rabbit.StartAsync();
var factory = new ConnectionFactory { Uri = new Uri(rabbit.GetConnectionString()) };
```

Tester : SET/GET + expiration (Redis) ; publish/consume + dead-letter queue + throughput (RabbitMQ).

## Multi-service (collection fixture partagée)

Démarrer Postgres + Redis + RabbitMQ une seule fois pour toute une collection de tests :

```csharp
public sealed class IntegrationStackFixture : IAsyncLifetime
{
    public PostgreSqlContainer Db { get; } = new PostgreSqlBuilder().Build();
    public RedisContainer Cache { get; } = new RedisBuilder().Build();
    public RabbitMqContainer Broker { get; } = new RabbitMqBuilder().Build();

    public async Task InitializeAsync()
        => await Task.WhenAll(Db.StartAsync(), Cache.StartAsync(), Broker.StartAsync());

    public async Task DisposeAsync()
        => await Task.WhenAll(Db.DisposeAsync().AsTask(), Cache.DisposeAsync().AsTask(), Broker.DisposeAsync().AsTask());
}

[CollectionDefinition("integration")]
public class IntegrationCollection : ICollectionFixture<IntegrationStackFixture>;

[Collection("integration")]
public class OrderFlowTests(IntegrationStackFixture stack) { /* ... */ }
```

Pour partager un réseau Docker entre conteneurs : `var net = new NetworkBuilder().Build();` puis `.WithNetwork(net)` sur chaque builder.

## CI/CD (GitHub Actions)

Le runner doit avoir Docker (présent sur `ubuntu-latest`). Aucune config spéciale : Testcontainers démarre les conteneurs à la volée.

```yaml
jobs:
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with: { dotnet-version: '10.0.x' }
      - run: dotnet test --filter Category=Integration --configuration Release
```

Astuce : `Reuse` (`TESTCONTAINERS_REUSE_ENABLE=true` + `.WithReuse(true)`) accélère les exécutions locales répétées.

## Patterns .NET 10

```csharp
// Sélection de conteneur par pattern matching
static DockerContainer Create(string kind) => kind switch
{
    "postgres" => new PostgreSqlBuilder().WithImage("postgres:16-alpine").Build(),
    "redis"    => new RedisBuilder().WithImage("redis:7-alpine").Build(),
    "rabbitmq" => new RabbitMqBuilder().WithImage("rabbitmq:3-management-alpine").Build(),
    _ => throw new ArgumentException($"Unknown: {kind}")
};

// Config immutable
public sealed record ContainerConfig(string Image, TimeSpan StartupTimeout)
{ public static ContainerConfig Default(string image) => new(image, TimeSpan.FromMinutes(2)); }
```

## Optimisation des perfs de tests

- Partager les conteneurs via **collection fixture** (démarrage = le coût dominant).
- Exécuter les cas indépendants en **parallèle** (`Task.WhenAll`), avec un `ConcurrentDictionary` pour collecter les résultats.
- Générer les données de test en mémoire (`Random.Shared.NextBytes`), traiter par chunks `ReadOnlySpan<byte>`.
- Pooler les objets coûteux (`ObjectPool<StringBuilder>`).
