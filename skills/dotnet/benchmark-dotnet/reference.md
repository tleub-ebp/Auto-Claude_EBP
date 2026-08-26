# BenchmarkDotNet — Exemples de référence

Code complet, à charger uniquement lors de l'implémentation. Le SKILL.md couvre le setup et les décisions.

## Configuration riche (multi-runtime + colonnes)

```csharp
[MemoryDiagnoser]
[SimpleJob(RuntimeMoniker.Net90)]
[SimpleJob(RuntimeMoniker.Net100)]
[SimpleJob(RuntimeMoniker.NativeAot100)]
[GroupBenchmarksBy(BenchmarkLogicalGroupRule.ByCategory)]
[Orderer(SummaryOrderPolicy.FastestToSlowest, MethodOrderPolicy.Alphabetical)]
[Outliers(OutlierMode.RemoveUpper)]
[HideColumns("Error", "StdDev", "RatioSD")]
public class PerformanceBenchmarks
{
    private readonly int[] _testArray = Enumerable.Range(1, 1000).ToArray();

    [Benchmark(Baseline = true)]
    [Arguments(100), Arguments(1000), Arguments(10000)]
    public int Sum_ForEach(int count) { var s = 0; foreach (var x in _testArray) s += x; return s; }

    [Benchmark]
    [Arguments(100), Arguments(1000), Arguments(10000)]
    public int Sum_Span(int count) { var s = 0; var sp = _testArray.AsSpan(); for (var i = 0; i < sp.Length; i++) s += sp[i]; return s; }
}
```

## Patterns mesurés courants

- **Strings** : `+` (baseline) vs `StringBuilder` vs `Span<char>` + `stackalloc`. StringBuilder/Span gagnent dès quelques concaténations.
- **Collections** : `List<T>` sans/avec capacité initiale ; LINQ `Where().ToArray()` vs boucle `Span` vs `MemoryPool<T>.Shared.Rent`.
- **Agrégation** : `foreach` vs `Span` vs `Sum()` vs `AsParallel().Sum()` (parallèle rentable seulement sur gros volumes).
- **Async** : séquentiel vs `Task.WhenAll` (parallèle) ; `Task<int>` vs `ValueTask<int>` pour les résultats déjà disponibles.

```csharp
// Exemple Span vs LINQ
[Benchmark(Baseline = true)] public int[] Filter_Linq() => _source.Where(x => x % 2 == 0).ToArray();
[Benchmark] public int[] Filter_Span()
{
    var result = new List<int>(); var span = _source.AsSpan();
    for (var i = 0; i < span.Length; i++) if (span[i] % 2 == 0) result.Add(span[i]);
    return result.ToArray();
}
```

## .NET 10 — patterns haute performance

```csharp
// Span zéro-allocation
public static bool ContainsDigit(ReadOnlySpan<char> text)
{ for (var i = 0; i < text.Length; i++) if (char.IsDigit(text[i])) return true; return false; }

// readonly record struct (value object)
public readonly record struct Point(double X, double Y) { public double Distance => Math.Sqrt(X * X + Y * Y); }

// Object pooling sur chemin chaud
private static readonly ObjectPool<StringBuilder> Pool =
    new DefaultObjectPool<StringBuilder>(new StringBuilderPooledObjectPolicy());

// Memory-mapped files pour gros datasets
using var mmf = MemoryMappedFile.CreateFromFile(path);
using var accessor = mmf.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read);
```

**Native AOT** : éviter la réflexion → `[GeneratedRegex]`, source generators, delegates compilés ; préférer les `struct`/`readonly struct` et les chemins sans allocation (`ReadOnlySpan<char>` en entrée).

## Détection de régression (analyse des résultats)

Exporter en JSON (`--exporters json`), puis comparer mean courant/baseline et les allocations :

```csharp
var ratio = current.Mean / baseline.Mean;
if (ratio > 1.05) /* régression > 5 % */;
if (current.AllocatedBytes > 1024 * 1024) /* trop d'allocations */;
if (current.Gen0Collections > 1000) /* pression GC élevée */;
```

Significativité statistique : t-test sur (mean, stdDev, N) des deux séries avant de conclure à une régression réelle.

## CI/CD — gate de performance

```yaml
# .github/workflows/benchmark.yml (extrait)
- uses: actions/setup-dotnet@v4
  with: { dotnet-version: '10.0.x' }
- run: dotnet build -c Release
- run: dotnet run --project Benchmarks -c Release -- --exporters json --artifacts ./benchmark-results --filter "*"
- run: dotnet run --project BenchmarkValidator -- --baseline ./benchmark-results/baseline.json --current ./benchmark-results/current.json
```

Le validateur échoue le build si `ratio > maxRegressionRatio` (ex. 1.05) ou si `AllocatedBytes > maxAllocationBytes`. Sur une PR, poster un tableau récapitulatif (Mean, Allocated) en commentaire via `actions/github-script`.

## Métriques runtime (production)

Wrapper `IDisposable` mesurant la durée via `Stopwatch` + `IMeterFactory` : `Counter` (operations_total), `Histogram` (operation_duration_seconds), `Gauge` (active_operations).
