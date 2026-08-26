#!/usr/bin/env python3
"""
Script pour créer un nouveau projet .NET avec la structure Clean Architecture recommandée.

Usage:
    python scripts/create_project.py --help
    python scripts/create_project.py --name "MyApp" --type webapi --framework net8.0
    python scripts/create_project.py --name "ECommerce" --type webapi --framework net8.0 --database sqlserver
"""

import argparse
import shlex
import subprocess
import sys
from pathlib import Path


def run_command(command, cwd=None):
    """Exécute une commande et retourne le résultat."""
    try:
        cmd_list = shlex.split(command) if isinstance(command, str) else command
        result = subprocess.run(cmd_list, cwd=cwd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"Erreur lors de l'exécution de {command}: {result.stderr}")
            return False
        return True
    except Exception as e:
        print(f"Exception lors de l'exécution de {command}: {e}")
        return False

def create_solution_structure(project_name, project_type, framework, database):
    """Crée la structure de solution Clean Architecture."""
    
    # Créer le répertoire principal
    base_dir = Path(project_name)
    base_dir.mkdir(exist_ok=True)
    
    # Créer les sous-répertoires
    src_dir = base_dir / "src"
    tests_dir = base_dir / "tests"
    docs_dir = base_dir / "docs"
    scripts_dir = base_dir / "scripts"
    
    for dir_path in [src_dir, tests_dir, docs_dir, scripts_dir]:
        dir_path.mkdir(exist_ok=True)
    
    print(f"Structure créée pour {project_name}")
    return base_dir

def create_projects(base_dir, project_name, project_type, framework, database):
    """Crée les projets .NET selon la Clean Architecture."""
    
    src_dir = base_dir / "src"
    tests_dir = base_dir / "tests"
    
    # Noms des projets
    domain_project = f"{project_name}.Domain"
    application_project = f"{project_name}.Application"
    infrastructure_project = f"{project_name}.Infrastructure"
    api_project = f"{project_name}.API"
    
    # Créer les projets de domaine
    print("Création des projets de domaine...")
    
    # Domain
    if not run_command(f"dotnet new classlib -n {domain_project} -f {framework}", src_dir):
        return False
    
    # Application
    if not run_command(f"dotnet new classlib -n {application_project} -f {framework}", src_dir):
        return False
    
    # Infrastructure
    if not run_command(f"dotnet new classlib -n {infrastructure_project} -f {framework}", src_dir):
        return False
    
    # API (selon le type)
    if project_type == "webapi":
        if not run_command(f"dotnet new webapi -n {api_project} -f {framework} --minimal", src_dir):
            return False
    elif project_type == "blazor":
        if not run_command(f"dotnet new blazorserver -n {api_project} -f {framework}", src_dir):
            return False
    elif project_type == "console":
        if not run_command(f"dotnet new console -n {api_project} -f {framework}", src_dir):
            return False
    elif project_type == "worker":
        if not run_command(f"dotnet new worker -n {api_project} -f {framework}", src_dir):
            return False
    else:
        print(f"Type de projet non supporté: {project_type}")
        return False
    
    # Créer les projets de tests
    print("Création des projets de tests...")
    
    # Tests unitaires
    unit_tests_project = f"{project_name}.UnitTests"
    if not run_command(f"dotnet new xunit -n {unit_tests_project} -f {framework}", tests_dir):
        return False
    
    # Tests d'intégration
    integration_tests_project = f"{project_name}.IntegrationTests"
    if not run_command(f"dotnet new xunit -n {integration_tests_project} -f {framework}", tests_dir):
        return False
    
    return True

def setup_project_references(base_dir, project_name, project_type):
    """Configure les références entre projets."""
    
    src_dir = base_dir / "src"
    tests_dir = base_dir / "tests"
    
    # Noms des projets
    domain_project = f"{project_name}.Domain"
    application_project = f"{project_name}.Application"
    infrastructure_project = f"{project_name}.Infrastructure"
    api_project = f"{project_name}.API"
    
    unit_tests_project = f"{project_name}.UnitTests"
    integration_tests_project = f"{project_name}.IntegrationTests"
    
    print("Configuration des références de projets...")
    
    # Application -> Domain
    if not run_command(f"dotnet add {src_dir}/{application_project} reference {src_dir}/{domain_project}", src_dir):
        return False
    
    # Infrastructure -> Domain + Application
    if not run_command(f"dotnet add {src_dir}/{infrastructure_project} reference {src_dir}/{domain_project} {src_dir}/{application_project}", src_dir):
        return False
    
    # API -> Application + Infrastructure
    if not run_command(f"dotnet add {src_dir}/{api_project} reference {src_dir}/{application_project} {src_dir}/{infrastructure_project}", src_dir):
        return False
    
    # Tests -> Projets correspondants
    if not run_command(f"dotnet add {tests_dir}/{unit_tests_project} reference {src_dir}/{application_project}", tests_dir):
        return False
    
    if not run_command(f"dotnet add {tests_dir}/{integration_tests_project} reference {src_dir}/{api_project}", tests_dir):
        return False
    
    return True

def add_nuget_packages(base_dir, project_name, database):
    """Ajoute les packages NuGet nécessaires."""
    
    src_dir = base_dir / "src"
    tests_dir = base_dir / "tests"
    
    print("Ajout des packages NuGet...")
    
    # Application layer packages
    application_project = f"{project_name}.Application"
    packages_app = [
        "Microsoft.Extensions.DependencyInjection.Abstractions",
        "Microsoft.Extensions.Logging.Abstractions",
        "FluentValidation",
        "MediatR",
        "Mapster"  # Alternative to AutoMapper with better performance
    ]
    
    for package in packages_app:
        if not run_command(f"dotnet add {src_dir}/{application_project} package {package}", src_dir):
            return False
    
    # Infrastructure layer packages
    infrastructure_project = f"{project_name}.Infrastructure"
    
    # Database packages
    if database == "sqlserver":
        db_packages = [
            "Microsoft.EntityFrameworkCore.SqlServer",
            "Microsoft.EntityFrameworkCore.Tools",
            "Microsoft.EntityFrameworkCore.Design"
        ]
    elif database == "postgresql":
        db_packages = [
            "Npgsql.EntityFrameworkCore.PostgreSQL",
            "Microsoft.EntityFrameworkCore.Tools",
            "Microsoft.EntityFrameworkCore.Design"
        ]
    elif database == "sqlite":
        db_packages = [
            "Microsoft.EntityFrameworkCore.Sqlite",
            "Microsoft.EntityFrameworkCore.Tools",
            "Microsoft.EntityFrameworkCore.Design"
        ]
    elif database == "cosmosdb":
        db_packages = [
            "Microsoft.EntityFrameworkCore.Cosmos",
            "Microsoft.EntityFrameworkCore.Tools",
            "Microsoft.EntityFrameworkCore.Design"
        ]
    else:
        db_packages = []
    
    for package in db_packages:
        if not run_command(f"dotnet add {src_dir}/{infrastructure_project} package {package}", src_dir):
            return False
    
    # Test packages
    unit_tests_project = f"{project_name}.UnitTests"
    test_packages = [
        "Moq",
        "FluentAssertions",
        "Microsoft.Extensions.Logging.Testing",
        "Microsoft.NET.Test.Sdk",
        "coverlet.collector",
        "Testcontainers"
    ]
    
    for package in test_packages:
        if not run_command(f"dotnet add {tests_dir}/{unit_tests_project} package {package}", tests_dir):
            return False
    
    return True

def create_solution_file(base_dir, project_name):
    """Crée le fichier solution et ajoute les projets."""
    
    print("Création du fichier solution...")
    
    # Créer la solution
    if not run_command(f"dotnet new sln -n {project_name}", base_dir):
        return False
    
    # Ajouter tous les projets à la solution
    src_dir = base_dir / "src"
    tests_dir = base_dir / "tests"
    
    # Trouver tous les fichiers .csproj
    project_files = []
    project_files.extend(src_dir.glob("*/*.csproj"))
    project_files.extend(tests_dir.glob("*/*.csproj"))
    
    for project_file in project_files:
        if not run_command(f"dotnet sln add {project_file}", base_dir):
            return False
    
    return True

def create_basic_files(base_dir, project_name, project_type, database):
    """Crée les fichiers de base et templates."""
    
    print("Création des fichiers de base...")
    
    # Créer .gitignore
    gitignore_content = """# .NET build artifacts
bin/
obj/
*.user
*.suo
*.cache
*.dll
*.exe
*.pdb

# Visual Studio
.vs/
*.vsconfig

# Testing
TestResults/
*.trx
*.coverage
*.coveragexml

# Azure
.azure/

# Tools
*.log
.DS_Store
"""
    
    with open(base_dir / ".gitignore", "w") as f:
        f.write(gitignore_content)
    
    # Créer README.md
    readme_content = f"""# {project_name}

Projet .NET avec architecture Clean Architecture.

## Structure

```
src/
├── {project_name}.Domain/           # Entités et logique métier
├── {project_name}.Application/      # Services applicatifs
├── {project_name}.Infrastructure/   # Accès aux données
└── {project_name}.API/             # API REST

tests/
├── {project_name}.UnitTests/        # Tests unitaires
└── {project_name}.IntegrationTests/ # Tests d'intégration
```

## Démarrage

```bash
# Restaurer les packages
dotnet restore

# Compiler la solution
dotnet build

# Exécuter les tests
dotnet test

# Démarrer l'API
cd src/{project_name}.API
dotnet run
```

## Base de données

Configuration pour {database}.

## Déploiement

Instructions de déploiement à ajouter.
"""
    
    with open(base_dir / "README.md", "w") as f:
        f.write(readme_content)
    
    return True

def main():
    parser = argparse.ArgumentParser(description='Créer un nouveau projet .NET avec Clean Architecture')
    parser.add_argument('--name', required=True, help='Nom du projet')
    parser.add_argument('--type', choices=['webapi', 'blazor', 'console', 'worker'], default='webapi', help='Type de projet')
    parser.add_argument('--framework', choices=['net10.0', 'net9.0', 'net8.0'], default='net10.0', help='Framework .NET')
    parser.add_argument('--database', choices=['sqlserver', 'postgresql', 'sqlite', 'cosmosdb'], default='sqlserver', help='Base de données cible')
    
    args = parser.parse_args()
    
    # Vérifier que .NET SDK est installé
    if not run_command("dotnet --version"):
        print("Erreur: .NET SDK n'est pas installé ou n'est pas dans le PATH")
        sys.exit(1)
    
    print(f"Création du projet {args.name}...")
    print(f"Type: {args.type}")
    print(f"Framework: {args.framework}")
    print(f"Base de données: {args.database}")
    print()
    
    # Créer la structure
    base_dir = create_solution_structure(args.name, args.type, args.framework, args.database)
    
    # Créer les projets
    if not create_projects(base_dir, args.name, args.type, args.framework, args.database):
        print("Erreur lors de la création des projets")
        sys.exit(1)
    
    # Configurer les références
    if not setup_project_references(base_dir, args.name, args.type):
        print("Erreur lors de la configuration des références")
        sys.exit(1)
    
    # Ajouter les packages
    if not add_nuget_packages(base_dir, args.name, args.database):
        print("Erreur lors de l'ajout des packages")
        sys.exit(1)
    
    # Créer la solution
    if not create_solution_file(base_dir, args.name):
        print("Erreur lors de la création de la solution")
        sys.exit(1)
    
    # Créer les fichiers de base
    if not create_basic_files(base_dir, args.name, args.type, args.database):
        print("Erreur lors de la création des fichiers de base")
        sys.exit(1)
    
    print()
    print(f"✅ Projet {args.name} créé avec succès!")
    print()
    print("Prochaines étapes:")
    print(f"1. cd {args.name}")
    print("2. dotnet restore")
    print("3. dotnet build")
    print("4. dotnet test")
    print(f"5. cd src/{args.name}.API")
    print("6. dotnet run")
    print()

if __name__ == '__main__':
    main()
