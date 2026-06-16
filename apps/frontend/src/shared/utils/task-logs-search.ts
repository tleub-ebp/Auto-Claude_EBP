import type { TaskLogEntry } from "../types";

/**
 * True when a log entry matches the search query. Searches the human-visible
 * text fields: message content, tool name/input, expandable detail and the
 * subphase label. The comparison is case-insensitive; an empty query matches
 * everything.
 *
 * @param entry - The log entry to test.
 * @param query - The search query. May be any case; it is lower-cased
 *   internally, so callers can pass either a raw or an already-lower-cased
 *   string.
 */
export function entryMatchesQuery(entry: TaskLogEntry, query: string): boolean {
	const q = query.toLowerCase();
	if (!q) return true;
	return (
		(entry.content?.toLowerCase().includes(q) ?? false) ||
		(entry.tool_name?.toLowerCase().includes(q) ?? false) ||
		(entry.tool_input?.toLowerCase().includes(q) ?? false) ||
		(entry.detail?.toLowerCase().includes(q) ?? false) ||
		(entry.subphase?.toLowerCase().includes(q) ?? false)
	);
}
