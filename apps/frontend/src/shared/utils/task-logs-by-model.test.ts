import { describe, expect, it } from "vitest";
import type { TaskLogEntry } from "../types";
import { groupEntriesByModel, mergeGroupsByModel } from "./task-logs-by-model";

function entry(
	content: string,
	attr?: { provider?: string; model?: string },
): TaskLogEntry {
	return {
		timestamp: "2026-06-29T09:00:00Z",
		type: "text",
		content,
		phase: "planning",
		provider: attr?.provider,
		model: attr?.model,
	};
}

const haiku = { provider: "claude", model: "claude-haiku-4-5" };
const llama = { provider: "ollama", model: "llama3.1:latest" };

describe("groupEntriesByModel", () => {
	it("returns no groups for an empty list", () => {
		expect(groupEntriesByModel([])).toEqual([]);
	});

	it("returns a single header-less group for legacy (unattributed) logs", () => {
		const entries = [entry("a"), entry("b")];
		const groups = groupEntriesByModel(entries);
		expect(groups).toHaveLength(1);
		expect(groups[0].provider).toBeUndefined();
		expect(groups[0].model).toBeUndefined();
		expect(groups[0].entries).toEqual(entries);
	});

	it("groups all entries of one model under that model", () => {
		const entries = [entry("a", haiku), entry("b", haiku), entry("c", haiku)];
		const groups = groupEntriesByModel(entries);
		expect(groups).toHaveLength(1);
		expect(groups[0].model).toBe("claude-haiku-4-5");
		expect(groups[0].entries).toHaveLength(3);
	});

	it("splits into one group per model on a mid-phase switch", () => {
		const entries = [
			entry("h1", haiku),
			entry("h2", haiku),
			entry("l1", llama),
			entry("l2", llama),
		];
		const groups = groupEntriesByModel(entries);
		expect(groups.map((g) => g.model)).toEqual([
			"claude-haiku-4-5",
			"llama3.1:latest",
		]);
		expect(groups[0].entries).toHaveLength(2);
		expect(groups[1].entries).toHaveLength(2);
	});

	it("leads a switch divider into the upcoming model's group", () => {
		// haiku run, an unattributed "switch" line, then the llama run.
		const divider = entry("switch to llama");
		const entries = [entry("h1", haiku), divider, entry("l1", llama)];
		const groups = groupEntriesByModel(entries);
		expect(groups).toHaveLength(2);
		expect(groups[1].model).toBe("llama3.1:latest");
		// The divider heads the new model's section, not the old one.
		expect(groups[1].entries[0]).toBe(divider);
		expect(groups[0].entries).toHaveLength(1);
	});

	it("folds a leading unattributed line into the first model group", () => {
		const start = entry("Starting planning phase");
		const entries = [start, entry("h1", haiku)];
		const groups = groupEntriesByModel(entries);
		expect(groups).toHaveLength(1);
		expect(groups[0].model).toBe("claude-haiku-4-5");
		expect(groups[0].entries[0]).toBe(start);
	});

	it("trails a closing unattributed line onto the previous model group", () => {
		const end = entry("Completed planning phase");
		const entries = [entry("h1", haiku), end];
		const groups = groupEntriesByModel(entries);
		expect(groups).toHaveLength(1);
		expect(groups[0].model).toBe("claude-haiku-4-5");
		expect(groups[0].entries[1]).toBe(end);
	});

	it("does not merge non-adjacent runs of the same model", () => {
		const entries = [
			entry("h1", haiku),
			entry("l1", llama),
			entry("h2", haiku),
		];
		const groups = groupEntriesByModel(entries);
		expect(groups.map((g) => g.model)).toEqual([
			"claude-haiku-4-5",
			"llama3.1:latest",
			"claude-haiku-4-5",
		]);
	});

	it("preserves entry references and overall order", () => {
		const entries = [entry("h1", haiku), entry("l1", llama)];
		const flattened = groupEntriesByModel(entries).flatMap((g) => g.entries);
		expect(flattened).toEqual(entries);
		expect(flattened[0]).toBe(entries[0]);
	});
});

describe("mergeGroupsByModel", () => {
	it("returns no groups for empty or unattributed logs", () => {
		expect(mergeGroupsByModel([])).toEqual([]);
		expect(mergeGroupsByModel([entry("a"), entry("b")])).toEqual([]);
	});

	it("merges non-adjacent runs of the same model into one group", () => {
		const entries = [
			entry("h1", haiku),
			entry("l1", llama),
			entry("h2", haiku),
		];
		const groups = mergeGroupsByModel(entries);
		expect(groups).toHaveLength(2);
		const byModel = Object.fromEntries(groups.map((g) => [g.model, g]));
		// haiku's two non-adjacent entries are aggregated, in order.
		expect(byModel["claude-haiku-4-5"].entries.map((e: TaskLogEntry) => e.content)).toEqual([
			"h1",
			"h2",
		]);
		expect(byModel["llama3.1:latest"].entries.map((e: TaskLogEntry) => e.content)).toEqual([
			"l1",
		]);
	});

	it("yields one group per model when there are exactly two", () => {
		const groups = mergeGroupsByModel([entry("h", haiku), entry("l", llama)]);
		expect(groups.map((g) => g.model).sort()).toEqual([
			"claude-haiku-4-5",
			"llama3.1:latest",
		]);
	});
});
