import {
	ChevronDown,
	ChevronUp,
	Database,
	Eye,
	EyeOff,
	Globe,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	GraphitiEmbeddingProvider,
	ProjectEnvConfig,
	ProjectSettings as ProjectSettingsType,
} from "../../../shared/types";
import { OllamaModelSelector } from "../onboarding/OllamaModelSelector";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";
import { GUIDE_ANCHORS } from "../guided-tour/anchors";
import { MemoryLifecycleSection } from "./MemoryLifecycleSection";

interface SecuritySettingsProps {
	readonly envConfig: ProjectEnvConfig | null;
	readonly settings: ProjectSettingsType;
	readonly setSettings: React.Dispatch<
		React.SetStateAction<ProjectSettingsType>
	>;
	readonly updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
	readonly projectPath?: string;

	// Password visibility
	readonly showOpenAIKey: boolean;
	readonly setShowOpenAIKey: React.Dispatch<React.SetStateAction<boolean>>;

	// Collapsible section
	readonly expanded: boolean;
	readonly onToggle: () => void;
}

export function SecuritySettings({
	envConfig,
	settings,
	setSettings,
	updateEnvConfig,
	projectPath,
	showOpenAIKey,
	setShowOpenAIKey,
	expanded,
	onToggle,
}: SecuritySettingsProps) {
	const { t } = useTranslation("settings");
	// Password visibility for multiple providers
	const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({
		openai: showOpenAIKey,
		voyage: false,
		google: false,
		azure: false,
	});

	// Sync parent's showOpenAIKey prop to local state
	useEffect(() => {
		setShowApiKey((prev) => ({ ...prev, openai: showOpenAIKey }));
	}, [showOpenAIKey]);

	const embeddingProvider =
		envConfig?.graphitiProviderConfig?.embeddingProvider || "ollama";

	// Toggle API key visibility
	const toggleShowApiKey = (key: string) => {
		const newValue = !showApiKey[key];
		setShowApiKey((prev) => ({ ...prev, [key]: newValue }));
		// Sync with parent for OpenAI
		if (key === "openai") {
			setShowOpenAIKey(newValue);
		}
	};

	// Handle Ollama model selection
	const handleOllamaModelSelect = (modelName: string, dim: number) => {
		updateEnvConfig({
			graphitiProviderConfig: {
				...envConfig?.graphitiProviderConfig,
				embeddingProvider: "ollama",
				ollamaEmbeddingModel: modelName,
				ollamaEmbeddingDim: dim,
			},
		});
	};

	if (!envConfig) return null;

	// Helper component for API key input with visibility toggle
	const ApiKeyInput = ({
		provider,
		value,
		placeholder,
		onChange,
		label,
		description,
		keyUrl,
		keyUrlText,
	}: {
		provider: string;
		value: string;
		placeholder: string;
		onChange: (value: string) => void;
		label: string;
		description: string;
		keyUrl: string;
		keyUrlText: string;
	}) => (
		<div className="space-y-2">
			<Label className="text-sm font-medium text-foreground">{label}</Label>
			<p className="text-xs text-muted-foreground">{description}</p>
			<div className="relative">
				<Input
					type={showApiKey[provider] ? "text" : "password"}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={placeholder}
					className="pr-10"
				/>
				<button
					type="button"
					onClick={() => toggleShowApiKey(provider)}
					className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
					aria-label={showApiKey[provider] ? `Hide ${label}` : `Show ${label}`}
				>
					{showApiKey[provider] ? (
						<EyeOff className="h-4 w-4" />
					) : (
						<Eye className="h-4 w-4" />
					)}
				</button>
			</div>
			<p className="text-xs text-muted-foreground">
				Get your key from{" "}
				<a
					href={keyUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="text-primary hover:text-primary/80"
				>
					{keyUrlText}
				</a>
			</p>
		</div>
	);

	// Provider-specific components
	const OpenAIFields = () => (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<Label className="text-sm font-medium text-foreground">
					OpenAI API Key {envConfig.openaiKeyIsGlobal ? "(Override)" : ""}
				</Label>
				{envConfig.openaiKeyIsGlobal && (
					<span className="flex items-center gap-1 text-xs text-info">
						<Globe className="h-3 w-3" />
						Using global key
					</span>
				)}
			</div>
			{envConfig.openaiKeyIsGlobal ? (
				<p className="text-xs text-muted-foreground">
					Using key from App Settings. Enter a project-specific key below to
					override.
				</p>
			) : (
				<p className="text-xs text-muted-foreground">
					Required for OpenAI embeddings
				</p>
			)}
			<div className="relative">
				<Input
					type={showApiKey.openai ? "text" : "password"}
					placeholder={
						envConfig.openaiKeyIsGlobal
							? "Enter to override global key..."
							: "sk-xxxxxxxx"
					}
					value={
						envConfig.openaiKeyIsGlobal ? "" : envConfig.openaiApiKey || ""
					}
					onChange={(e) =>
						updateEnvConfig({ openaiApiKey: e.target.value || undefined })
					}
					className="pr-10"
				/>
				<button
					type="button"
					onClick={() => toggleShowApiKey("openai")}
					className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
					aria-label={
						showApiKey.openai ? "Hide OpenAI API key" : "Show OpenAI API key"
					}
				>
					{showApiKey.openai ? (
						<EyeOff className="h-4 w-4" />
					) : (
						<Eye className="h-4 w-4" />
					)}
				</button>
			</div>
			<p className="text-xs text-muted-foreground">
				Get your key from{" "}
				<a
					href="https://platform.openai.com/api-keys"
					target="_blank"
					rel="noopener noreferrer"
					className="text-primary hover:text-primary/80"
				>
					OpenAI
				</a>
			</p>
		</div>
	);

	const VoyageFields = () => (
		<div className="space-y-2">
			<ApiKeyInput
				provider="voyage"
				value={envConfig.graphitiProviderConfig?.voyageApiKey || ""}
				placeholder="pa-xxxxxxxx"
				onChange={(value) =>
					updateEnvConfig({
						graphitiProviderConfig: {
							...envConfig.graphitiProviderConfig,
							embeddingProvider: "voyage",
							voyageApiKey: value || undefined,
						},
					})
				}
				label="Voyage AI API Key"
				description="Required for Voyage AI embeddings"
				keyUrl="https://dash.voyageai.com/api-keys"
				keyUrlText="Voyage AI"
			/>
			<div className="space-y-1 mt-3">
				<Label className="text-xs text-muted-foreground">
					Embedding Model (optional)
				</Label>
				<Input
					placeholder="voyage-3"
					value={envConfig.graphitiProviderConfig?.voyageEmbeddingModel || ""}
					onChange={(e) =>
						updateEnvConfig({
							graphitiProviderConfig: {
								...envConfig.graphitiProviderConfig,
								embeddingProvider: "voyage",
								voyageEmbeddingModel: e.target.value || undefined,
							},
						})
					}
				/>
			</div>
		</div>
	);

	const GoogleFields = () => (
		<ApiKeyInput
			provider="google"
			value={envConfig.graphitiProviderConfig?.googleApiKey || ""}
			placeholder="AIzaSy..."
			onChange={(value) =>
				updateEnvConfig({
					graphitiProviderConfig: {
						...envConfig.graphitiProviderConfig,
						embeddingProvider: "google",
						googleApiKey: value || undefined,
					},
				})
			}
			label="Google AI API Key"
			description="Required for Google AI embeddings"
			keyUrl="https://aistudio.google.com/apikey"
			keyUrlText="Google AI Studio"
		/>
	);

	const AzureFields = () => (
		<div className="space-y-3 p-3 rounded-md bg-muted/50">
			<Label className="text-sm font-medium text-foreground">
				Azure OpenAI Configuration
			</Label>
			<div className="space-y-2">
				<Label className="text-xs text-muted-foreground">API Key</Label>
				<div className="relative">
					<Input
						type={showApiKey.azure ? "text" : "password"}
						value={envConfig.graphitiProviderConfig?.azureOpenaiApiKey || ""}
						onChange={(e) =>
							updateEnvConfig({
								graphitiProviderConfig: {
									...envConfig.graphitiProviderConfig,
									embeddingProvider: "azure_openai",
									azureOpenaiApiKey: e.target.value || undefined,
								},
							})
						}
						placeholder="Azure API Key"
						className="pr-10"
					/>
					<button
						type="button"
						onClick={() => toggleShowApiKey("azure")}
						className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
						aria-label={
							showApiKey.azure
								? "Hide Azure OpenAI API key"
								: "Show Azure OpenAI API key"
						}
					>
						{showApiKey.azure ? (
							<EyeOff className="h-4 w-4" />
						) : (
							<Eye className="h-4 w-4" />
						)}
					</button>
				</div>
			</div>
			<div className="space-y-1">
				<Label className="text-xs text-muted-foreground">Base URL</Label>
				<Input
					placeholder="https://your-resource.openai.azure.com"
					value={envConfig.graphitiProviderConfig?.azureOpenaiBaseUrl || ""}
					onChange={(e) =>
						updateEnvConfig({
							graphitiProviderConfig: {
								...envConfig.graphitiProviderConfig,
								embeddingProvider: "azure_openai",
								azureOpenaiBaseUrl: e.target.value || undefined,
							},
						})
					}
				/>
			</div>
			<div className="space-y-1">
				<Label className="text-xs text-muted-foreground">
					Embedding Deployment Name
				</Label>
				<Input
					placeholder="text-embedding-ada-002"
					value={
						envConfig.graphitiProviderConfig?.azureOpenaiEmbeddingDeployment ||
						""
					}
					onChange={(e) =>
						updateEnvConfig({
							graphitiProviderConfig: {
								...envConfig.graphitiProviderConfig,
								embeddingProvider: "azure_openai",
								azureOpenaiEmbeddingDeployment: e.target.value || undefined,
							},
						})
					}
				/>
			</div>
		</div>
	);

	const OllamaFields = () => (
		<div className="space-y-4">
			<div className="space-y-2">
				<Label className="text-xs text-muted-foreground">Base URL</Label>
				<Input
					placeholder="http://localhost:11434"
					value={
						envConfig.graphitiProviderConfig?.ollamaBaseUrl ||
						"http://localhost:11434"
					}
					onChange={(e) =>
						updateEnvConfig({
							graphitiProviderConfig: {
								...envConfig.graphitiProviderConfig,
								embeddingProvider: "ollama",
								ollamaBaseUrl: e.target.value,
							},
						})
					}
				/>
			</div>
			<div className="space-y-2">
				<Label className="text-sm font-medium text-foreground">
					Select Embedding Model
				</Label>
				<OllamaModelSelector
					selectedModel={
						envConfig.graphitiProviderConfig?.ollamaEmbeddingModel || ""
					}
					baseUrl={envConfig.graphitiProviderConfig?.ollamaBaseUrl}
					onModelSelect={handleOllamaModelSelect}
				/>
			</div>
		</div>
	);

	// Provider component mapping
	const providerComponents = {
		openai: OpenAIFields,
		voyage: VoyageFields,
		google: GoogleFields,
		azure_openai: AzureFields,
		ollama: OllamaFields,
	};

	// Render provider-specific configuration fields
	const renderProviderFields = () => {
		const ProviderComponent =
			providerComponents[embeddingProvider as keyof typeof providerComponents];
		return ProviderComponent ? <ProviderComponent /> : null;
	};

	return (
		<section className="space-y-3">
			<button
				type="button"
				onClick={onToggle}
				className="w-full flex items-center justify-between text-sm font-semibold text-foreground hover:text-foreground/80"
			>
				<div className="flex items-center gap-2">
					<Database className="h-4 w-4" />
					{t("projectSections.memory.title")}
					<span
						className={`px-2 py-0.5 text-xs rounded-full ${
							envConfig.graphitiEnabled
								? "bg-success/10 text-success"
								: "bg-muted text-muted-foreground"
						}`}
					>
						{envConfig.graphitiEnabled
							? t("common.enabled")
							: t("common.disabled")}
					</span>
				</div>
				{expanded ? (
					<ChevronUp className="h-4 w-4" />
				) : (
					<ChevronDown className="h-4 w-4" />
				)}
			</button>

			{expanded && (
				<div className="space-y-4 pl-6 pt-2">
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label className="font-normal text-foreground">
								{t("projectSections.memory.enableMemory")}
							</Label>
							<p className="text-xs text-muted-foreground">
								{t("projectSections.memory.enableMemoryDescription")}
							</p>
						</div>
						<Switch
							data-guide={GUIDE_ANCHORS.memory.enable}
							checked={envConfig.graphitiEnabled}
							onCheckedChange={(checked) => {
								updateEnvConfig({ graphitiEnabled: checked });
								setSettings({
									...settings,
									memoryBackend: checked ? "graphiti" : "file",
								});
							}}
						/>
					</div>

					{!envConfig.graphitiEnabled && (
						<div className="rounded-lg border border-border bg-muted/30 p-3">
							<p className="text-xs text-muted-foreground">
								{t("projectSections.memory.fileBasedMemoryDescription")}
							</p>
						</div>
					)}

					{envConfig.graphitiEnabled && (
						<>
							{/* Graphiti MCP Server Toggle */}
							<div className="flex items-center justify-between">
								<div className="space-y-0.5">
									<Label className="font-normal text-foreground">
										{t("projectSections.memory.enableAgentMemoryAccess")}
									</Label>
									<p className="text-xs text-muted-foreground">
										{t(
											"projectSections.memory.enableAgentMemoryAccessDescription",
										)}
									</p>
								</div>
								<Switch
									checked={settings.graphitiMcpEnabled}
									onCheckedChange={(checked) =>
										setSettings({ ...settings, graphitiMcpEnabled: checked })
									}
								/>
							</div>

							{settings.graphitiMcpEnabled && (
								<div className="space-y-2 ml-6">
									<Label className="text-sm font-medium text-foreground">
										{t("projectSections.memory.graphitiMcpServerUrl")}
									</Label>
									<p className="text-xs text-muted-foreground">
										{t(
											"projectSections.memory.graphitiMcpServerUrlDescription",
										)}
									</p>
									<Input
										placeholder="http://localhost:8000/mcp/"
										value={settings.graphitiMcpUrl || ""}
										onChange={(e) =>
											setSettings({
												...settings,
												graphitiMcpUrl: e.target.value || undefined,
											})
										}
									/>
								</div>
							)}

							<Separator />

							{/* Embedding Provider Selection */}
							<div className="space-y-2">
								<Label className="text-sm font-medium text-foreground">
									{t("projectSections.memory.embeddingProvider")}
								</Label>
								<p className="text-xs text-muted-foreground">
									{t("projectSections.memory.embeddingProviderDescription")}
								</p>
								<Select
									value={embeddingProvider}
									onValueChange={(value: GraphitiEmbeddingProvider) => {
										updateEnvConfig({
											graphitiProviderConfig: {
												...envConfig.graphitiProviderConfig,
												embeddingProvider: value,
											},
										});
									}}
								>
									<SelectTrigger
										data-guide={GUIDE_ANCHORS.memory.embeddingProvider}
									>
										<SelectValue placeholder="Select embedding provider" />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="ollama">
											Ollama (Local - Free)
										</SelectItem>
										<SelectItem value="openai">OpenAI</SelectItem>
										<SelectItem value="voyage">Voyage AI</SelectItem>
										<SelectItem value="google">Google AI</SelectItem>
										<SelectItem value="azure_openai">Azure OpenAI</SelectItem>
									</SelectContent>
								</Select>
							</div>

							{/* Provider-specific fields */}
							{renderProviderFields()}

							<Separator />

							{/* Database Settings */}
							<div className="space-y-2">
								<Label className="text-sm font-medium text-foreground">
									{t("projectSections.memory.databaseName")}
								</Label>
								<p className="text-xs text-muted-foreground">
									{t("projectSections.memory.databaseNameDescription")}
								</p>
								<Input
									placeholder="auto_claude_memory"
									value={envConfig.graphitiDatabase || ""}
									onChange={(e) =>
										updateEnvConfig({ graphitiDatabase: e.target.value })
									}
								/>
							</div>

							<div className="space-y-2">
								<Label className="text-sm font-medium text-foreground">
									{t("projectSections.memory.databasePath")}
								</Label>
								<p className="text-xs text-muted-foreground">
									{t("projectSections.memory.databasePathDescription")}
								</p>
								<Input
									placeholder="~/.workpilot/memories"
									value={envConfig.graphitiDbPath || ""}
									onChange={(e) =>
										updateEnvConfig({
											graphitiDbPath: e.target.value || undefined,
										})
									}
								/>
							</div>

							{projectPath && (
								<MemoryLifecycleSection projectPath={projectPath} />
							)}
						</>
					)}
				</div>
			)}
		</section>
	);
}
