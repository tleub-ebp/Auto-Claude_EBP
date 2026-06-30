import { Button } from "../ui/button";

interface DialogFooterActionsProps {
	readonly provider: {
		readonly isConfigured: boolean;
		readonly id: string;
	} | null;
	readonly activeTab: "api" | "oauth" | "github-copilot";
	readonly isTesting: boolean;
	readonly formData: Record<string, string>;
	readonly onTest: () => void;
	readonly onSave: () => void;
	readonly onDelete: () => void;
	readonly onOpenChange: (open: boolean) => void;
}

export function DialogFooterActions({
	provider,
	activeTab,
	isTesting,
	formData,
	onTest,
	onSave,
	onDelete,
	onOpenChange,
}: DialogFooterActionsProps) {
	// Local servers (Ollama / LM Studio / …) run on a default URL (e.g.
	// localhost:11434) and need NO API key, so the "Test" button must stay
	// enabled even when both fields are empty — otherwise it's permanently greyed.
	const isLocalProvider =
		provider?.id === "ollama" ||
		provider?.id === "lmstudio" ||
		provider?.id === "local";
	const testDisabled =
		isTesting ||
		(activeTab !== "oauth" &&
			!isLocalProvider &&
			!formData.apiKey &&
			!formData.apiUrl);
	return (
		<>
			{provider?.isConfigured && (
				<Button variant="destructive" onClick={onDelete} className="mr-auto">
					Supprimer
				</Button>
			)}

			<div className="flex gap-2 ml-auto">
				{/* Hide Test/Save on Windsurf SSO tab and OpenAI Codex OAuth tab — auth auto-saves */}
				{!(
					(provider?.id === "windsurf" || provider?.id === "openai") &&
					activeTab === "oauth"
				) && (
					<>
						<Button variant="outline" onClick={onTest} disabled={testDisabled}>
							{isTesting ? "Test..." : "Tester"}
						</Button>
						<Button onClick={onSave}>Enregistrer</Button>
					</>
				)}
				<Button variant="outline" onClick={() => onOpenChange(false)}>
					Annuler
				</Button>
			</div>
		</>
	);
}
