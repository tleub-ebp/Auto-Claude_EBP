/**
 * Génère un slug ASCII sûr pour les noms de dossiers/branches de spec.
 *
 * Le backend valide chaque `spec_name` contre la whitelist stricte
 * `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` (voir apps/backend/core/worktree.py).
 * Les anciennes implémentations utilisaient `\p{L}\p{N}`, qui conserve les
 * caractères accentués (ex. « numéro »). Le dossier généré contenait alors un
 * `é`, ce qui faisait échouer la création du worktree avec
 * « Invalid spec_name … must match … ».
 *
 * Cette fonction translittère les diacritiques (é → e, ç → c, …) puis ne
 * conserve que `[a-z0-9-]`, garantissant un slug compatible avec la whitelist.
 */
export function slugifySpecTitle(title: string, maxLength = 50): string {
	const slug = title
		.normalize("NFKD")
		// Supprime les marques diacritiques combinantes laissées par NFKD.
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		// Tout ce qui n'est pas alphanumérique ASCII devient un séparateur.
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.substring(0, maxLength)
		// Re-trim après la troncature pour éviter un tiret final.
		.replace(/-+$/g, "");

	return slug;
}
