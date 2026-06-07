/**
 * Copilot CLI API for renderer process
 *
 * Provides access to Copilot CLI management:
 * - Check installed vs latest version
 * - Install or update Copilot extension
 * - Get installations list
 * - Set active gh path
 * - Check/start authentication
 */

import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	CopilotCliVersionInfo,
	CopilotInstallationList,
} from "../../../shared/types/cli";
import { invokeIpc } from "./ipc-utils";

/**
 * Result of Copilot CLI installation attempt
 */
export interface CopilotCliInstallResult {
	success: boolean;
	data?: {
		command: string;
	};
	error?: string;
}

/**
 * Result of version check
 */
export interface CopilotCliVersionResult {
	success: boolean;
	data?: CopilotCliVersionInfo;
	error?: string;
}

/**
 * Result of getting installations
 */
export interface CopilotCliInstallationsResult {
	success: boolean;
	data?: CopilotInstallationList;
	error?: string;
}

/**
 * Result of setting active path
 */
export interface CopilotCliSetActivePathResult {
	success: boolean;
	data?: {
		path: string;
	};
	error?: string;
}

/**
 * Result of silent install/update attempt
 */
export interface CopilotCliSilentInstallResult {
	success: boolean;
	data?: {
		stdout: string;
		stderr: string;
	};
	error?: string;
}

/**
 * Result of auth check
 */
export interface CopilotCliAuthResult {
	success: boolean;
	data?: {
		authenticated: boolean;
		username?: string;
	};
	error?: string;
}

/**
 * Result of starting auth
 */
export interface CopilotCliStartAuthResult {
	success: boolean;
	data?: {
		command: string;
	};
	error?: string;
}

/**
 * Copilot CLI API interface exposed to renderer
 */
export interface CopilotCliAPI {
	/**
	 * Check Copilot CLI version status
	 * Returns installed version, gh version, latest version, and whether update is available
	 */
	checkCopilotCliVersion: () => Promise<CopilotCliVersionResult>;

	/**
	 * Install or update Copilot CLI extension
	 * Opens the user's terminal with the install/upgrade command
	 */
	installCopilotCli: () => Promise<CopilotCliInstallResult>;

	/**
	 * Install or update Copilot CLI extension silently in the background.
	 * Runs `gh copilot install` / `gh copilot update` without opening a terminal.
	 */
	installCopilotCliSilent: () => Promise<CopilotCliSilentInstallResult>;

	/**
	 * Get all Copilot CLI installations found on the system
	 * Returns list of gh installations with copilot extension
	 */
	getCopilotCliInstallations: () => Promise<CopilotCliInstallationsResult>;

	/**
	 * Set the active gh CLI path for Copilot
	 * Updates settings and CLI tool manager cache
	 */
	setCopilotCliActivePath: (
		cliPath: string,
	) => Promise<CopilotCliSetActivePathResult>;

	/**
	 * Check Copilot CLI authentication status
	 * Verifies gh auth status and copilot scope
	 */
	checkCopilotAuth: () => Promise<CopilotCliAuthResult>;

	/**
	 * Start Copilot CLI authentication
	 * Opens terminal with `gh auth login`
	 */
	startCopilotAuth: () => Promise<CopilotCliStartAuthResult>;
}

/**
 * Creates the Copilot CLI API implementation
 */
export const createCopilotCliAPI = (): CopilotCliAPI => ({
	checkCopilotCliVersion: (): Promise<CopilotCliVersionResult> =>
		invokeIpc(IPC_CHANNELS.COPILOT_CLI_CHECK_VERSION),

	installCopilotCli: (): Promise<CopilotCliInstallResult> =>
		invokeIpc(IPC_CHANNELS.COPILOT_CLI_INSTALL),

	installCopilotCliSilent: (): Promise<CopilotCliSilentInstallResult> =>
		invokeIpc(IPC_CHANNELS.COPILOT_CLI_INSTALL_SILENT),

	getCopilotCliInstallations: (): Promise<CopilotCliInstallationsResult> =>
		invokeIpc(IPC_CHANNELS.COPILOT_CLI_GET_INSTALLATIONS),

	setCopilotCliActivePath: (
		cliPath: string,
	): Promise<CopilotCliSetActivePathResult> =>
		invokeIpc(IPC_CHANNELS.COPILOT_CLI_SET_ACTIVE_PATH, cliPath),

	checkCopilotAuth: (): Promise<CopilotCliAuthResult> =>
		invokeIpc(IPC_CHANNELS.COPILOT_CLI_CHECK_AUTH),

	startCopilotAuth: (): Promise<CopilotCliStartAuthResult> =>
		invokeIpc(IPC_CHANNELS.COPILOT_CLI_START_AUTH),
});
