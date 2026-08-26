using AutoFixture;
using AutoMoq;
using FluentAssertions;
using Microsoft.Extensions.Logging;
using Moq;
using MyProject.Application.Services;
using MyProject.Domain.Entities;
using MyProject.Application.Interfaces;
using System.Threading.Tasks;
using Xunit;

namespace MyProject.UnitTests.Services
{
    /// <summary>
    /// Tests unitaires pour ProductService
    /// </summary>
    public class ProductServiceTests
    {
        private readonly AutoMoqer _mocker;
        private readonly ProductService _service;
        private readonly IFixture _fixture;

        public ProductServiceTests()
        {
            _mocker = new AutoMoqer();
            _service = _mocker.Create<ProductService>();
            _fixture = new Fixture();
            _fixture.Behaviors.OfType<ThrowingRecursionBehavior>().ToList()
                .ForEach(b => _fixture.Behaviors.Remove(b));
            _fixture.Behaviors.Add(new OmitOnRecursionBehavior());
        }

        [Fact]
        public async Task GetByIdAsync_ShouldReturnProduct_WhenProductExists()
        {
            // Arrange
            var productId = _fixture.Create<int>();
            var expectedProduct = _fixture.Build<Product>()
                .With(p => p.Id, productId)
                .Create();

            var repository = _mocker.GetMock<IProductRepository>();
            repository.Setup(r => r.GetByIdAsync(productId))
                     .ReturnsAsync(expectedProduct);

            // Act
            var result = await _service.GetByIdAsync(productId);

            // Assert
            result.Should().NotBeNull();
            result.Id.Should().Be(productId);
            result.Name.Should().NotBeNullOrEmpty();
            result.Price.Should().BeGreaterThan(0);

            repository.Verify(r => r.GetByIdAsync(productId), Times.Once);
        }

        [Fact]
        public async Task GetByIdAsync_ShouldReturnNull_WhenProductDoesNotExist()
        {
            // Arrange
            var productId = _fixture.Create<int>();

            var repository = _mocker.GetMock<IProductRepository>();
            repository.Setup(r => r.GetByIdAsync(productId))
                     .ReturnsAsync((Product?)null);

            // Act
            var result = await _service.GetByIdAsync(productId);

            // Assert
            result.Should().BeNull();
            repository.Verify(r => r.GetByIdAsync(productId), Times.Once);
        }

        [Fact]
        public async Task GetAllAsync_ShouldReturnAllProducts()
        {
            // Arrange
            var expectedProducts = _fixture.CreateMany<Product>(5).ToList();

            var repository = _mocker.GetMock<IProductRepository>();
            repository.Setup(r => r.GetAllAsync())
                     .ReturnsAsync(expectedProducts);

            // Act
            var result = await _service.GetAllAsync();

            // Assert
            result.Should().NotBeNull();
            result.Should().HaveCount(5);
            result.Should().OnlyContain(p => p.Id > 0);

            repository.Verify(r => r.GetAllAsync(), Times.Once);
        }

        [Theory]
        [InlineData("Test Product", 19.99, 10)]
        [InlineData("Premium Product", 99.99, 5)]
        [InlineData("Budget Product", 5.99, 100)]
        public async Task CreateAsync_ShouldReturnCreatedProduct_WithValidData(string name, decimal price, int quantity)
        {
            // Arrange
            var newProduct = _fixture.Build<Product>()
                .With(p => p.Name, name)
                .With(p => p.Price, price)
                .With(p => p.Quantity, quantity)
                .Without(p => p.Id)
                .Create();

            var createdProduct = _fixture.Build<Product>()
                .With(p => p.Name, name)
                .With(p => p.Price, price)
                .With(p => p.Quantity, quantity)
                .Create();

            var repository = _mocker.GetMock<IProductRepository>();
            repository.Setup(r => r.AddAsync(newProduct))
                     .ReturnsAsync(createdProduct);

            // Act
            var result = await _service.CreateAsync(newProduct);

            // Assert
            result.Should().NotBeNull();
            result.Id.Should().BeGreaterThan(0);
            result.Name.Should().Be(name);
            result.Price.Should().Be(price);
            result.Quantity.Should().Be(quantity);
            result.CreatedAt.Should().BeCloseTo(DateTime.UtcNow, TimeSpan.FromSeconds(1));

            repository.Verify(r => r.AddAsync(newProduct), Times.Once);
        }

        [Fact]
        public async Task CreateAsync_ShouldThrowException_WhenProductIsNull()
        {
            // Arrange
            Product? nullProduct = null;

            // Act & Assert
            await Assert.ThrowsAsync<ArgumentNullException>(() => 
                _service.CreateAsync(nullProduct!));
        }

        [Fact]
        public async Task UpdateAsync_ShouldCallRepository_WhenProductIsValid()
        {
            // Arrange
            var existingProduct = _fixture.Create<Product>();

            var repository = _mocker.GetMock<IProductRepository>();
            repository.Setup(r => r.UpdateAsync(existingProduct))
                     .Returns(Task.CompletedTask);

            // Act
            await _service.UpdateAsync(existingProduct);

            // Assert
            repository.Verify(r => r.UpdateAsync(existingProduct), Times.Once);
        }

        [Fact]
        public async Task DeleteAsync_ShouldCallRepository_WhenProductExists()
        {
            // Arrange
            var productId = _fixture.Create<int>();

            var repository = _mocker.GetMock<IProductRepository>();
            repository.Setup(r => r.DeleteAsync(productId))
                     .Returns(Task.CompletedTask);

            // Act
            await _service.DeleteAsync(productId);

            // Assert
            repository.Verify(r => r.DeleteAsync(productId), Times.Once);
        }

        [Fact]
        public async Task GetProductsByCategoryAsync_ShouldReturnFilteredProducts()
        {
            // Arrange
            var categoryId = _fixture.Create<int>();
            var expectedProducts = _fixture.Build<Product>()
                .With(p => p.CategoryId, categoryId)
                .CreateMany(3)
                .ToList();

            var repository = _mocker.GetMock<IProductRepository>();
            repository.Setup(r => r.GetByCategoryAsync(categoryId))
                     .ReturnsAsync(expectedProducts);

            // Act
            var result = await _service.GetProductsByCategoryAsync(categoryId);

            // Assert
            result.Should().NotBeNull();
            result.Should().HaveCount(3);
            result.Should().OnlyContain(p => p.CategoryId == categoryId);

            repository.Verify(r => r.GetByCategoryAsync(categoryId), Times.Once);
        }

        [Fact]
        public async Task UpdateStockAsync_ShouldUpdateProductStock_WhenValidQuantity()
        {
            // Arrange
            var productId = _fixture.Create<int>();
            var newQuantity = _fixture.Create<int>();
            var existingProduct = _fixture.Build<Product>()
                .With(p => p.Id, productId)
                .With(p => p.Quantity, 50)
                .Create();

            var repository = _mocker.GetMock<IProductRepository>();
            repository.Setup(r => r.GetByIdAsync(productId))
                     .ReturnsAsync(existingProduct);
            repository.Setup(r => r.UpdateAsync(existingProduct))
                     .Returns(Task.CompletedTask);

            // Act
            await _service.UpdateStockAsync(productId, newQuantity);

            // Assert
            existingProduct.Quantity.Should().Be(newQuantity);
            existingProduct.UpdatedAt.Should().BeCloseTo(DateTime.UtcNow, TimeSpan.FromSeconds(1));

            repository.Verify(r => r.GetByIdAsync(productId), Times.Once);
            repository.Verify(r => r.UpdateAsync(existingProduct), Times.Once);
        }

        [Fact]
        public async Task UpdateStockAsync_ShouldThrowException_WhenProductNotFound()
        {
            // Arrange
            var productId = _fixture.Create<int>();
            var newQuantity = _fixture.Create<int>();

            var repository = _mocker.GetMock<IProductRepository>();
            repository.Setup(r => r.GetByIdAsync(productId))
                     .ReturnsAsync((Product?)null);

            // Act & Assert
            await Assert.ThrowsAsync<KeyNotFoundException>(() => 
                _service.UpdateStockAsync(productId, newQuantity));

            repository.Verify(r => r.GetByIdAsync(productId), Times.Once);
            repository.Verify(r => r.UpdateAsync(It.IsAny<Product>()), Times.Never);
        }
    }
}
