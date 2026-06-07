/**
 * rich-text-utils - HTML sanitization/normalization helpers for the WYSIWYG
 * description editor.
 *
 * The task description can contain HTML imported from external trackers (e.g.
 * Azure DevOps), which uses inline styles and hardcoded colors. These helpers
 * keep the stored markup safe to render while adapting clashing colors to the
 * app theme. All transforms are idempotent so editing and re-saving the same
 * content does not accumulate changes.
 */
import DOMPurify from "dompurify";

/** Tags allowed inside a task description (formatting + Azure DevOps markup). */
const ALLOWED_TAGS = [
	"span",
	"div",
	"br",
	"hr",
	"p",
	"b",
	"strong",
	"em",
	"i",
	"u",
	"s",
	"a",
	"ul",
	"ol",
	"li",
	"img",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"blockquote",
	"pre",
	"code",
	"table",
	"thead",
	"tbody",
	"tr",
	"th",
	"td",
];

/** Attributes allowed on the tags above. */
const ALLOWED_ATTR = [
	"style",
	"class",
	"dir",
	"href",
	"target",
	"rel",
	"src",
	"alt",
	"width",
	"height",
];

/**
 * Sanitize raw HTML, keeping the formatting/markup we render while stripping
 * anything dangerous (scripts, event handlers, etc.).
 */
export function sanitizeRichText(html: string): string {
	if (!html) return "";
	return DOMPurify.sanitize(html, {
		ADD_TAGS: ALLOWED_TAGS,
		ADD_ATTR: ALLOWED_ATTR,
		ALLOW_DATA_ATTR: false,
	});
}

/**
 * Neutralize hardcoded black text / white backgrounds coming from external
 * sources so the content stays legible on the app theme. Idempotent: running it
 * again finds nothing left to replace.
 */
function neutralizeThemeColors(html: string): string {
	if (!html) return "";
	return html
		.replaceAll(/color:\s*#000000?/gi, "color: inherit")
		.replaceAll(/color:\s*rgb\(0,\s*0,\s*0\)/gi, "color: inherit")
		.replaceAll(/color:\s*black/gi, "color: inherit")
		.replaceAll(/background-color:\s*#ffffff?/gi, "background-color: transparent")
		.replaceAll(
			/background-color:\s*rgb\(255,\s*255,\s*255\)/gi,
			"background-color: transparent",
		)
		.replaceAll(/background-color:\s*white/gi, "background-color: transparent");
}

/**
 * Prepare HTML for display inside the editable area: sanitize, then adapt
 * clashing colors to the theme.
 */
export function prepareRichTextForDisplay(html: string): string {
	return neutralizeThemeColors(sanitizeRichText(html));
}

/** Escape a string for safe insertion into HTML text/attribute content. */
export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
