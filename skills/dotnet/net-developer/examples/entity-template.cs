using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace MyProject.Domain.Entities
{
    /// <summary>
    /// Représente un produit dans le système
    /// </summary>
    public class Product
    {
        /// <summary>
        /// Identifiant unique du produit
        /// </summary>
        public int Id { get; set; }

        /// <summary>
        /// Nom du produit
        /// </summary>
        [Required]
        [MaxLength(200)]
        public string Name { get; set; } = string.Empty;

        /// <summary>
        /// Description détaillée du produit
        /// </summary>
        [MaxLength(1000)]
        public string? Description { get; set; }

        /// <summary>
        /// Prix du produit
        /// </summary>
        [Column(TypeName = "decimal(18,2)")]
        [Range(0.01, double.MaxValue, ErrorMessage = "Le prix doit être supérieur à 0")]
        public decimal Price { get; set; }

        /// <summary>
        /// Quantité en stock
        /// </summary>
        [Range(0, int.MaxValue, ErrorMessage = "La quantité ne peut pas être négative")]
        public int Quantity { get; set; }

        /// <summary>
        /// SKU (Stock Keeping Unit) du produit
        /// </summary>
        [Required]
        [MaxLength(50)]
        public string SKU { get; set; } = string.Empty;

        /// <summary>
        /// Catégorie du produit
        /// </summary>
        public int CategoryId { get; set; }

        /// <summary>
        /// Statut du produit (Actif, Inactif, Discontinué)
        /// </summary>
        public ProductStatus Status { get; set; } = ProductStatus.Active;

        /// <summary>
        /// Date de création du produit
        /// </summary>
        public DateTime CreatedAt { get; set; }

        /// <summary>
        /// Date de dernière mise à jour
        /// </summary>
        public DateTime UpdatedAt { get; set; }

        /// <summary>
        /// Date de suppression (soft delete)
        /// </summary>
        public DateTime? DeletedAt { get; set; }

        // Propriétés de navigation
        /// <summary>
        /// Catégorie associée au produit
        /// </summary>
        public virtual Category? Category { get; set; }

        /// <summary>
        /// Commandes contenant ce produit
        /// </summary>
        public virtual ICollection<OrderItem> OrderItems { get; set; } = new List<OrderItem>();

        /// <summary>
        /// Images du produit
        /// </summary>
        public virtual ICollection<ProductImage> Images { get; set; } = new List<ProductImage>();

        // Méthodes métier
        /// <summary>
        /// Vérifie si le produit est en stock
        /// </summary>
        /// <returns>Vrai si la quantité est supérieure à 0</returns>
        public bool IsInStock() => Quantity > 0;

        /// <summary>
        /// Vérifie si le produit est actif
        /// </summary>
        /// <returns>Vrai si le statut est Actif</returns>
        public bool IsActive() => Status == ProductStatus.Active;

        /// <summary>
        /// Met à jour le timestamp de modification
        /// </summary>
        public void UpdateTimestamp()
        {
            UpdatedAt = DateTime.UtcNow;
        }

        /// <summary>
        /// Applique une réduction de stock
        /// </summary>
        /// <param name="quantity">Quantité à réduire</param>
        /// <exception cref="ArgumentException">Lancée si la quantité est invalide</exception>
        public void ReduceStock(int quantity)
        {
            if (quantity <= 0)
                throw new ArgumentException("La quantité doit être positive", nameof(quantity));

            if (quantity > Quantity)
                throw new InvalidOperationException("Stock insuffisant");

            Quantity -= quantity;
            UpdateTimestamp();
        }

        /// <summary>
        /// Ajoute du stock
        /// </summary>
        /// <param name="quantity">Quantité à ajouter</param>
        /// <exception cref="ArgumentException">Lancée si la quantité est invalide</exception>
        public void AddStock(int quantity)
        {
            if (quantity <= 0)
                throw new ArgumentException("La quantité doit être positive", nameof(quantity));

            Quantity += quantity;
            UpdateTimestamp();
        }
    }

    /// <summary>
    /// Énumération des statuts de produit
    /// </summary>
    public enum ProductStatus
    {
        /// <summary>
        /// Produit actif et disponible
        /// </summary>
        Active = 0,

        /// <summary>
        /// Produit temporairement indisponible
        /// </summary>
        Inactive = 1,

        /// <summary>
        /// Produit discontinué
        /// </summary>
        Discontinued = 2
    }
}
