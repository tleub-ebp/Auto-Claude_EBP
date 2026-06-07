"""
Unit tests for SSRF protection in provider_api.py
"""

import ipaddress
import socket
from unittest.mock import patch

import pytest

from apps.backend.provider_api import (
    AUTHORIZED_URLS,
    PRIVATE_IP_RANGES,
    validate_url_ssrf,
)


class TestSSRFProtection:
    """Test SSRF protection functionality."""

    def test_validate_url_authorized_providers(self):
        """Test that authorized providers work correctly."""
        # Test Anthropic
        result = validate_url_ssrf("anthropic", "https://api.anthropic.com")
        assert result == "https://api.anthropic.com"
        
        # Test OpenAI
        result = validate_url_ssrf("openai", "https://api.openai.com")
        assert result == "https://api.openai.com"
        
        # Test Google
        result = validate_url_ssrf("google", "https://generativelanguage.googleapis.com")
        assert result == "https://generativelanguage.googleapis.com"

    def test_validate_url_unauthorized_hostname(self):
        """Test that unauthorized hostnames are rejected."""
        with pytest.raises(ValueError, match="Hostname .* is not authorized"):
            validate_url_ssrf("anthropic", "https://malicious.com")
        
        with pytest.raises(ValueError, match="Hostname .* is not authorized"):
            validate_url_ssrf("openai", "https://api.evil.com")

    def test_validate_url_invalid_scheme(self):
        """Test that non-HTTP/HTTPS schemes are rejected."""
        with pytest.raises(ValueError, match="Only HTTP and HTTPS schemes are allowed"):
            validate_url_ssrf("anthropic", "ftp://api.anthropic.com")
        
        with pytest.raises(ValueError, match="Only HTTP and HTTPS schemes are allowed"):
            validate_url_ssrf("openai", "file://api.openai.com")

    def test_validate_url_empty_url(self):
        """Test that empty URLs are rejected."""
        with pytest.raises(ValueError, match="URL cannot be empty"):
            validate_url_ssrf("anthropic", "")
        
        with pytest.raises(ValueError, match="URL cannot be empty"):
            validate_url_ssrf("openai", None)

    def test_validate_url_malformed_url(self):
        """Test that malformed URLs are rejected."""
        with pytest.raises(ValueError, match="Only HTTP and HTTPS schemes are allowed"):
            validate_url_ssrf("anthropic", "not-a-url")
        
        with pytest.raises(ValueError, match="Hostname None is not authorized"):
            validate_url_ssrf("anthropic", "https://")

    def test_validate_url_port_validation(self):
        """Test that port validation works for authorized providers."""
        # Valid: same port (default 443 for HTTPS)
        result = validate_url_ssrf("anthropic", "https://api.anthropic.com:443")
        assert result == "https://api.anthropic.com"
        
        # Note: port validation only works if an authorized URL has an explicit port
        # Since our authorized URLs don't specify ports, any port is allowed
        result = validate_url_ssrf("anthropic", "https://api.anthropic.com:8080")
        assert result == "https://api.anthropic.com"

    def test_validate_url_localhost_allowed(self):
        """Test that localhost is allowed for local providers."""
        result = validate_url_ssrf("ollama", "http://localhost:11434")
        assert result == "http://localhost:11434"
        
        result = validate_url_ssrf("ollama", "http://127.0.0.1:11434")
        assert result == "http://127.0.0.1:11434"

    @patch('socket.getaddrinfo')
    def test_validate_url_private_ip_blocked(self, mock_getaddrinfo):
        """Test that private IP addresses are blocked."""
        # Mock DNS resolution to return private IPs
        # getaddrinfo returns list of (family, type, proto, canonname, sockaddr)
        mock_getaddrinfo.side_effect = [
            [(socket.AF_INET, socket.SOCK_STREAM, 0, '', ('192.168.1.100', 0))],
            [(socket.AF_INET, socket.SOCK_STREAM, 0, '', ('10.0.0.50', 0))],
            [(socket.AF_INET, socket.SOCK_STREAM, 0, '', ('172.16.0.10', 0))],
            [(socket.AF_INET, socket.SOCK_STREAM, 0, '', ('127.0.0.1', 0))],
        ]
        
        with pytest.raises(ValueError, match="Resolved IP .* is in a non-routable / private range"):
            validate_url_ssrf("unknown", "https://internal.example.com")

        with pytest.raises(ValueError, match="Resolved IP .* is in a non-routable / private range"):
            validate_url_ssrf("unknown", "https://corporate.example.com")

        with pytest.raises(ValueError, match="Resolved IP .* is in a non-routable / private range"):
            validate_url_ssrf("unknown", "https://local.example.com")

        with pytest.raises(ValueError, match="Resolved IP .* is in a non-routable / private range"):
            validate_url_ssrf("unknown", "https://loopback.example.com")

    @patch('socket.getaddrinfo')
    def test_validate_url_public_ip_allowed(self, mock_getaddrinfo):
        """Test that public IP addresses are allowed."""
        # Mock DNS resolution to return public IP
        mock_getaddrinfo.return_value = [
            (socket.AF_INET, socket.SOCK_STREAM, 0, '', ('8.8.8.8', 0))
        ]  # Google's public DNS

        result = validate_url_ssrf("unknown", "https://public.example.com")
        assert result == "https://8.8.8.8"

    @patch('socket.getaddrinfo')
    def test_validate_url_dns_resolution_failure(self, mock_getaddrinfo):
        """Test that DNS resolution failures are handled."""
        mock_getaddrinfo.side_effect = socket.gaierror("Name resolution failed")

        with pytest.raises(ValueError, match="Unable to resolve hostname"):
            validate_url_ssrf("unknown", "https://nonexistent.example.com")

    def test_authorized_urls_completeness(self):
        """Test that all authorized URLs are properly formatted."""
        for provider, url in AUTHORIZED_URLS.items():
            assert url.startswith("https://"), f"Authorized URL for {provider} must use HTTPS"
            assert "." in url, f"Authorized URL for {provider} must contain a domain"

    def test_private_ip_ranges_completeness(self):
        """Test that private IP ranges cover all expected ranges."""
        # Convert all ranges to ipaddress objects
        ranges = [ipaddress.ip_network(str(ip_range)) for ip_range in PRIVATE_IP_RANGES]
        
        # Test known private IPs
        test_ips = [
            ("10.0.0.1", True),
            ("172.16.0.1", True),
            ("192.168.1.1", True),
            ("127.0.0.1", True),
            ("169.254.1.1", True),
            ("8.8.8.8", False),  # Public IP
            ("1.1.1.1", False),  # Public IP
        ]
        
        for ip, should_be_private in test_ips:
            ip_obj = ipaddress.IPv4Address(ip)
            is_private = any(ip_obj in ip_range for ip_range in ranges)
            assert is_private == should_be_private, f"IP {ip} private detection failed"

    def test_url_normalization(self):
        """Test that URLs are properly normalized."""
        # Test removal of trailing slash
        result = validate_url_ssrf("anthropic", "https://api.anthropic.com/")
        assert result == "https://api.anthropic.com"
        
        # Test removal of path/query/fragment
        result = validate_url_ssrf("anthropic", "https://api.anthropic.com/path?query=value#fragment")
        assert result == "https://api.anthropic.com"

    def test_provider_not_in_authorized_list(self):
        """Test behavior for providers not in authorized list."""
        with patch('socket.getaddrinfo') as mock_getaddrinfo:
            mock_getaddrinfo.return_value = [
                (socket.AF_INET, socket.SOCK_STREAM, 0, '', ('8.8.8.8', 0))
            ]

            # Should work for unknown providers with public IPs
            result = validate_url_ssrf("unknown_provider", "https://public.example.com")
            assert result == "https://8.8.8.8"

    def test_ipv6_private_ranges(self):
        """Test that IPv6 private ranges are included."""
        # Check that IPv6 ranges are in the list
        ipv6_ranges = [r for r in PRIVATE_IP_RANGES if isinstance(r, ipaddress.IPv6Network)]
        assert len(ipv6_ranges) > 0, "IPv6 private ranges should be included"
        
        # Test loopback
        loopback = ipaddress.IPv6Address("::1")
        assert any(loopback in r for r in ipv6_ranges), "IPv6 loopback should be private"
        
        # Test unique local
        ula = ipaddress.IPv6Address("fc00::1")
        assert any(ula in r for r in ipv6_ranges), "IPv6 ULA should be private"
        
        # Test link local
        link_local = ipaddress.IPv6Address("fe80::1")
        assert any(link_local in r for r in ipv6_ranges), "IPv6 link-local should be private"


if __name__ == "__main__":
    pytest.main([__file__])
