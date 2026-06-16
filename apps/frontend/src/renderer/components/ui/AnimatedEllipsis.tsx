import { cn } from "../../lib/utils";

interface AnimatedEllipsisProps {
	/** Classe appliquée au conteneur (couleur héritée via `currentColor`). */
	className?: string;
	/** Libellé accessible décrivant l'état d'attente. */
	"aria-label"?: string;
}

/**
 * Trois points de suspension animés en cascade pour signaler qu'un traitement
 * est en cours (« réflexion »). L'animation est désactivée automatiquement par
 * la règle globale `prefers-reduced-motion`.
 */
export function AnimatedEllipsis({
	className,
	"aria-label": ariaLabel,
}: AnimatedEllipsisProps) {
	return (
		<span
			className={cn("thinking-dots", className)}
			role="status"
			aria-label={ariaLabel}
		>
			<span className="thinking-dot" aria-hidden="true">
				.
			</span>
			<span className="thinking-dot" aria-hidden="true">
				.
			</span>
			<span className="thinking-dot" aria-hidden="true">
				.
			</span>
		</span>
	);
}
