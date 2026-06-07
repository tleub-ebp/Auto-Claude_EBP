/**
 * useGitHubCopilot Hook
 *
 * Hook React pour interagir facilement avec le GitHubCopilotService
 */

import {
	type CopilotConfig,
	type CopilotStatus,
	gitHubCopilotService,
} from "@shared/services/githubCopilotService";
import { useCallback, useEffect, useState } from "react";

export interface UseGitHubCopilotReturn {
	// États
	status: CopilotStatus;
	config: CopilotConfig;
	isLoading: boolean;
	error: string | null;

	// Actions
	setToken: (token: string) => Promise<void>;
	removeToken: () => Promise<void>;
	authenticate: () => Promise<void>;
	logout: () => Promise<void>;
	testConnection: () => Promise<{
		success: boolean;
		message: string;
		details?: unknown;
	}>;
	refreshStatus: () => Promise<void>;

	// Utilitaires
	clearError: () => void;
}

/**
 * Hook pour utiliser le GitHub Copilot Service
 */
export function useGitHubCopilot(): UseGitHubCopilotReturn {
	const [status, setStatus] = useState<CopilotStatus>({
		installed: false,
		authenticated: false,
	});
	const [config, setConfig] = useState<CopilotConfig>({ enabled: false });
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	/**
	 * Charger les données initiales
	 */
	const loadInitialData = useCallback(async () => {
		try {
			setIsLoading(true);
			setError(null);

			// Charger le statut
			const statusData = await gitHubCopilotService.getStatus();
			setStatus(statusData);

			// Charger la configuration
			const configData = await gitHubCopilotService.getConfig();
			setConfig(configData);

			setIsLoading(false);
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : "Unknown error";
			setError(errorMessage);
			setIsLoading(false);
		}
	}, []);

	const reloadState = useCallback(async (): Promise<void> => {
		const [statusData, configData] = await Promise.all([
			gitHubCopilotService.getStatus(),
			gitHubCopilotService.getConfig(),
		]);
		setStatus(statusData);
		setConfig(configData);
	}, []);

	/**
	 * Configurer le token
	 */
	const setToken = useCallback(
		async (token: string): Promise<void> => {
			try {
				setError(null);
				await gitHubCopilotService.setToken(token);
				await reloadState();
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : "Failed to set token";
				setError(errorMessage);
				throw err;
			}
		},
		[reloadState],
	);

	/**
	 * Supprimer le token
	 */
	const removeToken = useCallback(async (): Promise<void> => {
		try {
			setError(null);
			await gitHubCopilotService.removeToken();
			await reloadState();
		} catch (err) {
			const errorMessage =
				err instanceof Error ? err.message : "Failed to remove token";
			setError(errorMessage);
			throw err;
		}
	}, [reloadState]);

	/**
	 * Authentifier avec GitHub CLI
	 */
	const authenticate = useCallback(async (): Promise<void> => {
		try {
			setError(null);
			await gitHubCopilotService.authenticate();
			await gitHubCopilotService.refreshStatus();
			await reloadState();
		} catch (err) {
			const errorMessage =
				err instanceof Error ? err.message : "Failed to authenticate";
			setError(errorMessage);
			throw err;
		}
	}, [reloadState]);

	/**
	 * Se déconnecter
	 */
	const logout = useCallback(async (): Promise<void> => {
		try {
			setError(null);
			await gitHubCopilotService.logout();
			await reloadState();
		} catch (err) {
			const errorMessage =
				err instanceof Error ? err.message : "Failed to logout";
			setError(errorMessage);
			throw err;
		}
	}, [reloadState]);

	/**
	 * Tester la connexion
	 */
	const testConnection = useCallback(async (): Promise<{
		success: boolean;
		message: string;
		details?: unknown;
	}> => {
		try {
			setError(null);
			return await gitHubCopilotService.testConnection();
		} catch (err) {
			const errorMessage =
				err instanceof Error ? err.message : "Failed to test connection";
			setError(errorMessage);
			return { success: false, message: errorMessage };
		}
	}, []);

	/**
	 * Rafraîchir le statut
	 */
	const refreshStatus = useCallback(async (): Promise<void> => {
		try {
			setError(null);
			setIsLoading(true);
			await gitHubCopilotService.refreshStatus();
			const [statusData, configData] = await Promise.all([
				gitHubCopilotService.getStatus(),
				gitHubCopilotService.getConfig(),
			]);
			setStatus(statusData);
			setConfig(configData);
		} catch (err) {
			const errorMessage =
				err instanceof Error ? err.message : "Failed to refresh status";
			setError(errorMessage);
		} finally {
			setIsLoading(false);
		}
	}, []);

	/**
	 * Effacer l'erreur
	 */
	const clearError = useCallback(() => {
		setError(null);
	}, []);

	// Effet pour charger les données initiales et s'abonner aux événements
	useEffect(() => {
		loadInitialData();

		// S'abonner aux événements
		const handleStatusUpdated = (newStatus: CopilotStatus) => {
			setStatus(newStatus);
			setIsLoading(false);
		};

		const handleConfigUpdated = (newConfig: CopilotConfig) => {
			setConfig(newConfig);
		};

		gitHubCopilotService.on("status-updated", handleStatusUpdated);
		gitHubCopilotService.on("config-updated", handleConfigUpdated);

		return () => {
			gitHubCopilotService.off("status-updated", handleStatusUpdated);
			gitHubCopilotService.off("config-updated", handleConfigUpdated);
		};
	}, [loadInitialData]);

	return {
		// États
		status,
		config,
		isLoading,
		error,

		// Actions
		setToken,
		removeToken,
		authenticate,
		logout,
		testConnection,
		refreshStatus,

		// Utilitaires
		clearError,
	};
}
