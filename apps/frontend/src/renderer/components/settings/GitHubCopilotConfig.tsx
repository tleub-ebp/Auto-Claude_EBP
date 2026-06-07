/**
 * GitHub Copilot Configuration Component
 *
 * Compact OAuth-first UI: primary action is `gh auth login` via integrated
 * terminal; a Personal Access Token fallback is hidden behind a disclosure.
 */

import {
	AlertCircle,
	CheckCircle,
	Loader2,
	LogIn,
	LogOut,
	XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { useGitHubCopilot } from "../../hooks/useGitHubCopilot";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { GitHubCopilotAuthTerminal } from "./GitHubCopilotAuthTerminal";

function parseGhVersion(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const match = raw.match(/\d+\.\d+(?:\.\d+)?/);
	return match ? match[0] : undefined;
}

export function GitHubCopilotConfig() {
	const { t } = useTranslation("settings");
	const { toast } = useToast();

	const [authTerminal, setAuthTerminal] = useState<{
		terminalId: string;
		profileName: string;
	} | null>(null);
	const [showPatInput, setShowPatInput] = useState(false);
	const [tokenInput, setTokenInput] = useState("");
	const [isTesting, setIsTesting] = useState(false);

	const {
		status,
		config,
		isLoading,
		error,
		setToken,
		removeToken,
		logout,
		testConnection,
		refreshStatus,
		clearError,
	} = useGitHubCopilot();

	useEffect(() => {
		setTokenInput(config.token || "");
	}, [config.token]);

	useEffect(() => {
		if (tokenInput) clearError();
	}, [tokenInput, clearError]);

	const version = parseGhVersion(status.version);

	const handleConnect = () => {
		setAuthTerminal({
			terminalId: `copilot-auth-${Date.now()}`,
			profileName: "GitHub Copilot",
		});
	};

	const handleAuthSuccess = async (username?: string) => {
		setAuthTerminal(null);
		await refreshStatus();
		toast({
			title: t("githubCopilot.authSuccess"),
			description: username
				? `${t("githubCopilot.authSuccessDescription")} (${username})`
				: t("githubCopilot.authSuccessDescription"),
		});
	};

	const handleAuthError = (errorMessage: string) => {
		setAuthTerminal(null);
		toast({
			variant: "destructive",
			title: t("githubCopilot.errors.authFailed"),
			description: errorMessage,
		});
	};

	const handleLogout = async () => {
		try {
			await logout();
			toast({
				title: t("githubCopilot.logoutSuccess"),
				description: t("githubCopilot.logoutSuccessDescription"),
			});
		} catch (err) {
			toast({
				variant: "destructive",
				title: t("githubCopilot.errors.logoutFailed"),
				description:
					err instanceof Error
						? err.message
						: t("githubCopilot.errors.unknownError"),
			});
		}
	};

	const handleSaveToken = async () => {
		if (!tokenInput.trim()) {
			toast({
				variant: "destructive",
				title: t("githubCopilot.errors.tokenRequired"),
				description: t("githubCopilot.errors.tokenRequiredDescription"),
			});
			return;
		}
		try {
			await setToken(tokenInput.trim());
			toast({
				title: t("githubCopilot.tokenSaved"),
				description: t("githubCopilot.tokenSavedDescription"),
			});
			setShowPatInput(false);
		} catch (err) {
			toast({
				variant: "destructive",
				title: t("githubCopilot.errors.saveFailed"),
				description:
					err instanceof Error
						? err.message
						: t("githubCopilot.errors.unknownError"),
			});
		}
	};

	const handleRemoveToken = async () => {
		try {
			await removeToken();
			setTokenInput("");
			toast({
				title: t("githubCopilot.tokenRemoved"),
				description: t("githubCopilot.tokenRemovedDescription"),
			});
		} catch (err) {
			toast({
				variant: "destructive",
				title: t("githubCopilot.errors.removeFailed"),
				description:
					err instanceof Error
						? err.message
						: t("githubCopilot.errors.unknownError"),
			});
		}
	};

	const handleTest = async () => {
		setIsTesting(true);
		try {
			const result = await testConnection();
			toast({
				variant: result.success ? "default" : "destructive",
				title: result.success
					? t("githubCopilot.testSuccess")
					: t("githubCopilot.testFailed"),
				description: result.message,
			});
		} finally {
			setIsTesting(false);
		}
	};

	if (authTerminal) {
		return (
			<div className="h-80 rounded-lg overflow-hidden border border-border">
				<GitHubCopilotAuthTerminal
					terminalId={authTerminal.terminalId}
					profileName={authTerminal.profileName}
					onClose={() => setAuthTerminal(null)}
					onAuthSuccess={handleAuthSuccess}
					onAuthError={handleAuthError}
				/>
			</div>
		);
	}

	const renderStatusLine = () => {
		if (isLoading) {
			return (
				<span className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="w-4 h-4 animate-spin" />
					{t("common:loading")}
				</span>
			);
		}
		if (!status.installed) {
			return (
				<span className="flex items-center gap-2 text-sm text-destructive">
					<XCircle className="w-4 h-4" />
					{t("githubCopilot.status.notInstalled")}
				</span>
			);
		}
		if (status.authenticated) {
			return (
				<span className="flex items-center gap-2 text-sm text-muted-foreground">
					<CheckCircle className="w-4 h-4 text-green-500" />
					{status.username
						? t("githubCopilot.status.authenticatedAs", {
								username: status.username,
							})
						: t("githubCopilot.status.authenticated")}
					{version && (
						<span className="text-xs">• gh {version}</span>
					)}
				</span>
			);
		}
		return (
			<span className="flex items-center gap-2 text-sm text-muted-foreground">
				<AlertCircle className="w-4 h-4" />
				{t("githubCopilot.status.notAuthenticated")}
				{version && <span className="text-xs">• gh {version}</span>}
			</span>
		);
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div className="flex flex-col gap-1">
					<span className="text-sm font-medium">
						{t("githubCopilot.title")}
					</span>
					{renderStatusLine()}
				</div>
				<Badge variant={status.authenticated ? "default" : "secondary"}>
					{status.authenticated
						? t("githubCopilot.status.authenticated")
						: t("githubCopilot.status.notAuthenticated")}
				</Badge>
			</div>

			{error && (
				<Alert variant="destructive">
					<XCircle className="h-4 w-4" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}

			<div className="flex flex-wrap gap-2">
				{status.authenticated ? (
					<Button
						variant="outline"
						size="sm"
						onClick={handleLogout}
						disabled={isLoading}
					>
						<LogOut className="w-4 h-4 mr-1" />
						{t("githubCopilot.logout")}
					</Button>
				) : (
					<Button
						size="sm"
						onClick={handleConnect}
						disabled={isLoading || !status.installed}
					>
						<LogIn className="w-4 h-4 mr-1" />
						{t("githubCopilot.authenticate")}
					</Button>
				)}
				{status.authenticated && (
					<Button
						variant="outline"
						size="sm"
						onClick={handleTest}
						disabled={isTesting}
					>
						{isTesting ? t("common:testing") : t("common:test")}
					</Button>
				)}
				<Button
					variant="ghost"
					size="sm"
					onClick={refreshStatus}
					disabled={isLoading}
				>
					{t("common:refresh")}
				</Button>
			</div>

			<div className="pt-2 border-t border-border">
				{!showPatInput ? (
					<button
						type="button"
						className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
						onClick={() => setShowPatInput(true)}
					>
						{t("githubCopilot.token.useInstead")}
					</button>
				) : (
					<div className="space-y-2 pt-2">
						<Label htmlFor="copilot-pat" className="text-xs">
							{t("githubCopilot.token.inputLabel")}
						</Label>
						<div className="flex gap-2">
							<Input
								id="copilot-pat"
								type="password"
								value={tokenInput}
								onChange={(e) => setTokenInput(e.target.value)}
								placeholder={t("githubCopilot.token.inputPlaceholder")}
								className="font-mono text-sm"
							/>
							<Button
								size="sm"
								onClick={handleSaveToken}
								disabled={!tokenInput.trim() || isLoading}
							>
								{t("githubCopilot.token.save")}
							</Button>
							{config.token && (
								<Button
									variant="outline"
									size="sm"
									onClick={handleRemoveToken}
									disabled={isLoading}
								>
									{t("githubCopilot.token.remove")}
								</Button>
							)}
						</div>
						<button
							type="button"
							className="text-xs text-muted-foreground hover:text-foreground"
							onClick={() => setShowPatInput(false)}
						>
							{t("githubCopilot.token.hide")}
						</button>
					</div>
				)}
			</div>
		</div>
	);
}

export default GitHubCopilotConfig;
