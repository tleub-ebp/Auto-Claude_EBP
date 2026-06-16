import type { ProjectSettings } from "../../../shared/types";
import { resolveCatalogModelValue } from "../../../shared/constants";
import { useProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import { useProviderContext } from "../ProviderContext";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

interface AgentConfigSectionProps {
	readonly settings: ProjectSettings;
	readonly onUpdateSettings: (updates: Partial<ProjectSettings>) => void;
}

export function AgentConfigSection({
	settings,
	onUpdateSettings,
}: AgentConfigSectionProps) {
	const { selectedProvider } = useProviderContext();
	const { models } = useProviderModelCatalog(selectedProvider || "anthropic");
	// A persisted alias / dated id may no longer appear verbatim in the
	// deduplicated catalog; resolve it to the visible canonical entry so the
	// trigger renders the correct selection.
	const selectedValue = resolveCatalogModelValue(settings.model, models);

	return (
		<section className="space-y-4">
			<h3 className="text-sm font-semibold text-foreground">
				Agent Configuration
			</h3>
			<div className="space-y-2">
				<Label htmlFor="model" className="text-sm font-medium text-foreground">
					Model
				</Label>
				<Select
					value={selectedValue}
					onValueChange={(value) => onUpdateSettings({ model: value })}
				>
					<SelectTrigger id="model">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{models.map((model) => (
							<SelectItem key={model.value} value={model.value}>
								{model.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
		</section>
	);
}
