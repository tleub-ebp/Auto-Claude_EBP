import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Utility function to merge Tailwind CSS classes
 */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Calculate progress percentage from subtasks
 * @param subtasks Array of subtasks with status
 * @returns Progress percentage (0-100)
 */
export function calculateProgress(subtasks: { status: string }[]): number {
	if (subtasks.length === 0) return 0;
	const completed = subtasks.filter((s) => s.status === "completed").length;
	return Math.round((completed / subtasks.length) * 100);
}

/**
 * Détermine le pourcentage d'avancement à afficher dans l'en-tête d'une tâche.
 *
 * Pendant une exécution active, l'avancement par sous-tâches terminées ne bouge
 * qu'au passage d'une sous-tâche à « completed », ce qui fige visuellement la
 * barre. On privilégie alors la progression temps réel pondérée par phase
 * (overallProgress) émise par le backend, avec repli sur l'avancement par
 * sous-tâches. Le max évite toute régression visuelle si overallProgress n'a pas
 * encore été reçu.
 *
 * @param subtaskProgress Pourcentage calculé depuis les sous-tâches (0-100)
 * @param overallProgress Progression temps réel du backend (0-100), optionnelle
 * @param hasActiveExecution Indique si une phase d'exécution est en cours
 * @returns Pourcentage à afficher (0-100)
 */
export function getDisplayProgress(
	subtaskProgress: number,
	overallProgress: number | undefined,
	hasActiveExecution: boolean,
): number {
	if (!hasActiveExecution) return subtaskProgress;
	return Math.max(overallProgress ?? 0, subtaskProgress);
}

/**
 * Format a date as a relative time string
 * @param date Date to format
 * @returns Relative time string (e.g., "2 hours ago")
 */
export function formatRelativeTime(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - new Date(date).getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMins / 60);
	const diffDays = Math.floor(diffHours / 24);

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;
	return new Date(date).toLocaleDateString();
}

/**
 * Extract plain text from HTML content.
 * Removes all HTML tags and entities, keeping only the text content.
 * @param html The HTML content
 * @returns Plain text extracted from HTML
 */
export function extractTextFromHtml(html: string): string {
	if (!html) return "";

	// Create a temporary DOM element to parse HTML safely
	const tempDiv = document.createElement("div");
	tempDiv.innerHTML = html;

	// Get text content (automatically strips tags and decodes entities)
	let text = tempDiv.textContent || tempDiv.innerText || "";

	// Clean up whitespace
	text = text
		// Collapse multiple newlines and spaces
		.replace(/\s+/g, " ")
		// Remove leading/trailing whitespace
		.trim();

	return text;
}

/**
 * Sanitize and extract plain text from markdown or HTML content.
 * Strips markdown/HTML formatting and collapses whitespace for clean display in UI.
 * @param text The text that might contain markdown or HTML
 * @param maxLength Maximum length before truncation (default: 200)
 * @returns Plain text suitable for display
 */
export function sanitizeMarkdownForDisplay(
	text: string,
	maxLength: number = 200,
): string {
	if (!text) return "";

	// Check if content is HTML (starts with < tag)
	const isHtml = text.trim().startsWith("<");

	let sanitized: string;

	if (isHtml) {
		// Extract text from HTML
		sanitized = extractTextFromHtml(text);
	} else {
		// Process as markdown
		sanitized = text
			// Remove markdown headers (# ## ### etc)
			.replace(/^#{1,6}\s+/gm, "")
			// Remove bold/italic markers
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/\*([^*]+)\*/g, "$1")
			.replace(/__([^_]+)__/g, "$1")
			.replace(/_([^_]+)_/g, "$1")
			// Remove inline code
			.replace(/`([^`]+)`/g, "$1")
			// Remove code blocks
			.replace(/```[\s\S]*?```/g, "")
			// Remove links but keep text
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
			// Remove images
			.replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
			// Remove horizontal rules
			.replace(/^[-*_]{3,}$/gm, "")
			// Remove blockquotes
			.replace(/^>\s*/gm, "")
			// Remove list markers
			.replace(/^[\s]*[-*+]\s+/gm, "")
			.replace(/^[\s]*\d+\.\s+/gm, "")
			// Remove checkbox markers
			.replace(/\[[ x]\]\s*/gi, "")
			// Collapse multiple newlines to single space
			.replace(/\n+/g, " ")
			// Collapse multiple spaces to single space
			.replace(/\s+/g, " ")
			.trim();
	}

	// Truncate if needed (0 means no truncation)
	if (maxLength > 0 && sanitized.length > maxLength) {
		sanitized = `${sanitized.substring(0, maxLength).trim()}...`;
	}

	return sanitized;
}
