/**
 * Map raw backend error strings (English, from the Python FastAPI backend)
 * to localized messages. Falls back to the raw message wrapped in
 * `backendErrors.unknown` when no pattern matches.
 *
 * Patterns are intentionally strict — we only swap-in a translation when
 * we are sure of the error shape, otherwise the raw message is shown so
 * developers can still debug.
 */

import type { TFunction } from "i18next";

const PATTERNS: {
	regex: RegExp;
	key: string;
	extract?: (m: RegExpMatchArray) => Record<string, string>;
}[] = [
	{
		regex: /^project_path\s+is\s+not\s+a\s+valid\s+directory:\s*(.+)$/i,
		key: "common.backendErrors.projectPathInvalid",
		extract: (m) => ({ path: m[1].trim() }),
	},
	{
		regex: /^project_path\s+is\s+required$/i,
		key: "common.backendErrors.projectPathRequired",
	},
	{
		regex: /^(?:directory|folder)\s+not\s+found:\s*(.+)$/i,
		key: "common.backendErrors.directoryNotFound",
		extract: (m) => ({ path: m[1].trim() }),
	},
	{
		regex: /^file\s+not\s+found:\s*(.+)$/i,
		key: "common.backendErrors.fileNotFound",
		extract: (m) => ({ path: m[1].trim() }),
	},
	{
		regex: /(?:permission\s+denied|access\s+denied|EACCES|EPERM)/i,
		key: "common.backendErrors.unauthorized",
	},
	{
		regex: /(?:ECONNREFUSED|backend\s+unreachable|connection\s+refused|fetch\s+failed)/i,
		key: "common.backendErrors.backendUnreachable",
	},
	{
		regex: /(?:ETIMEDOUT|timed\s*out|timeout)/i,
		key: "common.backendErrors.timeout",
	},
];

export function translateBackendError(
	raw: string | null | undefined,
	t: TFunction,
): string | null {
	if (!raw) return null;
	const trimmed = raw.trim();
	for (const p of PATTERNS) {
		const match = trimmed.match(p.regex);
		if (match) {
			const vars = p.extract ? p.extract(match) : {};
			return t(p.key, vars);
		}
	}
	return t("common.backendErrors.unknown", { message: trimmed });
}
