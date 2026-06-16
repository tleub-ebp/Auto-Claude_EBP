/**
 * Invitation acceptance ("sign up") form for multi-user server mode.
 *
 * Invitation-only: the invitee pastes the invite link (or bare token) plus
 * the server URL, the bound email is fetched read-only from the server, and
 * a password is set. Acceptance auto-logs the user in (tokens are created and
 * held in the main process — never in the renderer). The strength meter is a
 * UX hint only; the server enforces the real password policy.
 */
import { ArrowLeft, Loader2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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

const LAST_SERVER_URL_KEY = "workpilot-last-server-url";
const MIN_PASSWORD_LENGTH = 12;

/** Accept a full invite link (…/invite?token=XYZ) or a bare token. */
function extractToken(raw: string): string {
	const value = raw.trim();
	if (!value) return "";
	try {
		const url = new URL(value);
		const fromQuery = url.searchParams.get("token");
		if (fromQuery) return fromQuery;
	} catch {
		// not a URL — treat as a bare token
	}
	return value;
}

/** Lightweight 0–4 strength score (UX hint only, not a security control). */
function passwordScore(pw: string): number {
	if (!pw) return 0;
	let score = 0;
	if (pw.length >= MIN_PASSWORD_LENGTH) score++;
	if (pw.length >= 16) score++;
	if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
	if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
	return Math.min(score, 4);
}

export function AcceptInviteForm({ onBack }: { onBack: () => void }) {
	const { t } = useTranslation();
	const { serverUrl, lookupInvite, acceptInvite } = useServerSessionStore();

	const [url, setUrl] = useState(
		serverUrl || localStorage.getItem(LAST_SERVER_URL_KEY) || "",
	);
	const [tokenInput, setTokenInput] = useState("");
	const [email, setEmail] = useState<string | null>(null);
	const [displayName, setDisplayName] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [info, setInfo] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const token = useMemo(() => extractToken(tokenInput), [tokenInput]);
	const score = passwordScore(password);

	// Resolve the invited email whenever the URL + token settle.
	useEffect(() => {
		setEmail(null);
		setInfo(null);
		if (!url.trim() || token.length < 16) return;
		let cancelled = false;
		const handle = setTimeout(async () => {
			const result = await lookupInvite(url.trim(), token);
			if (cancelled) return;
			if (result.ok && result.email) {
				setEmail(result.email);
				setError(null);
			} else {
				setEmail(null);
				setInfo(
					result.error ||
						t("acceptInvite.invalidToken", "Invitation introuvable ou expirée"),
				);
			}
		}, 500);
		return () => {
			cancelled = true;
			clearTimeout(handle);
		};
	}, [url, token, lookupInvite, t]);

	const canSubmit =
		!!email &&
		displayName.trim().length > 0 &&
		password.length >= MIN_PASSWORD_LENGTH &&
		password === confirm &&
		!busy;

	const handleAccept = useCallback(async () => {
		setError(null);
		setBusy(true);
		try {
			const trimmed = url.trim();
			localStorage.setItem(LAST_SERVER_URL_KEY, trimmed);
			const result = await acceptInvite(
				trimmed,
				token,
				displayName.trim(),
				password,
			);
			if (!result.ok) {
				setError(
					result.error ||
						t("acceptInvite.failed", "Impossible de créer le compte"),
				);
			}
		} finally {
			setBusy(false);
		}
	}, [url, token, displayName, password, acceptInvite, t]);

	const strengthLabels = [
		t("acceptInvite.strength0", "Très faible"),
		t("acceptInvite.strength1", "Faible"),
		t("acceptInvite.strength2", "Moyen"),
		t("acceptInvite.strength3", "Bon"),
		t("acceptInvite.strength4", "Fort"),
	];
	const strengthColors = [
		"bg-destructive",
		"bg-destructive",
		"bg-amber-500",
		"bg-emerald-500",
		"bg-emerald-600",
	];

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<UserPlus className="h-5 w-5" />
						{t("acceptInvite.title", "Créer votre compte")}
					</CardTitle>
					<CardDescription>
						{t(
							"acceptInvite.description",
							"Utilisez le lien d'invitation reçu pour définir votre mot de passe.",
						)}
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="invite-server-url">
							{t("serverLogin.serverUrl", "URL du serveur")}
						</Label>
						<Input
							id="invite-server-url"
							placeholder="https://workpilot.example.com"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
						/>
					</div>

					<div className="space-y-2">
						<Label htmlFor="invite-token">
							{t("acceptInvite.tokenLabel", "Lien ou code d'invitation")}
						</Label>
						<Input
							id="invite-token"
							placeholder="https://…/invite?token=…"
							value={tokenInput}
							onChange={(e) => setTokenInput(e.target.value)}
							autoFocus
						/>
						{info && <p className="text-sm text-muted-foreground">{info}</p>}
					</div>

					{email && (
						<>
							<div className="space-y-2">
								<Label htmlFor="invite-email">
									{t("serverLogin.email", "Email")}
								</Label>
								<Input id="invite-email" value={email} readOnly disabled />
							</div>

							<div className="space-y-2">
								<Label htmlFor="invite-name">
									{t("acceptInvite.displayName", "Nom affiché")}
								</Label>
								<Input
									id="invite-name"
									value={displayName}
									onChange={(e) => setDisplayName(e.target.value)}
								/>
							</div>

							<div className="space-y-2">
								<Label htmlFor="invite-password">
									{t("serverLogin.password", "Mot de passe")}
								</Label>
								<Input
									id="invite-password"
									type="password"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
								/>
								<div className="flex items-center gap-2">
									<div className="h-1.5 flex-1 rounded bg-muted">
										<div
											className={`h-full rounded transition-all ${strengthColors[score]}`}
											style={{ width: `${(score / 4) * 100}%` }}
										/>
									</div>
									<span className="w-16 text-right text-xs text-muted-foreground">
										{strengthLabels[score]}
									</span>
								</div>
								<p className="text-xs text-muted-foreground">
									{t(
										"acceptInvite.passwordHint",
										"Au moins 12 caractères. Évitez un mot de passe déjà utilisé ailleurs.",
									)}
								</p>
							</div>

							<div className="space-y-2">
								<Label htmlFor="invite-confirm">
									{t("acceptInvite.confirm", "Confirmer le mot de passe")}
								</Label>
								<Input
									id="invite-confirm"
									type="password"
									value={confirm}
									onChange={(e) => setConfirm(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && canSubmit) void handleAccept();
									}}
								/>
								{confirm.length > 0 && confirm !== password && (
									<p className="text-xs text-destructive">
										{t(
											"acceptInvite.mismatch",
											"Les mots de passe ne correspondent pas",
										)}
									</p>
								)}
							</div>
						</>
					)}

					{error && (
						<p className="text-sm text-destructive" role="alert">
							{error}
						</p>
					)}

					<div className="flex gap-2">
						<Button
							className="flex-1"
							variant="default"
							disabled={!canSubmit}
							onClick={handleAccept}
						>
							{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
							{t("acceptInvite.submit", "Créer mon compte")}
						</Button>
						<Button variant="outline" disabled={busy} onClick={onBack}>
							<ArrowLeft className="mr-2 h-4 w-4" />
							{t("acceptInvite.back", "Retour")}
						</Button>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
