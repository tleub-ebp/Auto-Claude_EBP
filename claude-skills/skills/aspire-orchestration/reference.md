# .NET Aspire — Exemples de référence

Code production complet, à charger uniquement lors de l'implémentation. Le SKILL.md couvre le modèle AppHost et les décisions.

## AppHost — orchestration complète

```csharp
var builder = DistributedApplication.CreateBuilder(args);

builder.AddProject<Projects.OrderService>("orderservice")
    .WithReference(builder.AddPostgres("ordersdb"))
    .WithReference(builder.AddRedis("orderscache"))
    .WithHttpEndpoint(port: 8080, name: "orderservice-http", targetPort: 8080);

builder.AddProject<Projects.InventoryService>("inventoryservice")
    .WithReference(builder.AddPostgres("inventorydb"))
    .WithReference(builder.AddRabbitMQ("messagebroker"))
    .WithHttpEndpoint(port: 8081, name: "inventoryservice-http", targetPort: 8081);

builder.AddProject<Projects.ApiGateway>("apigateway")
    .WithHttpEndpoint(port: 8000, name: "apigateway-http", targetPort: 8000);

builder.Build().Run();
```

## Service consommateur (ServiceDefaults + OTel + health)

```csharp
var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();                       // télémétrie + service discovery + resilience par défaut
builder.AddRedisDistributedCache("cache");
builder.AddNpgsqlDbContext<OrderDbContext>("ordersdb");

builder.Services.AddHealthChecks()
    .AddCheck<DatabaseHealthCheck>("database", tags: ["ready"])
    .AddCheck<RabbitMQHealthCheck>("rabbitmq", tags: ["ready"]);

builder.Services.AddOpenTelemetry()
    .WithTracing(t => t.AddSource("OrderService").AddAspNetCoreInstrumentation().AddHttpClientInstrumentation().AddNpgsql())
    .WithMetrics(m => m.AddAspNetCoreInstrumentation().AddHttpClientInstrumentation().AddNpgsql());

var app = builder.Build();
app.MapHealthChecks("/health", new() { Predicate = c => c.Tags.Contains("ready") });
app.MapHealthChecks("/health/live", new() { Predicate = _ => false });
app.MapPrometheusScrapingEndpoint();
app.Run();
```

## Health check custom (pattern)

```csharp
public class DatabaseHealthCheck(OrderDbContext db, ILogger<DatabaseHealthCheck> log) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext ctx, CancellationToken ct = default)
    {
        try
        {
            if (!await db.Database.CanConnectAsync(ct)) return HealthCheckResult.Unhealthy("Cannot connect");
            var pending = await db.Database.GetPendingMigrationsAsync(ct);
            if (pending.Any()) return HealthCheckResult.Degraded($"Pending migrations: {string.Join(", ", pending)}");
            return HealthCheckResult.Healthy();
        }
        catch (Exception ex) { log.LogError(ex, "DB health check failed"); return HealthCheckResult.Unhealthy("failed", ex); }
    }
}
```

Même structure pour RabbitMQ (`connection.IsClosed`), Redis, services externes.

## Tests d'intégration (fixture Aspire)

```csharp
public class AspireApplicationFixture : IDisposable
{
    private readonly DistributedApplication _app;

    public AspireApplicationFixture()
    {
        var builder = DistributedApplication.CreateBuilder();
        var pg = builder.AddPostgres("test-ordersdb");
        builder.AddProject<Projects.OrderService>("test-orderservice").WithReference(pg);
        _app = builder.Build();
        _app.StartAsync().Wait();
    }

    public HttpClient CreateHttpClient(string resource) => _app.CreateHttpClient(resource);
    public string GetConnectionString(string resource) => _app.GetConnectionString(resource);
    public void Dispose() => _app?.Dispose();
}

// Test : POST /api/orders → 201, puis vérifier l'état en base + les events émis.
```

## Configuration production (appsettings.Production.json)

Points clés : logging structuré, endpoint OTel (`http://otel-collector:4317`), connection strings, et bloc résilience.

```json
{
  "OpenTelemetry": { "Endpoint": "http://otel-collector:4317", "BatchSize": 1000, "ExportIntervalMilliseconds": 5000 },
  "ConnectionStrings": {
    "OrdersDb": "Host=postgres;Port=5432;Database=orders;Username=orders_user;Password=orders_pass;",
    "Cache": "redis:6379",
    "MessageBroker": "amqp://rabbitmq:5672"
  },
  "Resilience": {
    "Http": {
      "CircuitBreaker": { "FailureRatio": 0.1, "MinimumThroughput": 8, "SamplingDuration": "00:00:30", "BreakDuration": "00:00:05" },
      "Retry": { "Count": 3, "BackoffType": "Exponential", "Delay": "00:00:01" },
      "Timeout": { "Timeout": "00:00:30" }
    }
  }
}
```

## Docker Compose (dev — dépendances)

Conteneurs avec healthchecks : `postgres:15-alpine` (`pg_isready`), `redis:7-alpine` (`redis-cli ping`), `rabbitmq:3-management-alpine` (`rabbitmq-diagnostics ping`), `axllent/mailpit`, `otel/opentelemetry-collector-contrib`. Toujours définir un `healthcheck` et `depends_on`.

## Kubernetes

Deployment avec `livenessProbe` → `/health/live` et `readinessProbe` → `/health`, secrets pour les connection strings, requests/limits CPU+mémoire. Service `ClusterIP` interne, exposition via l'API Gateway.

```yaml
livenessProbe:  { httpGet: { path: /health/live, port: 8080 }, initialDelaySeconds: 30, periodSeconds: 10 }
readinessProbe: { httpGet: { path: /health,      port: 8080 }, initialDelaySeconds: 5,  periodSeconds: 5 }
resources: { requests: { memory: "256Mi", cpu: "250m" }, limits: { memory: "512Mi", cpu: "500m" } }
```

## Résilience HTTP (Polly) & traitement d'events

```csharp
services.AddHttpClient<T>(name)
    .AddTransientHttpErrorPolicy(p => p.WaitAndRetryAsync(3, n => TimeSpan.FromSeconds(Math.Pow(2, n))))
    .AddPolicyHandler(Policy.TimeoutAsync<HttpResponseMessage>(TimeSpan.FromSeconds(30)));
// + circuit breaker (handledEventsAllowedBeforeBreaking: 3, durationOfBreak: 30s)

// Traitement d'events memory-efficient via Channel<T> dans un IHostedService :
_eventChannel = Channel.CreateUnbounded<EventWrapper>();
await foreach (var e in _eventChannel.Reader.ReadAllAsync()) { /* pattern matching, pas de réflexion */ }
```

## Observabilité avancée

`ConfigureResource` (service.version, instance.id, deployment.environment) + tracing enrichi (`EnrichWithHttpRequest` pour user.id/tenant.id) + exporters OTLP/Prometheus. Métriques custom via `IMeterFactory` : `Counter<long>` (orders_created_total), `Histogram<double>` (order_processing_duration_seconds), `Gauge<int>` (active_orders).
