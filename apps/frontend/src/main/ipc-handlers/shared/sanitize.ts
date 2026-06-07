/**
 * Shared sanitization utilities for network data before writing to disk.
 * Prevents control character injection and enforces length limits on
 * data from external APIs (GitHub, GitLab, Linear, etc.).
 */

/**
 * Strip control characters from a string.
 * Keeps tabs, newlines, and carriage returns only when allowNewlines is true.
 */
export function stripControlChars(
	value: string,
	allowNewlines: boolean,
): string {
	let sanitized = "";
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code === 0x0a || code === 0x0d || code === 0x09) {
			if (allowNewlines) {
				sanitized += value[i];
			}
			continue;
		}
		if (code <= 0x1f || code === 0x7f) {
			continue;
		}
		sanitized += value[i];
	}
	return sanitized;
}

/**
 * Sanitize a text value: type-check, strip control chars, enforce max length.
 */
export function sanitizeText(
	value: unknown,
	maxLength: number,
	allowNewlines = false,
): string {
	if (typeof value !== "string") return "";
	let sanitized = stripControlChars(value, allowNewlines).trim();
	if (sanitized.length > maxLength) {
		sanitized = sanitized.substring(0, maxLength);
	}
	return sanitized;
}

/**
 * Convertit du HTML enrichi (descriptions/titres Azure DevOps, etc.) en texte brut.
 *
 * Supprime toutes les balises, convertit les sauts de ligne structurels en `\n`,
 * décode les entités HTML courantes et normalise les espaces. Utilise une boucle
 * pour neutraliser les balises reconstruites (ex. `<<script>script>`).
 */
export function stripHtml(value: unknown): string {
	if (typeof value !== "string") return "";

	// Convertir les balises de bloc / sauts de ligne en retours à la ligne.
	let text = value
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(
			/<\/?(p|div|li|ul|ol|h[1-6]|span|strong|em|b|i|a|table|tr|td|th|thead|tbody)[^>]*>/gi,
			"\n",
		);

	// Supprimer les balises restantes jusqu'à stabilisation.
	let prev = "";
	while (prev !== text) {
		prev = text;
		text = text.replace(/<[^>]+>/g, "");
	}

	// Supprimer une balise tronquée en fin de chaîne (ex. un titre Azure coupé
	// en plein milieu : « …<b style=… » sans `>` final). Les regex ci-dessus
	// exigent un `>` fermant, donc une balise sans fermeture leur échappe et
	// s'afficherait telle quelle. On retire tout depuis le dernier `<` ouvrant
	// une balise (suivi d'une lettre ou `/`) jusqu'à la fin.
	text = text.replace(/<\/?[a-zA-Z][^>]*$/g, "");

	// Décoder les entités (décoder &amp; en dernier pour éviter un double décodage).
	text = text
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0*39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return text;
}

/**
 * Sanitize an array of strings: type-check each entry, strip control chars,
 * enforce per-item length and max item count.
 */
export function sanitizeStringArray(
	value: unknown,
	maxItems: number,
	maxLength: number,
): string[] {
	if (!Array.isArray(value)) return [];
	const sanitized: string[] = [];
	for (const entry of value) {
		const cleanEntry = sanitizeText(entry, maxLength);
		if (cleanEntry) {
			sanitized.push(cleanEntry);
		}
		if (sanitized.length >= maxItems) {
			break;
		}
	}
	return sanitized;
}

/**
 * Sanitize a URL value: validate format, strip control chars, enforce length.
 * Returns empty string for invalid URLs.
 */
export function sanitizeUrl(value: unknown, maxLength = 2000): string {
	if (typeof value !== "string") return "";
	const cleaned = stripControlChars(value, false).trim();
	if (cleaned.length > maxLength) return "";
	try {
		const parsed = new URL(cleaned);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
		if (parsed.username || parsed.password) return "";
		return parsed.toString();
	} catch {
		return "";
	}
}
