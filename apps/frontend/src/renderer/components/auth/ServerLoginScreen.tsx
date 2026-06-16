/**
 * Full-screen connection gate for multi-user server mode.
 *
 * Lets the user pick between local mode (historical single-user behavior)
 * and a shared WorkPilot server, then sign in with a local account or
 * Microsoft Entra ID (system browser + PKCE, handled by the main process).
 */
import { Loader2, Monitor, Server } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
	Label,
} from "@/components/ui";
import { useServerSessionStore } from "../../stores/server-session-store";
import { AcceptInviteForm } from "./AcceptInviteForm";

const LAST_SERVER_URL_KEY = "workpilot-last-server-url";

export function ServerLoginScreen() {
	const { t } = useTranslation();
	const { serverUrl, loginLocal, loginEntra, switchToLocalMode } =
		useServerSessionStore();

	const [view, setView] = useState<"login" | "invite">("login");

	const [url, setUrl] = useState(
		serverUrl || localStorage.getItem(LAST_SERVER_URL_KEY) || "",
	);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<"local" | "entra" | null>(null);
	const [entraEnabled, setEntraEnabled] = useState<boolean | null>(null);

	// Probe the server's auth config whenever the URL settles, so the UI
	// only offers the methods the server actually supports.
	useEffect(() => {
		if (!url.trim()) return;
		const handle = setTimeout(async () => {
			const config = await window.electronAPI.serverAuth.getConfig(url.trim());
			setEntraEnabled(config.ok ? config.data.entra_enabled : null);
		}, 500);
		return () => clearTimeout(handle);
	}, [url]);

	const rememberUrl = useCallback((value: string) => {
		localStorage.setItem(LAST_SERVER_URL_KEY, value);
	}, []);

	const handleLocalLogin = useCallback(async () => {
		setError(null);
		setBusy("local");
		try {
			const trimmed = url.trim();
			rememberUrl(trimmed);
			const result = await loginLocal(trimmed, email.trim(), password);
			if (!result.ok) setError(result.error || "Connexion impossible");
		} finally {
			setBusy(null);
		}
	}, [url, email, password, loginLocal, rememberUrl]);

	const handleEntraLogin = useCallback(async () => {
		setError(null);
		setBusy("entra");
		try {
			const trimmed = url.trim();
			rememberUrl(trimmed);
			const result = await loginEntra(trimmed);
			if (!result.ok) setError(result.error || "Connexion impossible");
		} finally {
			setBusy(null);
		}
	}, [url, loginEntra, rememberUrl]);

	if (view === "invite") {
		return <AcceptInviteForm onBack={() => setView("login")} />;
	}

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Server className="h-5 w-5" />
						{t("serverLogin.title", "Connexion au serveur WorkPilot")}
					</CardTitle>
					<CardDescription>
						{t(
							"serverLogin.description",
							"Connectez-vous à un serveur partagé, ou continuez en mode local.",
						)}
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="server-url">
							{t("serverLogin.serverUrl", "URL du serveur")}
						</Label>
						<Input
							id="server-url"
							placeholder="https://workpilot.example.com"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							autoFocus
						/>
					</div>

					{entraEnabled && (
						<Button
							className="w-full"
							variant="default"
							disabled={!url.trim() || busy !== null}
							onClick={handleEntraLogin}
						>
							{busy === "entra" ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : null}
							{t("serverLogin.entraButton", "Se connecter avec Microsoft")}
						</Button>
					)}

					<div className="space-y-2">
						<Label htmlFor="login-email">
							{t("serverLogin.email", "Email")}
						</Label>
						<Input
							id="login-email"
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
						/>
						<Label htmlFor="login-password">
							{t("serverLogin.password", "Mot de passe")}
						</Label>
						<Input
							id="login-password"
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void handleLocalLogin();
							}}
						/>
					</div>

					{error && (
						<p className="text-sm text-destructive" role="alert">
							{error}
						</p>
					)}

					<div className="flex gap-2">
						<Button
							className="flex-1"
							variant="secondary"
							disabled={
								!url.trim() || !email.trim() || !password || busy !== null
							}
							onClick={handleLocalLogin}
						>
							{busy === "local" ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : null}
							{t("serverLogin.localAccountButton", "Connexion")}
						</Button>
						<Button
							className="flex-1"
							variant="outline"
							disabled={busy !== null}
							onClick={() => void switchToLocalMode()}
						>
							<Monitor className="mr-2 h-4 w-4" />
							{t("serverLogin.localModeButton", "Mode local")}
						</Button>
					</div>

					<button
						type="button"
						className="w-full text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
						disabled={busy !== null}
						onClick={() => {
							setError(null);
							setView("invite");
						}}
					>
						{t("serverLogin.haveInvite", "J'ai une invitation")}
					</button>
				</CardContent>
			</Card>
		</div>
	);
}
