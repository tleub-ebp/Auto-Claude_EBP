/**
 * Tests for extractPrCreationError — the helper that turns a failed
 * PR-creation subprocess into a short, log-safe toast message.
 *
 * Regression context: dragging a card from "Human review" to "Done" runs a
 * Python subprocess via execFileSync. When the task description (imported from
 * Azure DevOps) embedded a base64 inline image, the raw `Command failed: <full
 * command line>` — kilobytes of HTML — was surfaced verbatim in the toast.
 */
import { describe, expect, it } from "vitest";
import { extractPrCreationError } from "../pr-error-utils";

describe("extractPrCreationError", () => {
	it("prefers the structured `error` from the script's JSON stdout", () => {
		const err = {
			stdout: JSON.stringify({
				success: false,
				pr_url: null,
				error: "Échec du push de la branche: permission denied",
			}),
			stderr: "noise",
			code: 1,
		};
		expect(extractPrCreationError(err)).toBe(
			"Failed to create PR: Échec du push de la branche: permission denied",
		);
	});

	it("falls back to the last non-empty stderr line when stdout is not JSON", () => {
		const err = {
			stdout: "",
			stderr:
				'Traceback (most recent call last):\n  File "x", line 1\nValueError: bad thing',
			code: 1,
		};
		expect(extractPrCreationError(err)).toBe(
			"Failed to create PR: ValueError: bad thing",
		);
	});

	it("never leaks a raw command line containing a base64 image", () => {
		// Simulates the old failure mode: execFileSync rejects with the whole
		// command line (here as the `message`) but no usable stdout/stderr.
		const huge = `data:image/png;base64,${"A".repeat(50_000)}`;
		const err = {
			message: `Command failed: python create_pr.py <img src="${huge}">`,
			stdout: "",
			stderr: "",
			code: 1,
		};
		const result = extractPrCreationError(err);
		expect(result).toBe(
			"Failed to create PR. Check the application logs for details.",
		);
		expect(result).not.toContain("base64");
		expect(result.length).toBeLessThan(120);
	});

	it("reports timeouts distinctly", () => {
		expect(extractPrCreationError({ code: "ETIMEDOUT" })).toBe(
			"Failed to create PR: the operation timed out.",
		);
	});

	it("handles Buffer stdout/stderr", () => {
		const err = {
			stdout: Buffer.from(JSON.stringify({ error: "boom" }), "utf-8"),
		};
		expect(extractPrCreationError(err)).toBe("Failed to create PR: boom");
	});

	it("is null-safe", () => {
		expect(extractPrCreationError(undefined)).toBe(
			"Failed to create PR. Check the application logs for details.",
		);
		expect(extractPrCreationError(null)).toBe(
			"Failed to create PR. Check the application logs for details.",
		);
	});
});
