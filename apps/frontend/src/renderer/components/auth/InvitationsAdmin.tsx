/**
 * Admin-only invitation management (multi-user server mode).
 *
 * Lets an admin issue invitation links, see pending invitations and revoke
 * them. Account creation is invitation-only, so this is the entry point for
 * onboarding new users. The generated link is shown so it can be shared
 * manually when SMTP is disabled or delivery fails.
 */
import { Check, Copy, Loader2, Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Label } from "@/components/ui";
import type { InvitationPublic } from "../../../preload/api/modules/server-auth-api";

export function InvitationsAdmin() {
	const { t } = useTranslation("settings");
	const [email, setEmail] = useState("");
	const [role, setRole] = useState("member");
	const [pending, setPending] = useState<InvitationPublic[]>([]);
	const [lastLink, setLastLink] = useState<string | null>(null);
	const [lastEmailSent, setLastEmailSent] = useState<boolean | null>(null);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		const result = await window.electronAPI.serverAuth.listInvites();
		if (result.ok) setPending(result.data);
		else setError(result.error);
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const handleCreate = useCallback(async () => {
		setError(null);
		setLastLink(null);
		setBusy(true);
		try {
			const result = await window.electronAPI.serverAuth.createInvite({
				email: email.trim(),
				role,
			});
			if (result.ok) {
				setLastLink(result.data.invite_link);
				setLastEmailSent(result.data.email_sent);
				setEmail("");
				await refresh();
			} else {
				setError(result.error);
			}
		} finally {
			setBusy(false);
		}
	}, [email, role, refresh]);

	const handleRevoke = useCallback(
		async (id: string) => {
			const result = await window.electronAPI.serverAuth.revokeInvite(id);
			if (result.ok) await refresh();
			else setError(result.error);
		},
		[refresh],
	);

	const handleCopy = useCallback(async () => {
		if (!lastLink) return;
		await navigator.clipboard.writeText(lastLink);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	}, [lastLink]);

	return (
		<div className="space-y-6">
			<div>
				<h3 className="text-lg font-semibold">
					{t("invitationsAdmin.title", "Invitations")}
				</h3>
				<p className="text-sm text-muted-foreground">
					{t(
						"invitationsAdmin.description",
						"Invitez de nouveaux membres. La création de compte se fait uniquement sur invitation.",
					)}
				</p>
			</div>

			<div className="space-y-3 rounded-lg border border-border p-4">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-end">
					<div className="flex-1 space-y-2">
						<Label htmlFor="invite-email">
							{t("invitationsAdmin.email", "Email du nouvel utilisateur")}
						</Label>
						<Input
							id="invite-email"
							type="email"
							placeholder="personne@exemple.com"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="invite-role">
							{t("invitationsAdmin.role", "Rôle")}
						</Label>
						<select
							id="invite-role"
							className="h-9 rounded-md border border-input bg-background px-3 text-sm"
							value={role}
							onChange={(e) => setRole(e.target.value)}
						>
							<option value="member">
								{t("invitationsAdmin.roleMember", "Membre")}
							</option>
							<option value="viewer">
								{t("invitationsAdmin.roleViewer", "Lecteur")}
							</option>
							<option value="admin">
								{t("invitationsAdmin.roleAdmin", "Administrateur")}
							</option>
						</select>
					</div>
					<Button onClick={handleCreate} disabled={!email.trim() || busy}>
						{busy ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<UserPlus className="mr-2 h-4 w-4" />
						)}
						{t("invitationsAdmin.create", "Inviter")}
					</Button>
				</div>

				{lastLink && (
					<div className="space-y-2 rounded-md bg-muted/50 p-3">
						<p className="text-sm">
							{lastEmailSent
								? t(
										"invitationsAdmin.emailSent",
										"Invitation envoyée par email. Vous pouvez aussi partager le lien :",
									)
								: t(
										"invitationsAdmin.emailNotSent",
										"Email non envoyé (SMTP non configuré). Partagez ce lien à usage unique :",
									)}
						</p>
						<div className="flex items-center gap-2">
							<Input readOnly value={lastLink} className="flex-1 font-mono text-xs" />
							<Button variant="outline" size="sm" onClick={handleCopy}>
								{copied ? (
									<Check className="h-4 w-4" />
								) : (
									<Copy className="h-4 w-4" />
								)}
							</Button>
						</div>
					</div>
				)}
			</div>

			{error && (
				<p className="text-sm text-destructive" role="alert">
					{error}
				</p>
			)}

			<div className="space-y-2">
				<h4 className="text-sm font-medium">
					{t("invitationsAdmin.pending", "Invitations en attente")}
				</h4>
				{pending.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						{t("invitationsAdmin.none", "Aucune invitation en attente.")}
					</p>
				) : (
					<ul className="divide-y divide-border rounded-lg border border-border">
						{pending.map((inv) => (
							<li
								key={inv.id}
								className="flex items-center justify-between gap-3 p-3"
							>
								<div className="min-w-0">
									<div className="truncate text-sm font-medium">{inv.email}</div>
									<div className="text-xs text-muted-foreground">
										{inv.role} ·{" "}
										{t("invitationsAdmin.expires", "expire le")}{" "}
										{new Date(inv.expires_at).toLocaleString()}
									</div>
								</div>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => handleRevoke(inv.id)}
									title={t("invitationsAdmin.revoke", "Révoquer")}
								>
									<Trash2 className="h-4 w-4 text-destructive" />
								</Button>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
