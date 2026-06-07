import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { Card, CardContent } from "../../ui/card";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import type { LLMProvider } from "./types";
import { saveUserProviderConfig } from "./utils";

interface Props {
	provider: LLMProvider;
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	onSave: (data: any) => void;
	onCancel: () => void;
}

// Configuration des champs par provider avec clés i18n
const providerFields: Record<
	string,
	Array<{
		name: string;
		labelKey: string;
		type: string;
		required?: boolean;
		placeholderKey?: string;
	}>
> = {
	openai: [
		{
			name: "name",
			labelKey: "accounts.form.name",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.namePlaceholder",
		},
		{
			name: "apiKey",
			labelKey: "accounts.form.apiKey",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.apiKeyPlaceholder",
		},
		{
			name: "baseUrl",
			labelKey: "accounts.form.baseUrl",
			type: "text",
			required: false,
			placeholderKey: "accounts.form.baseUrlPlaceholder",
		},
	],
	gemini: [
		{
			name: "name",
			labelKey: "accounts.form.name",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.namePlaceholder",
		},
		{
			name: "apiKey",
			labelKey: "accounts.form.apiKey",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.apiKeyPlaceholder",
		},
		{
			name: "baseUrl",
			labelKey: "accounts.form.baseUrl",
			type: "text",
			required: false,
			placeholderKey: "accounts.form.baseUrlPlaceholder",
		},
	],
	"meta-llama": [
		{
			name: "name",
			labelKey: "accounts.form.name",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.namePlaceholder",
		},
		{
			name: "apiKey",
			labelKey: "accounts.form.apiKey",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.apiKeyPlaceholder",
		},
		{
			name: "baseUrl",
			labelKey: "accounts.form.baseUrl",
			type: "text",
			required: false,
			placeholderKey: "accounts.form.baseUrlPlaceholder",
		},
	],
	mistral: [
		{
			name: "name",
			labelKey: "accounts.form.name",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.namePlaceholder",
		},
		{
			name: "apiKey",
			labelKey: "accounts.form.apiKey",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.apiKeyPlaceholder",
		},
		{
			name: "baseUrl",
			labelKey: "accounts.form.baseUrl",
			type: "text",
			required: false,
			placeholderKey: "accounts.form.baseUrlPlaceholder",
		},
	],
	deepseek: [
		{
			name: "name",
			labelKey: "accounts.form.name",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.namePlaceholder",
		},
		{
			name: "apiKey",
			labelKey: "accounts.form.apiKey",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.apiKeyPlaceholder",
		},
		{
			name: "baseUrl",
			labelKey: "accounts.form.baseUrl",
			type: "text",
			required: false,
			placeholderKey: "accounts.form.baseUrlPlaceholder",
		},
	],
	grok: [
		{
			name: "name",
			labelKey: "accounts.form.name",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.namePlaceholder",
		},
		{
			name: "apiKey",
			labelKey: "accounts.form.apiKey",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.apiKeyPlaceholder",
		},
		{
			name: "baseUrl",
			labelKey: "accounts.form.baseUrl",
			type: "text",
			required: false,
			placeholderKey: "accounts.form.baseUrlPlaceholder",
		},
	],
	google: [
		{
			name: "name",
			labelKey: "accounts.form.name",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.namePlaceholder",
		},
		{
			name: "apiKey",
			labelKey: "accounts.form.apiKey",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.apiKeyPlaceholder",
		},
		{
			name: "baseUrl",
			labelKey: "accounts.form.baseUrl",
			type: "text",
			required: false,
			placeholderKey: "accounts.form.baseUrlPlaceholder",
		},
	],
	meta: [
		{
			name: "name",
			labelKey: "accounts.form.name",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.namePlaceholder",
		},
		{
			name: "apiKey",
			labelKey: "accounts.form.apiKey",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.apiKeyPlaceholder",
		},
		{
			name: "baseUrl",
			labelKey: "accounts.form.baseUrl",
			type: "text",
			required: false,
			placeholderKey: "accounts.form.baseUrlPlaceholder",
		},
	],
	windsurf: [
		{
			name: "name",
			labelKey: "accounts.form.name",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.namePlaceholder",
		},
		{
			name: "apiKey",
			labelKey: "accounts.form.apiKey",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.apiKeyPlaceholder",
		},
		{
			name: "baseUrl",
			labelKey: "accounts.form.baseUrl",
			type: "text",
			required: false,
			placeholderKey: "accounts.form.baseUrlPlaceholder",
		},
	],
	cursor: [
		{
			name: "name",
			labelKey: "accounts.form.name",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.namePlaceholder",
		},
		{
			name: "apiKey",
			labelKey: "accounts.form.apiKey",
			type: "text",
			required: true,
			placeholderKey: "accounts.form.apiKeyPlaceholder",
		},
		{
			name: "baseUrl",
			labelKey: "accounts.form.baseUrl",
			type: "text",
			required: false,
			placeholderKey: "accounts.form.baseUrlPlaceholder",
		},
		{
			name: "llmGatewayUrl",
			labelKey: "accounts.form.llmGatewayUrl",
			type: "text",
			required: false,
			placeholderKey: "accounts.form.llmGatewayUrlPlaceholder",
		},
	],
	// Fallback générique pour les autres providers
};

const getFieldsForProvider = (provider: string) => {
	return providerFields[provider] || providerFields.openai; // fallback générique
};

const AccountForm: React.FC<Props> = ({ provider, onSave, onCancel }) => {
	const { t } = useTranslation(["settings"]);
	const [models, setModels] = useState<string[]>([]);
	const [formState, setFormState] = useState<Record<string, string>>({});

	useEffect(() => {
		const controller = new AbortController();
		fetch(`/providers/models/${provider}`, { signal: controller.signal })
			.then((res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return res.json();
			})
			.then((data) => setModels(data.models || []))
			.catch((err) => {
				if ((err as { name?: string })?.name === "AbortError") return;
				console.error("Failed to fetch provider models:", err);
				setModels([]);
			});
		setFormState({}); // reset form on provider change
		return () => controller.abort();
	}, [provider]);

	const fields = getFieldsForProvider(provider);

	const handleChange = (
		e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
	) => {
		setFormState({ ...formState, [e.target.name]: e.target.value });
	};

	const handleSave = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		const model = formState.model || "";
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		const config: any = { model };
		if (formState.apiKey) config.api_key = formState.apiKey;
		if (formState.oauthToken) config.oauth_token = formState.oauthToken;
		if (formState.baseUrl) config.base_url = formState.baseUrl;
		if (formState.llmGatewayUrl)
			config.llm_gateway_url = formState.llmGatewayUrl;
		saveUserProviderConfig(provider, config);
		onSave({ ...formState, model });
	};

	return (
		<Card className="border border-info/30 bg-info/10 max-w-md mx-auto">
			<CardContent className="p-6">
				<form onSubmit={handleSave} className="flex flex-col gap-4">
					<h3 className="text-lg font-bold mb-2">
						{t("accounts.form.addAccount", { provider })}
					</h3>
					{fields.map((field) => (
						<div key={field.name} className="space-y-2">
							<Label htmlFor={field.name}>{t(field.labelKey)}</Label>
							<Input
								id={field.name}
								name={field.name}
								placeholder={t(field.placeholderKey || field.labelKey)}
								required={field.required}
								type={field.type}
								value={formState[field.name] || ""}
								onChange={handleChange}
							/>
						</div>
					))}
					<div className="space-y-2">
						<Label htmlFor="model">{t("accounts.form.chooseModel")}</Label>
						<select
							id="model"
							name="model"
							required
							value={formState.model || ""}
							onChange={handleChange}
							className="w-full p-2 border border-input rounded-md bg-background"
						>
							<option value="">{t("accounts.form.chooseModel")}</option>
							{models.map((m) => (
								<option key={m} value={m}>
									{m}
								</option>
							))}
						</select>
					</div>
					<div className="flex gap-3 mt-4">
						<Button type="submit" className="flex-1">
							{t("accounts.form.save")}
						</Button>
						<Button
							type="button"
							variant="outline"
							onClick={onCancel}
							className="flex-1"
						>
							{t("accounts.form.cancel")}
						</Button>
					</div>
				</form>
			</CardContent>
		</Card>
	);
};
export default AccountForm;
