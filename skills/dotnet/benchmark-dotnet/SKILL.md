---
name: benchmark-dotnet
description: Mesure et optimisation de performance .NET avec BenchmarkDotNet — micro-benchmarks, profiling mémoire/allocations, détection de régression et gates CI/CD. À utiliser pour écrire des benchmarks fiables, interpréter les résultats ou comparer des implémentations.
paths: "**/*.cs,**/*.csproj,**/*.sln,**/Directory.Build.props"
---

# BenchmarkDotNet — Performance & Optimisation

Écrire des benchmarks fiables, lire les résultats et empêcher les régressions. Les suites d'exemples, l'analyse de résultats et l'intégration CI/CD sont dans **[reference.md](reference.md)**.

## Squelette minimal

```csharp
[MemoryDiagnoser]                    // colonnes Gen0/Gen1/Allocated
[SimpleJob(RuntimeMoniker.Net100)]   // .NET 10 (ajouter NativeAot100 si pertinent)
public class MyBenchmarks
{
    private readonly int[] _data = Enumerable.Range(1, 1000).ToArray();

    [Benchmark(Baseline = true)]
    public int Sum_ForEach() { var s = 0; foreach (var x in _data) s += x; return s; }

    [Benchmark]
    public int Sum_Span() { var s = 0; var sp = _data.AsSpan(); for (var i = 0; i < sp.Length; i++) s += sp[i]; return s; }
}
// Toujours en Release : dotnet run -c Release --project Benchmarks
```

## Lire les résultats

- **Mean** + **Ratio** : comparer au `Baseline`. Une différence n'est réelle que si elle dépasse l'erreur/StdDev (significativité statistique).
- **Allocated / Gen0-Gen1** (via `[MemoryDiagnoser]`) : cible le zéro-allocation sur les chemins chauds ; une forte pression GC est souvent le vrai goulot.
- **Régression** : ratio courant/baseline > ~1.05 → investiguer. Voir le validateur et le gate CI/CD dans reference.md.

## Bonnes pratiques

- Compiler et exécuter en **Release**, hors machine de dev si possible (bruit).
- Laisser BenchmarkDotNet gérer **warmup + JIT** (ne pas court-circuiter).
- Données **réalistes** (tailles représentatives) et **`[Arguments]`** pour balayer plusieurs échelles.
- Toujours un **`Baseline`** pour donner un sens aux ratios.
- Retourner/consommer le résultat (sinon le JIT peut éliminer le code mesuré).

## Anti-patterns

- ❌ Pas de warmup / JIT non chauffé
- ❌ Données trop petites ou irréalistes
- ❌ Pas de baseline ni de test de significativité
- ❌ Mesurer en Debug ou sur une machine bruyante
- ❌ Code mort éliminé faute de consommer le résultat
