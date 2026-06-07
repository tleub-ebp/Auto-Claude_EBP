/**
 * Helpers for the WorkPilot AI PR impact block.
 *
 * The impact block is appended to every PR body created via WorkPilot in
 * the format:
 *
 *     ---
 *     <!-- workpilot-impact-block -->
 *     Note de l'impact (1 à 5) : 3
 *     Fonctionnalité(s) impactée(s) : Fiche véhicule, doc de vente
 *
 * The HTML-comment marker lets us re-detect the block in an existing PR
 * body and replace it without duplication when the user edits values in
 * the review modal.
 *
 * NOTE: this file is kept in sync with `apps/backend/agents/impact_analyzer.py`
 * (the Python source of truth). The marker string is identical on both sides.
 */

export const IMPACT_BLOCK_MARKER = "<!-- workpilot-impact-block -->";

/** Render the impact block from a rating + features pair. */
export function renderImpactBlock(rating: string, features: string): string {
	return [
		"---",
		IMPACT_BLOCK_MARKER,
		`Note de l'impact (1 à 5) : ${rating}`,
		`Fonctionnalité(s) impactée(s) : ${features}`,
	].join("\n");
}

/**
 * Remove an existing impact block from a PR body, if present. The block
 * is always at the end of the body (separator `---` followed by the
 * marker line, through end-of-string). Returns the body unchanged if no
 * marker is found.
 */
export function stripImpactBlock(body: string): string {
	if (!body.includes(IMPACT_BLOCK_MARKER)) return body;
	// Match from the `---` separator that introduces the marker through EOF.
	const pattern = new RegExp(
		// eslint-disable-next-line @typescript-eslint/no-useless-escape
		`\\n*-{3,}\\s*\\n\\s*${IMPACT_BLOCK_MARKER.replace(
			/[.*+?^${}()|[\]\\]/g,
			"\\$&",
		)}[\\s\\S]*$`,
	);
	const stripped = body.replace(pattern, "");
	return stripped.replace(/\s+$/, "") + "\n";
}

/**
 * Append (or replace) the impact block at the end of a PR body. Idempotent:
 * if a block is already present, it is stripped before the new one is added.
 */
export function appendImpactBlock(
	body: string,
	rating: string,
	features: string,
): string {
	const cleaned = stripImpactBlock(body).replace(/\s+$/, "");
	const block = renderImpactBlock(rating, features);
	return cleaned ? `${cleaned}\n\n${block}\n` : `${block}\n`;
}
