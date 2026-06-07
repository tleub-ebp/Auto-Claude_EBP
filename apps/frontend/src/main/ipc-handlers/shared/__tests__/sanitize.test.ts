import { describe, expect, it } from "vitest";
import {
	sanitizeStringArray,
	sanitizeText,
	sanitizeUrl,
	stripControlChars,
	stripHtml,
} from "../sanitize";

describe("stripControlChars", () => {
	describe("basic functionality", () => {
		it("should return empty string for empty input", () => {
			expect(stripControlChars("", false)).toBe("");
			expect(stripControlChars("", true)).toBe("");
		});

		it("should pass through plain text unchanged", () => {
			const input = "Hello, World!";
			expect(stripControlChars(input, false)).toBe(input);
			expect(stripControlChars(input, true)).toBe(input);
		});

		it("should strip null character (0x00)", () => {
			expect(stripControlChars("hello\x00world", false)).toBe("helloworld");
		});

		it("should strip bell character (0x07)", () => {
			expect(stripControlChars("hello\x07world", false)).toBe("helloworld");
		});

		it("should strip backspace (0x08)", () => {
			expect(stripControlChars("hello\x08world", false)).toBe("helloworld");
		});

		it("should strip escape character (0x1B)", () => {
			expect(stripControlChars("hello\x1Bworld", false)).toBe("helloworld");
		});

		it("should strip DEL character (0x7F)", () => {
			expect(stripControlChars("hello\x7Fworld", false)).toBe("helloworld");
		});

		it("should strip all ASCII control characters (0x00-0x1F)", () => {
			let input = "";
			for (let i = 0; i <= 0x1f; i++) {
				input += String.fromCharCode(i);
			}
			input += "visible";
			// When allowNewlines is false, only 'visible' should remain
			expect(stripControlChars(input, false)).toBe("visible");
		});
	});

	describe("newline handling", () => {
		it("should strip newlines when allowNewlines is false", () => {
			expect(stripControlChars("hello\nworld", false)).toBe("helloworld");
			expect(stripControlChars("hello\rworld", false)).toBe("helloworld");
			expect(stripControlChars("hello\r\nworld", false)).toBe("helloworld");
		});

		it("should preserve newlines when allowNewlines is true", () => {
			expect(stripControlChars("hello\nworld", true)).toBe("hello\nworld");
			expect(stripControlChars("hello\rworld", true)).toBe("hello\rworld");
			expect(stripControlChars("hello\r\nworld", true)).toBe("hello\r\nworld");
		});

		it("should preserve tabs when allowNewlines is true", () => {
			expect(stripControlChars("hello\tworld", true)).toBe("hello\tworld");
		});

		it("should strip tabs when allowNewlines is false", () => {
			expect(stripControlChars("hello\tworld", false)).toBe("helloworld");
		});
	});

	describe("Unicode handling", () => {
		it("should preserve non-ASCII Unicode characters", () => {
			const input = "日本語テスト 🎉 émojis";
			expect(stripControlChars(input, false)).toBe(input);
		});

		it("should preserve right-to-left text", () => {
			const input = "مرحبا بالعالم";
			expect(stripControlChars(input, false)).toBe(input);
		});
	});
});

describe("sanitizeText", () => {
	describe("type checking", () => {
		it("should return empty string for non-string input", () => {
			expect(sanitizeText(null, 100)).toBe("");
			expect(sanitizeText(undefined, 100)).toBe("");
			expect(sanitizeText(123, 100)).toBe("");
			expect(sanitizeText({}, 100)).toBe("");
			expect(sanitizeText([], 100)).toBe("");
		});
	});

	describe("length enforcement", () => {
		it("should truncate strings exceeding maxLength", () => {
			expect(sanitizeText("hello world", 5)).toBe("hello");
		});

		it("should not truncate strings within maxLength", () => {
			expect(sanitizeText("hello", 10)).toBe("hello");
		});

		it("should handle zero maxLength", () => {
			expect(sanitizeText("hello", 0)).toBe("");
		});
	});

	describe("trimming", () => {
		it("should trim leading and trailing whitespace", () => {
			expect(sanitizeText("  hello  ", 100)).toBe("hello");
		});

		it("should trim before applying maxLength", () => {
			expect(sanitizeText("  hello  ", 3)).toBe("hel");
		});
	});

	describe("control character stripping", () => {
		it("should strip control characters", () => {
			expect(sanitizeText("hello\x00\x07world", 100)).toBe("helloworld");
		});

		it("should strip newlines by default", () => {
			expect(sanitizeText("hello\nworld", 100)).toBe("helloworld");
		});

		it("should preserve newlines when allowNewlines is true", () => {
			expect(sanitizeText("hello\nworld", 100, true)).toBe("hello\nworld");
		});
	});
});

describe("sanitizeStringArray", () => {
	describe("type checking", () => {
		it("should return empty array for non-array input", () => {
			expect(sanitizeStringArray(null, 10, 50)).toEqual([]);
			expect(sanitizeStringArray(undefined, 10, 50)).toEqual([]);
			expect(sanitizeStringArray("string", 10, 50)).toEqual([]);
			expect(sanitizeStringArray(123, 10, 50)).toEqual([]);
			expect(sanitizeStringArray({}, 10, 50)).toEqual([]);
		});
	});

	describe("item count limiting", () => {
		it("should limit number of items to maxItems", () => {
			const input = ["a", "b", "c", "d", "e"];
			expect(sanitizeStringArray(input, 3, 50)).toEqual(["a", "b", "c"]);
		});

		it("should return all items if under maxItems", () => {
			const input = ["a", "b"];
			expect(sanitizeStringArray(input, 5, 50)).toEqual(["a", "b"]);
		});
	});

	describe("item sanitization", () => {
		it("should sanitize each item with maxLength", () => {
			const input = ["hello world", "test"];
			expect(sanitizeStringArray(input, 10, 5)).toEqual(["hello", "test"]);
		});

		it("should filter out non-string items", () => {
			const input = ["valid", 123, null, "also valid", undefined];
			expect(sanitizeStringArray(input, 10, 50)).toEqual([
				"valid",
				"also valid",
			]);
		});

		it("should filter out empty strings after sanitization", () => {
			const input = ["valid", "", "   ", "also valid"];
			expect(sanitizeStringArray(input, 10, 50)).toEqual([
				"valid",
				"also valid",
			]);
		});
	});

	describe("control character handling", () => {
		it("should strip control characters from items", () => {
			const input = ["hello\x00world", "test\x07data"];
			expect(sanitizeStringArray(input, 10, 50)).toEqual([
				"helloworld",
				"testdata",
			]);
		});
	});
});

describe("sanitizeUrl", () => {
	describe("valid URLs", () => {
		it("should accept valid HTTPS URLs", () => {
			expect(sanitizeUrl("https://example.com")).toBe("https://example.com/");
		});

		it("should accept valid HTTP URLs", () => {
			expect(sanitizeUrl("http://example.com")).toBe("http://example.com/");
		});

		it("should accept URLs with paths", () => {
			expect(sanitizeUrl("https://example.com/path/to/resource")).toBe(
				"https://example.com/path/to/resource",
			);
		});

		it("should accept URLs with query parameters", () => {
			expect(sanitizeUrl("https://example.com?foo=bar&baz=qux")).toBe(
				"https://example.com/?foo=bar&baz=qux",
			);
		});

		it("should accept URLs with fragments", () => {
			expect(sanitizeUrl("https://example.com#section")).toBe(
				"https://example.com/#section",
			);
		});

		it("should accept URLs with port numbers", () => {
			expect(sanitizeUrl("https://example.com:8080")).toBe(
				"https://example.com:8080/",
			);
		});
	});

	describe("invalid URLs", () => {
		it("should reject non-string input", () => {
			expect(sanitizeUrl(null)).toBe("");
			expect(sanitizeUrl(undefined)).toBe("");
			expect(sanitizeUrl(123)).toBe("");
		});

		it("should reject javascript: URIs", () => {
			expect(sanitizeUrl("javascript:alert(1)")).toBe("");
		});

		it("should reject data: URIs", () => {
			expect(sanitizeUrl("data:text/html,<script>alert(1)</script>")).toBe("");
		});

		it("should reject file: URIs", () => {
			expect(sanitizeUrl("file:///etc/passwd")).toBe("");
		});

		it("should reject URLs with credentials", () => {
			expect(sanitizeUrl("https://user:pass@example.com")).toBe("");
			expect(sanitizeUrl("https://user@example.com")).toBe("");
		});

		it("should reject malformed URLs", () => {
			expect(sanitizeUrl("not-a-url")).toBe("");
			expect(sanitizeUrl("://missing-protocol.com")).toBe("");
		});

		it("should reject URLs exceeding maxLength", () => {
			const longUrl = `https://example.com/${"a".repeat(3000)}`;
			expect(sanitizeUrl(longUrl)).toBe("");
		});
	});

	describe("control character handling", () => {
		it("should strip control characters before parsing", () => {
			expect(sanitizeUrl("https://example\x00.com")).toBe(
				"https://example.com/",
			);
		});
	});

	describe("length limits", () => {
		it("should respect custom maxLength", () => {
			const url = "https://example.com/path";
			expect(sanitizeUrl(url, 10)).toBe("");
		});

		it("should accept URLs within custom maxLength", () => {
			const url = "https://example.com";
			expect(sanitizeUrl(url, 100)).toBe("https://example.com/");
		});
	});
});

describe("stripHtml", () => {
	it("should return empty string for non-string input", () => {
		expect(stripHtml(undefined)).toBe("");
		expect(stripHtml(null)).toBe("");
		expect(stripHtml(42)).toBe("");
	});

	it("should pass through plain text unchanged", () => {
		expect(stripHtml("Hello world")).toBe("Hello world");
	});

	it("should remove simple HTML tags keeping only text", () => {
		expect(stripHtml("<b>Bold</b> text").replace(/\s+/g, " ").trim()).toBe(
			"Bold text",
		);
	});

	it("should strip nested/styled Azure DevOps title markup to text", () => {
		const html =
			'<div><div style="box-sizing:border-box;"><b style="color:#000">N° de version</b></div></div>';
		// Une fois normalisé en une ligne (comme pour les titres).
		expect(stripHtml(html).replace(/\s+/g, " ").trim()).toBe("N° de version");
	});

	it("should remove deeply nested tags leaving only text", () => {
		const html = "<div><span><b>text</b></span></div>";
		const out = stripHtml(html);
		expect(out).not.toContain("<");
		expect(out.replace(/\s+/g, " ").trim()).toBe("text");
	});

	it("should convert <br> to newlines", () => {
		expect(stripHtml("line1<br>line2")).toBe("line1\nline2");
	});

	it("should decode common HTML entities", () => {
		expect(stripHtml("a &amp; b &lt;tag&gt; &quot;q&quot; &#39;x&#39;")).toBe(
			'a & b <tag> "q" \'x\'',
		);
	});

	it("should collapse excessive blank lines", () => {
		expect(stripHtml("a<p></p><p></p><p></p>b")).not.toContain("\n\n\n");
	});

	it("should drop a trailing truncated tag with no closing '>'", () => {
		// Azure spec titles get truncated mid-attribute (e.g. "…<b style=…").
		// Such a fragment has no closing '>' so the normal tag regex can't match
		// it — it must still be stripped, not leak into the title.
		const html = '<div><div style="box-sizing:border-box;"><b style=';
		expect(stripHtml(html).replace(/\s+/g, " ").trim()).toBe("");
	});

	it("should keep meaningful text before a dangling tag", () => {
		expect(stripHtml("N° de version <b style=").replace(/\s+/g, " ").trim()).toBe(
			"N° de version",
		);
	});
});
