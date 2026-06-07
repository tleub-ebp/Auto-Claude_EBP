/**
 * Tests pour le helper d'inlining des pièces jointes Azure DevOps.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	inlineAzureDevOpsImages,
	isAzureDevOpsAttachmentUrl,
	stripAzureAttachmentImages,
} from "../azure-attachments";

describe("isAzureDevOpsAttachmentUrl", () => {
	it("reconnaît une pièce jointe dev.azure.com", () => {
		const url =
			"https://dev.azure.com/org/proj/_apis/wit/attachments/abc?fileName=a.png";
		expect(isAzureDevOpsAttachmentUrl(url)).toBe(true);
	});

	it("reconnaît un host visualstudio.com", () => {
		const url =
			"https://org.visualstudio.com/_apis/wit/attachments/abc?fileName=a.png";
		expect(isAzureDevOpsAttachmentUrl(url)).toBe(true);
	});

	it("reconnaît le host de l'organisation fourni", () => {
		const url =
			"https://tfs.contoso.local/_apis/wit/attachments/abc?fileName=a.png";
		expect(
			isAzureDevOpsAttachmentUrl(url, "https://tfs.contoso.local/org"),
		).toBe(true);
	});

	it("rejette un host Azure sans chemin de pièce jointe", () => {
		expect(
			isAzureDevOpsAttachmentUrl("https://dev.azure.com/org/proj/_git/repo"),
		).toBe(false);
	});

	it("rejette un host externe", () => {
		const url =
			"https://example.com/_apis/wit/attachments/abc?fileName=a.png";
		expect(isAzureDevOpsAttachmentUrl(url)).toBe(false);
	});

	it("rejette une URL invalide", () => {
		expect(isAzureDevOpsAttachmentUrl("not a url")).toBe(false);
	});
});

describe("inlineAzureDevOpsImages", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("retourne le HTML inchangé sans balise img", async () => {
		const html = "<p>pas d'image</p>";
		expect(await inlineAzureDevOpsImages(html, "https://dev.azure.com", "pat")).toBe(
			html,
		);
	});

	it("retourne le HTML inchangé sans PAT", async () => {
		const html =
			'<img src="https://dev.azure.com/o/_apis/wit/attachments/x?fileName=a.png">';
		expect(await inlineAzureDevOpsImages(html, "https://dev.azure.com", "")).toBe(
			html,
		);
	});

	it("inline une pièce jointe Azure en data URI", async () => {
		const src =
			"https://dev.azure.com/o/_apis/wit/attachments/x?fileName=a.png";
		const html = `<img src="${src}">`;
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			headers: { get: () => "image/png" },
			arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await inlineAzureDevOpsImages(
			html,
			"https://dev.azure.com",
			"pat",
		);

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(result).toContain("data:image/png;base64,");
		expect(result).not.toContain(src);
	});

	it("conserve l'URL d'origine si le téléchargement échoue", async () => {
		const src =
			"https://dev.azure.com/o/_apis/wit/attachments/x?fileName=a.png";
		const html = `<img src="${src}">`;
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } }),
		);

		expect(
			await inlineAzureDevOpsImages(html, "https://dev.azure.com", "pat"),
		).toBe(html);
	});

	it("ignore les images externes (non Azure)", async () => {
		const html = '<img src="https://example.com/a.png">';
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		expect(
			await inlineAzureDevOpsImages(html, "https://dev.azure.com", "pat"),
		).toBe(html);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("stripAzureAttachmentImages", () => {
	it("retire une <img> pointant vers une pièce jointe Azure non inlinée", () => {
		const html =
			'<p>Avant</p><img src="https://dev.azure.com/org/proj/_apis/wit/attachments/abc?fileName=a.png" alt=Image><p>Après</p>';
		const out = stripAzureAttachmentImages(html);
		expect(out).not.toContain("_apis/wit/attachments");
		expect(out).toContain("Avant");
		expect(out).toContain("Après");
	});

	it("conserve les images externes et déjà inlinées (data URI)", () => {
		const html =
			'<img src="https://example.com/a.png"><img src="data:image/png;base64,AAAA">';
		expect(stripAzureAttachmentImages(html)).toBe(html);
	});

	it("ne touche pas un HTML sans image", () => {
		const html = "<p>Pas d'image ici</p>";
		expect(stripAzureAttachmentImages(html)).toBe(html);
	});
});
