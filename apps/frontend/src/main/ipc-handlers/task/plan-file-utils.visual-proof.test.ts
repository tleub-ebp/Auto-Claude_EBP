/**
 * Tests unitaires pour la persistance des métadonnées de preuve visuelle
 * dans task_metadata.json (updateTaskMetadataVisualProof).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VisualProofRun } from "../../../shared/types";
import { updateTaskMetadataVisualProof } from "./plan-file-utils";

const sampleProof: VisualProofRun = {
	id: "visual-proof-1",
	status: "passed",
	taskId: "task-1",
	specId: "spec-1",
	prUrl: "https://github.com/acme/widgets/pull/42",
	framework: "vite",
	screenshots: [],
	startedAt: new Date().toISOString(),
};

describe("updateTaskMetadataVisualProof", () => {
	let dir: string;
	let metadataPath: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "vp-meta-"));
		metadataPath = path.join(dir, "task_metadata.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("creates the metadata file when it does not exist", () => {
		const ok = updateTaskMetadataVisualProof(metadataPath, sampleProof);
		expect(ok).toBe(true);
		const written = JSON.parse(readFileSync(metadataPath, "utf-8"));
		expect(written.visualProof.id).toBe("visual-proof-1");
		expect(written.visualProof.status).toBe("passed");
	});

	it("preserves existing fields and overwrites previous proof", () => {
		writeFileSync(
			metadataPath,
			JSON.stringify({ prUrl: "https://example/pr", visualProof: { id: "old" } }),
		);
		const ok = updateTaskMetadataVisualProof(metadataPath, sampleProof);
		expect(ok).toBe(true);
		const written = JSON.parse(readFileSync(metadataPath, "utf-8"));
		expect(written.prUrl).toBe("https://example/pr");
		expect(written.visualProof.id).toBe("visual-proof-1");
	});
});
