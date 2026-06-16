import { describe, expect, it } from "vitest";
import type { TaskLogEntry } from "../../types";
import { entryMatchesQuery } from "../task-logs-search";

function makeEntry(partial: Partial<TaskLogEntry>): TaskLogEntry {
	return {
		timestamp: "2026-06-15T10:00:00Z",
		type: "text",
		content: "",
		phase: "coding",
		...partial,
	};
}

describe("entryMatchesQuery", () => {
	it("matches everything when the query is empty", () => {
		expect(entryMatchesQuery(makeEntry({ content: "anything" }), "")).toBe(true);
	});

	it("matches against the message content (case-insensitive)", () => {
		const entry = makeEntry({ content: "Creating Resources.resx" });
		expect(entryMatchesQuery(entry, "resources")).toBe(true);
		expect(entryMatchesQuery(entry, "RESOURCES")).toBe(true);
		expect(entryMatchesQuery(entry, "missing")).toBe(false);
	});

	it("matches against tool name, tool input, detail and subphase", () => {
		expect(
			entryMatchesQuery(makeEntry({ tool_name: "Grep" }), "grep"),
		).toBe(true);
		expect(
			entryMatchesQuery(makeEntry({ tool_input: "src/app.ts" }), "app.ts"),
		).toBe(true);
		expect(
			entryMatchesQuery(makeEntry({ detail: "Build succeeded" }), "succeeded"),
		).toBe(true);
		expect(
			entryMatchesQuery(makeEntry({ subphase: "CONTEXT GATHERING" }), "context"),
		).toBe(true);
	});

	it("returns false when no searchable field is present or matches", () => {
		expect(entryMatchesQuery(makeEntry({ content: "" }), "x")).toBe(false);
	});

	it("lower-cases the query so callers may pass raw or normalized input", () => {
		const entry = makeEntry({ content: "toto.txt created" });
		expect(entryMatchesQuery(entry, "TOTO")).toBe(true);
		expect(entryMatchesQuery(entry, "toto")).toBe(true);
	});
});
