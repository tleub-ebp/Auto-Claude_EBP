#!/usr/bin/env python3
"""
Script pour ajouter une nouvelle entité avec son repository et tests dans un projet .NET.

Usage:
    python scripts/add_entity.py --help
    python scripts/add_entity.py --name "Product" --properties "string:Name,decimal:Price,int:Quantity"
    python scripts/add_entity.py --name "Customer" --properties "string:Name,string:Email,DateTime:CreatedAt" --project "MyApp"
"""

import argparse
from pathlib import Path


def parse_properties(properties_string):
    """Parse la chaîne de propriétés et retourne une liste de (type, nom)."""
    properties = []
    for prop in properties_string.split(','):
        prop = prop.strip()
        if ':' in prop:
            type_name, prop_name = prop.split(':', 1)
            properties.append((type_name.strip(), prop_name.strip()))
        else:
            print(f"Propriété mal formatée: {prop}")
            return None
    return properties

def get_csharp_type(dotnet_type):
    """Convertit le type .NET en type C#."""
    type_mapping = {
        'string': 'string',
        'int': 'int',
        'decimal': 'decimal',
        'double': 'double',
        'float': 'float',
        'bool': 'bool',
        'datetime': 'DateTime',
        'guid': 'Guid'
    }
    return type_mapping.get(dotnet_type.lower(), dotnet_type)

def create_entity_class(project_dir, project_name, entity_name, properties):
    """Crée la classe d'entité dans le projet Domain."""
    
    domain_dir = project_dir / "src" / f"{project_name}.Domain"
    entities_dir = domain_dir / "Entities"
    entities_dir.mkdir(exist_ok=True)
    
    entity_file = entities_dir / f"{entity_name}.cs"
    
    # Générer les propriétés
    props_code = []
    for prop_type, prop_name in properties:
        csharp_type = get_csharp_type(prop_type)
        props_code.append(f"    public {csharp_type} {prop_name} {{ get; set; }}")
    
    entity_content = f"""using System;

namespace {project_name}.Domain.Entities
{{
    public class {entity_name}
    {{
        public int Id {{ get; set; }}
{chr(10).join(props_code)}
        public DateTime CreatedAt {{ get; set; }}
        public DateTime UpdatedAt {{ get; set; }}
        
        // Ajouter ici les propriétés de navigation si nécessaire
        // public ICollection<RelatedEntity> RelatedEntities {{ get; set; }} = new List<RelatedEntity>();
    }}
}}
"""
    
    with open(entity_file, "w") as f:
        f.write(entity_content)
    
    print(f"✅ Entité {entity_name} créée: {entity_file}")
    return entity_file

def create_repository_interface(project_dir, project_name, entity_name):
    """Crée l'interface du repository dans le projet Application."""
    
    application_dir = project_dir / "src" / f"{project_name}.Application"
    interfaces_dir = application_dir / "Interfaces"
    interfaces_dir.mkdir(exist_ok=True)
    
    repo_interface_file = interfaces_dir / f"I{entity_name}Repository.cs"
    
    repo_interface_content = f"""using {project_name}.Domain.Entities;
using System.Threading.Tasks;

namespace {project_name}.Application.Interfaces
{{
    public interface I{entity_name}Repository
    {{
        Task<{entity_name}> GetByIdAsync(int id);
        Task<IEnumerable<{entity_name}>> GetAllAsync();
        Task<{entity_name}> AddAsync({entity_name} entity);
        Task UpdateAsync({entity_name} entity);
        Task DeleteAsync(int id);
        Task<bool> ExistsAsync(int id);
    }}
}}
"""
    
    with open(repo_interface_file, "w") as f:
        f.write(repo_interface_content)
    
    print(f"✅ Interface repository créée: {repo_interface_file}")
    return repo_interface_file

def create_repository_implementation(project_dir, project_name, entity_name):
    """Crée l'implémentation du repository dans le projet Infrastructure."""
    
    infrastructure_dir = project_dir / "src" / f"{project_name}.Infrastructure"
    repositories_dir = infrastructure_dir / "Repositories"
    data_dir = infrastructure_dir / "Data"
    
    repositories_dir.mkdir(exist_ok=True)
    data_dir.mkdir(exist_ok=True)
    
    # Créer le DbContext s'il n'existe pas
    app_context_file = data_dir / f"{project_name}DbContext.cs"
    if not app_context_file.exists():
        create_db_context(project_dir, project_name)
    
    repo_impl_file = repositories_dir / f"{entity_name}Repository.cs"
    
    repo_impl_content = f"""using Microsoft.EntityFrameworkCore;
using {project_name}.Application.Interfaces;
using {project_name}.Domain.Entities;
using {project_name}.Infrastructure.Data;
using System.Threading.Tasks;

namespace {project_name}.Infrastructure.Repositories
{{
    public class {entity_name}Repository : I{entity_name}Repository
    {{
        private readonly {project_name}DbContext _context;
        
        public {entity_name}Repository({project_name}DbContext context)
        {{
            _context = context;
        }}
        
        public async Task<{entity_name}> GetByIdAsync(int id)
        {{
            return await _context.{entity_name}s.FindAsync(id);
        }}
        
        public async Task<IEnumerable<{entity_name}>> GetAllAsync()
        {{
            return await _context.{entity_name}s.ToListAsync();
        }}
        
        public async Task<{entity_name}> AddAsync({entity_name} entity)
        {{
            entity.CreatedAt = DateTime.UtcNow;
            entity.UpdatedAt = DateTime.UtcNow;
            await _context.{entity_name}s.AddAsync(entity);
            await _context.SaveChangesAsync();
            return entity;
        }}
        
        public async Task UpdateAsync({entity_name} entity)
        {{
            entity.UpdatedAt = DateTime.UtcNow;
            _context.{entity_name}s.Update(entity);
            await _context.SaveChangesAsync();
        }}
        
        public async Task DeleteAsync(int id)
        {{
            var entity = await GetByIdAsync(id);
            if (entity != null)
            {{
                _context.{entity_name}s.Remove(entity);
                await _context.SaveChangesAsync();
            }}
        }}
        
        public async Task<bool> ExistsAsync(int id)
        {{
            return await _context.{entity_name}s.AnyAsync(e => e.Id == id);
        }}
    }}
}}
"""
    
    with open(repo_impl_file, "w") as f:
        f.write(repo_impl_content)
    
    print(f"✅ Implémentation repository créée: {repo_impl_file}")
    return repo_impl_file

def create_db_context(project_dir, project_name):
    """Crée le DbContext de base."""
    
    infrastructure_dir = project_dir / "src" / f"{project_name}.Infrastructure"
    data_dir = infrastructure_dir / "Data"
    
    app_context_file = data_dir / f"{project_name}DbContext.cs"
    
    context_content = f"""using Microsoft.EntityFrameworkCore;
using {project_name}.Domain.Entities;

namespace {project_name}.Infrastructure.Data
{{
    public class {project_name}DbContext : DbContext
    {{
        public {project_name}DbContext(DbContextOptions<{project_name}DbContext> options)
            : base(options)
        {{
        }}
        
        // Ajouter les DbSets ici
        // public DbSet<{{entity_name}}> {{entity_name}}s {{ get; set; }}
        
        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {{
            base.OnModelCreating(modelBuilder);
            
            // Configurer les entités ici
            // modelBuilder.ApplyConfiguration(new {{entity_name}}Configuration());
        }}
    }}
}}
"""
    
    with open(app_context_file, "w") as f:
        f.write(context_content)
    
    print(f"✅ DbContext créé: {app_context_file}")

def update_db_context(project_dir, project_name, entity_name):
    """Met à jour le DbContext pour inclure la nouvelle entité."""
    
    infrastructure_dir = project_dir / "src" / f"{project_name}.Infrastructure"
    data_dir = infrastructure_dir / "Data"
    app_context_file = data_dir / f"{project_name}DbContext.cs"
    
    if not app_context_file.exists():
        create_db_context(project_dir, project_name)
    
    # Lire le contenu existant
    with open(app_context_file) as f:
        content = f.read()
    
    # Ajouter le DbSet
    dbset_line = f"        public DbSet<{entity_name}> {entity_name}s {{ get; set; }}"
    
    if "DbSets ici" in content:
        content = content.replace(
            "        // Ajouter les DbSets ici",
            f"        // Ajouter les DbSets ici\n        {dbset_line}"
        )
    elif "DbSet<" in content:
        # Trouver la dernière ligne DbSet et ajouter après
        lines = content.split('\n')
        dbset_index = -1
        for i, line in enumerate(lines):
            if "DbSet<" in line and "get; set;" in line:
                dbset_index = i
        
        if dbset_index >= 0:
            lines.insert(dbset_index + 1, dbset_line)
            content = '\n'.join(lines)
    
    with open(app_context_file, "w") as f:
        f.write(content)
    
    print(f"✅ DbContext mis à jour avec {entity_name}")

def create_service(project_dir, project_name, entity_name):
    """Crée le service applicatif pour l'entité."""
    
    application_dir = project_dir / "src" / f"{project_name}.Application"
    services_dir = application_dir / "Services"
    services_dir.mkdir(exist_ok=True)
    
    service_file = services_dir / f"{entity_name}Service.cs"
    
    service_content = f"""using {project_name}.Application.Interfaces;
using {project_name}.Domain.Entities;
using System.Threading.Tasks;

namespace {project_name}.Application.Services
{{
    public class {entity_name}Service
    {{
        private readonly I{entity_name}Repository _{entity_name.ToLower()}Repository;
        
        public {entity_name}Service(I{entity_name}Repository {entity_name.ToLower()}Repository)
        {{
            _{entity_name.ToLower()}Repository = {entity_name.ToLower()}Repository;
        }}
        
        public async Task<{entity_name}> GetByIdAsync(int id)
        {{
            return await _{entity_name.ToLower()}Repository.GetByIdAsync(id);
        }}
        
        public async Task<IEnumerable<{entity_name}>> GetAllAsync()
        {{
            return await _{entity_name.ToLower()}Repository.GetAllAsync();
        }}
        
        public async Task<{entity_name}> CreateAsync({entity_name} entity)
        {{
            return await _{entity_name.ToLower()}Repository.AddAsync(entity);
        }}
        
        public async Task UpdateAsync({entity_name} entity)
        {{
            await _{entity_name.ToLower()}Repository.UpdateAsync(entity);
        }}
        
        public async Task DeleteAsync(int id)
        {{
            await _{entity_name.ToLower()}Repository.DeleteAsync(id);
        }}
    }}
}}
"""
    
    with open(service_file, "w") as f:
        f.write(service_content)
    
    print(f"✅ Service créé: {service_file}")
    return service_file

def create_controller(project_dir, project_name, entity_name):
    """Crée le contrôleur API pour l'entité."""
    
    api_dir = project_dir / "src" / f"{project_name}.API"
    controllers_dir = api_dir / "Controllers"
    controllers_dir.mkdir(exist_ok=True)
    
    controller_file = controllers_dir / f"{entity_name}sController.cs"
    
    controller_content = f"""using Microsoft.AspNetCore.Mvc;
using {project_name}.Application.Services;
using {project_name}.Domain.Entities;
using System.Threading.Tasks;

namespace {project_name}.API.Controllers
{{
    [ApiController]
    [Route("api/[controller]")]
    public class {entity_name}sController : ControllerBase
    {{
        private readonly {entity_name}Service _{entity_name.ToLower()}Service;
        
        public {entity_name}sController({entity_name}Service {entity_name.ToLower()}Service)
        {{
            _{entity_name.ToLower()}Service = {entity_name.ToLower()}Service;
        }}
        
        [HttpGet]
        public async Task<ActionResult<IEnumerable<{entity_name}>>> Get{entity_name}s()
        {{
            var {entity_name.ToLower()}s = await _{entity_name.ToLower()}Service.GetAllAsync();
            return Ok({entity_name.ToLower()}s);
        }}
        
        [HttpGet("{{id}}")]
        public async Task<ActionResult<{entity_name}>> Get{entity_name}(int id)
        {{
            var {entity_name.ToLower()} = await _{entity_name.ToLower()}Service.GetByIdAsync(id);
            if ({entity_name.ToLower()} == null)
            {{
                return NotFound();
            }}
            return Ok({entity_name.ToLower()});
        }}
        
        [HttpPost]
        public async Task<ActionResult<{entity_name}>> Post{entity_name}({entity_name} {entity_name.ToLower()})
        {{
            var created{entity_name} = await _{entity_name.ToLower()}Service.CreateAsync({entity_name.ToLower()});
            return CreatedAtAction(nameof(Get{entity_name}), new {{ id = created{entity_name}.Id }}, created{entity_name});
        }}
        
        [HttpPut("{{id}}")]
        public async Task<IActionResult> Put{entity_name}(int id, {entity_name} {entity_name.ToLower()})
        {{
            if (id != {entity_name.ToLower()}.Id)
            {{
                return BadRequest();
            }}
            
            await _{entity_name.ToLower()}Service.UpdateAsync({entity_name.ToLower()});
            return NoContent();
        }}
        
        [HttpDelete("{{id}}")]
        public async Task<IActionResult> Delete{entity_name}(int id)
        {{
            await _{entity_name.ToLower()}Service.DeleteAsync(id);
            return NoContent();
        }}
    }}
}}
"""
    
    with open(controller_file, "w") as f:
        f.write(controller_content)
    
    print(f"✅ Contrôleur créé: {controller_file}")
    return controller_file

def create_unit_tests(project_dir, project_name, entity_name):
    """Crée les tests unitaires pour le service de l'entité."""
    
    tests_dir = project_dir / "tests" / f"{project_name}.UnitTests"
    services_test_dir = tests_dir / "Services"
    services_test_dir.mkdir(exist_ok=True)
    
    test_file = services_test_dir / f"{entity_name}ServiceTests.cs"
    
    test_content = f"""using AutoMoq;
using FluentAssertions;
using Microsoft.Extensions.Logging;
using Moq;
using {project_name}.Application.Interfaces;
using {project_name}.Application.Services;
using {project_name}.Domain.Entities;
using System.Threading.Tasks;
using Xunit;

namespace {project_name}.UnitTests.Services
{{
    public class {entity_name}ServiceTests
    {{
        private readonly AutoMoqer _mocker;
        private readonly {entity_name}Service _service;
        
        public {entity_name}ServiceTests()
        {{
            _mocker = new AutoMoqer();
            _service = _mocker.Create<{entity_name}Service>();
        }}
        
        [Fact]
        public async Task GetByIdAsync_ShouldReturn{entity_name}_When{entity_name}Exists()
        {{
            // Arrange
            var {entity_name.ToLower()}Id = 1;
            var expected{entity_name} = new {entity_name} {{ Id = {entity_name.ToLower()}Id }};
            
            var repository = _mocker.GetMock<I{entity_name}Repository>();
            repository.Setup(r => r.GetByIdAsync({entity_name.ToLower()}Id))
                     .ReturnsAsync(expected{entity_name});
            
            // Act
            var result = await _service.GetByIdAsync({entity_name.ToLower()}Id);
            
            // Assert
            result.Should().NotBeNull();
            result.Id.Should().Be({entity_name.ToLower()}Id);
            repository.Verify(r => r.GetByIdAsync({entity_name.ToLower()}Id), Times.Once);
        }}
        
        [Fact]
        public async Task GetAllAsync_ShouldReturnAll{entity_name}s()
        {{
            // Arrange
            var expected{entity_name}s = new List<{entity_name}>
            {{
                new {entity_name} {{ Id = 1 }},
                new {entity_name} {{ Id = 2 }}
            }};
            
            var repository = _mocker.GetMock<I{entity_name}Repository>();
            repository.Setup(r => r.GetAllAsync())
                     .ReturnsAsync(expected{entity_name}s);
            
            // Act
            var result = await _service.GetAllAsync();
            
            // Assert
            result.Should().HaveCount(2);
            repository.Verify(r => r.GetAllAsync(), Times.Once);
        }}
        
        [Fact]
        public async Task CreateAsync_ShouldReturnCreated{entity_name}()
        {{
            // Arrange
            var new{entity_name} = new {entity_name} {{ /* Propriétés */ }};
            
            var repository = _mocker.GetMock<I{entity_name}Repository>();
            repository.Setup(r => r.AddAsync(new{entity_name}))
                     .ReturnsAsync(new{entity_name});
            
            // Act
            var result = await _service.CreateAsync(new{entity_name});
            
            // Assert
            result.Should().NotBeNull();
            repository.Verify(r => r.AddAsync(new{entity_name}), Times.Once);
        }}
    }}
}}
"""
    
    with open(test_file, "w") as f:
        f.write(test_content)
    
    print(f"✅ Tests unitaires créés: {test_file}")
    return test_file

def update_dependency_injection(project_dir, project_name, entity_name):
    """Met à jour l'injection de dépendances dans Program.cs ou Startup.cs."""
    
    api_dir = project_dir / "src" / f"{project_name}.API"
    
    # Chercher Program.cs ou Startup.cs
    program_file = api_dir / "Program.cs"
    startup_file = api_dir / "Startup.cs"
    
    if program_file.exists():
        update_program_cs(program_file, project_name, entity_name)
    elif startup_file.exists():
        print("⚠️  Mise à jour manuelle requise pour Startup.cs")

def update_program_cs(program_file, project_name, entity_name):
    """Met à jour le fichier Program.cs pour l'injection de dépendances."""
    
    with open(program_file) as f:
        content = f.read()
    
    # Ajouter les using nécessaires
    using_statements = [
        f"using {project_name}.Application.Interfaces;",
        f"using {project_name}.Application.Services;",
        f"using {project_name}.Infrastructure.Repositories;",
        f"using {project_name}.Infrastructure.Data;"
    ]
    
    for using_stmt in using_statements:
        if using_stmt not in content:
            # Ajouter après le dernier using
            lines = content.split('\n')
            last_using_index = -1
            for i, line in enumerate(lines):
                if line.startswith('using '):
                    last_using_index = i
            
            if last_using_index >= 0:
                lines.insert(last_using_index + 1, using_stmt)
                content = '\n'.join(lines)
    
    # Ajouter l'enregistrement des services (simplifié)
    services_registration = f"""        // {entity_name} services
        builder.Services.AddScoped<I{entity_name}Repository, {entity_name}Repository>();
        builder.Services.AddScoped<{entity_name}Service>();"""
    
    if "builder.Services.AddDbContext" in content:
        # Ajouter après le DbContext
        lines = content.split('\n')
        dbcontext_index = -1
        for i, line in enumerate(lines):
            if "AddDbContext" in line:
                dbcontext_index = i
                break
        
        if dbcontext_index >= 0:
            lines.insert(dbcontext_index + 1, services_registration)
            content = '\n'.join(lines)
    
    with open(program_file, "w") as f:
        f.write(content)
    
    print(f"✅ Program.cs mis à jour pour {entity_name}")

def main():
    parser = argparse.ArgumentParser(description='Ajouter une nouvelle entité avec repository et tests')
    parser.add_argument('--name', required=True, help='Nom de l\'entité (ex: Product)')
    parser.add_argument('--properties', required=True, help='Propriétés (ex: "string:Name,decimal:Price")')
    parser.add_argument('--project', help='Nom du projet (détecté automatiquement si non spécifié)')
    
    args = parser.parse_args()
    
    # Parser les propriétés
    properties = parse_properties(args.properties)
    if properties is None:
        print("Erreur: Format des propriétés invalide")
        return
    
    # Détecter le projet si non spécifié
    if args.project:
        project_name = args.project
        project_dir = Path(args.project)
    else:
        # Chercher le fichier solution dans le répertoire courant
        current_dir = Path.cwd()
        sln_files = list(current_dir.glob("*.sln"))
        
        if not sln_files:
            print("Erreur: Aucun fichier solution trouvé. Spécifiez --project ou exécutez depuis le répertoire du projet.")
            return
        
        project_name = sln_files[0].stem
        project_dir = current_dir
    
    entity_name = args.name
    
    print(f"Ajout de l'entité {entity_name} au projet {project_name}...")
    print(f"Propriétés: {args.properties}")
    print()
    
    # Vérifier que la structure du projet existe
    if not (project_dir / "src").exists():
        print("Erreur: Structure du projet non trouvée. Assurez-vous d'être dans un projet .NET avec Clean Architecture.")
        return
    
    # Créer tous les fichiers
    try:
        create_entity_class(project_dir, project_name, entity_name, properties)
        create_repository_interface(project_dir, project_name, entity_name)
        create_repository_implementation(project_dir, project_name, entity_name)
        update_db_context(project_dir, project_name, entity_name)
        create_service(project_dir, project_name, entity_name)
        create_controller(project_dir, project_name, entity_name)
        create_unit_tests(project_dir, project_name, entity_name)
        update_dependency_injection(project_dir, project_name, entity_name)
        
        print()
        print(f"✅ Entité {entity_name} ajoutée avec succès!")
        print()
        print("Fichiers créés:")
        print(f"  - Domain/Entities/{entity_name}.cs")
        print(f"  - Application/Interfaces/I{entity_name}Repository.cs")
        print(f"  - Infrastructure/Repositories/{entity_name}Repository.cs")
        print(f"  - Application/Services/{entity_name}Service.cs")
        print(f"  - API/Controllers/{entity_name}sController.cs")
        print(f"  - UnitTests/Services/{entity_name}ServiceTests.cs")
        print()
        print("Prochaines étapes:")
        print("1. Vérifiez et ajustez les fichiers générés")
        print("2. Ajoutez les migrations EF Core si nécessaire:")
        print(f"   dotnet ef migrations add Add{entity_name}Entity")
        print("   dotnet ef database update")
        print("3. Exécutez les tests pour vérifier:")
        print("   dotnet test")
        
    except Exception as e:
        print(f"Erreur lors de la création de l'entité: {e}")

if __name__ == '__main__':
    main()
