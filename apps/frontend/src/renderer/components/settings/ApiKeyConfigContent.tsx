import { AlertCircle, CheckCircle, Globe, Key, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { HuggingFaceModelDiscovery } from "./HuggingFaceModelDiscovery";
import { OllamaInstalledModels } from "./OllamaInstalledModels";
import type { ProviderConfig } from "./providerConfig";

interface ApiKeyConfigContentProps {
	readonly providerConfig: ProviderConfig;
	readonly providerId: string;
	readonly formData: Record<string, string>;
	readonly showApiKey: boolean;
	readonly testResult: { success: boolean; message: string } | null;
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	readonly t: any;
	readonly onFormDataChange: (data: Record<string, string>) => void;
	readonly onToggleShowApiKey: () => void;
}

export function ApiKeyConfigContent({
	providerConfig,
	providerId,
	formData,
	showApiKey,
	testResult,
	t,
	onFormDataChange,
	onToggleShowApiKey,
}: ApiKeyConfigContentProps) {
	return (
		<div className="space-y-6">
			{providerConfig.requiresApiKey && providerId !== "copilot" && (
				<ApiKeyInput
					value={formData.apiKey || ""}
					onChange={(value) => onFormDataChange({ ...formData, apiKey: value })}
					placeholder={providerConfig.placeholder}
					showApiKey={showApiKey}
					onToggleShow={onToggleShowApiKey}
					t={t}
				/>
			)}

			{providerId === "copilot" && (
				<GitHubCopilotTokenConfig
					showApiKey={showApiKey}
					onToggleShow={onToggleShowApiKey}
					t={t}
				/>
			)}

			{providerConfig.apiUrl && (
				<ApiUrlInput
					value={formData.apiUrl || ""}
					onChange={(value) => onFormDataChange({ ...formData, apiUrl: value })}
					placeholder={providerConfig.placeholder}
					t={t}
				/>
			)}

			{providerConfig.model && (
				<ModelInput
					value={formData.model || ""}
					onChange={(value) => onFormDataChange({ ...formData, model: value })}
					t={t}
				/>
			)}

			{/* Local LLM (Ollama / LM Studio / …): live Hub discovery to find a
			    model to pull. The model actually used still comes from the local
			    server; this panel only helps locate one. */}
			{providerId === "ollama" && (
				<>
					<OllamaInstalledModels
						className="pt-2 border-t border-border"
						baseUrl={formData.apiUrl}
					/>
					<HuggingFaceModelDiscovery
						className="pt-2 border-t border-border"
						hfToken={formData.apiKey}
						selectedModel={formData.model}
						baseUrl={formData.apiUrl}
						onSelectModel={(model) =>
							onFormDataChange({ ...formData, model })
						}
					/>
				</>
			)}

			{testResult && <TestResultAlert testResult={testResult} />}
		</div>
	);
}

function ApiKeyInput({
	value,
	onChange,
	placeholder,
	showApiKey,
	onToggleShow,
	t,
}: {
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly placeholder?: string;
	readonly showApiKey: boolean;
	readonly onToggleShow: () => void;
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	readonly t: any;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor="apiKey" className="flex items-center gap-2">
				<Key className="w-4 h-4" />
				{t("sections.accounts.form.apiKey")}
			</Label>
			<div className="relative">
				<Input
					id="apiKey"
					type={showApiKey ? "text" : "password"}
					placeholder={placeholder}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					className="pr-10"
				/>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="absolute right-1 top-1/2 transform -translate-y-1/2 h-6 w-6 p-0"
					onClick={onToggleShow}
				>
					{showApiKey ? <X className="w-3 h-3" /> : <Key className="w-3 h-3" />}
				</Button>
			</div>
		</div>
	);
}

function GitHubCopilotTokenConfig({
	showApiKey,
	onToggleShow,
	t,
}: {
	readonly showApiKey: boolean;
	readonly onToggleShow: () => void;
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	readonly t: any;
}) {
	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<Label htmlFor="copilot-token" className="flex items-center gap-2">
					<Key className="w-4 h-4" />
					{t("githubCopilot.token.label")}
				</Label>
				<div className="relative">
					<Input
						id="copilot-token"
						type={showApiKey ? "text" : "password"}
						placeholder={t("githubCopilot.token.placeholder")}
						className="font-mono pr-10"
					/>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="absolute right-1 top-1/2 transform -translate-y-1/2 h-6 w-6 p-0"
						onClick={onToggleShow}
					>
						{showApiKey ? (
							<X className="w-3 h-3" />
						) : (
							<Key className="w-3 h-3" />
						)}
					</Button>
				</div>
				<p className="text-sm text-muted-foreground">
					{t("githubCopilot.token.description")}
				</p>
			</div>

			{/* Token Actions */}
			<div className="flex gap-2">
				<Button>{t("common.save")}</Button>
				<Button variant="outline">{t("common.remove")}</Button>
			</div>

			{/* Token Status */}
			<Alert>
				<CheckCircle className="h-4 w-4" />
				<AlertDescription>
					{t("githubCopilot.token.configured")}
				</AlertDescription>
			</Alert>
		</div>
	);
}

function ApiUrlInput({
	value,
	onChange,
	placeholder,
	// biome-ignore lint/correctness/noUnusedFunctionParameters: parameter kept for API compatibility
	t,
}: {
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly placeholder?: string;
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	readonly t: any;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor="apiUrl" className="flex items-center gap-2">
				<Globe className="w-4 h-4" />
				URL de l'API
			</Label>
			<Input
				id="apiUrl"
				placeholder={placeholder}
				value={value}
				onChange={(e) => onChange(e.target.value)}
			/>
		</div>
	);
}

function ModelInput({
	value,
	onChange,
	// biome-ignore lint/correctness/noUnusedFunctionParameters: parameter kept for API compatibility
	t,
}: {
	readonly value: string;
	readonly onChange: (value: string) => void;
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	readonly t: any;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor="model">Modèle par défaut</Label>
			<Input
				id="model"
				placeholder="gpt-5.3, claude-4.6-opus, etc."
				value={value}
				onChange={(e) => onChange(e.target.value)}
			/>
		</div>
	);
}

function TestResultAlert({
	testResult,
}: {
	readonly testResult: { success: boolean; message: string };
}) {
	return (
		<Alert
			className={cn(
				testResult.success
					? "border-green-200 bg-green-50 text-green-800"
					: "border-red-200 bg-red-50 text-red-800",
			)}
		>
			{testResult.success ? (
				<CheckCircle className="h-4 w-4" />
			) : (
				<AlertCircle className="h-4 w-4" />
			)}
			<AlertDescription>{testResult.message}</AlertDescription>
		</Alert>
	);
}
