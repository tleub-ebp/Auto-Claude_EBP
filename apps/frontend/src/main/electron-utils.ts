/**
 * Centralized Electron utilities to reduce duplicate imports
 * All Electron API imports should go through this module
 */

import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
// Core Electron imports
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

export type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
// Re-export commonly used Electron APIs using export..from syntax
export {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	Menu,
	nativeImage,
	shell,
} from "electron";

// Re-export commonly used functions
export const getCurrentWindow = (): BrowserWindow | null => {
	return (
		BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null
	);
};

export const getAppPath = (): string => {
	return app.getAppPath();
};

export const getUserDataPath = (): string => {
	return app.getPath("userData");
};

export const showMessageBox = async (
	options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> => {
	const window = getCurrentWindow();
	if (window) {
		return dialog.showMessageBox(window, options);
	} else {
		return dialog.showMessageBox(options);
	}
};

export const showOpenDialog = async (
	options: Electron.OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> => {
	const window = getCurrentWindow();
	if (window) {
		return dialog.showOpenDialog(window, options);
	} else {
		return dialog.showOpenDialog(options);
	}
};

export const showSaveDialog = async (
	options: Electron.SaveDialogOptions,
): Promise<Electron.SaveDialogReturnValue> => {
	const window = getCurrentWindow();
	if (window) {
		return dialog.showSaveDialog(window, options);
	} else {
		return dialog.showSaveDialog(options);
	}
};

// Allowed URL schemes for shell.openExternal. WITHOUT this allowlist a
// renderer (or a malicious LLM tool call routed through the renderer)
// could open `file://path/to/evil.exe`, `javascript:`, or arbitrary
// custom protocols (`vscode:`, `slack:`, ...) that map to local apps and
// trigger code execution. We restrict to plain web + mailto.
const _ALLOWED_OPEN_EXTERNAL_SCHEMES = new Set([
	"http:",
	"https:",
	"mailto:",
]);

export const openExternal = async (url: string): Promise<void> => {
	if (typeof url !== "string" || url.length === 0) {
		throw new Error("openExternal: url must be a non-empty string");
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`openExternal: invalid URL: ${url.slice(0, 200)}`);
	}
	if (!_ALLOWED_OPEN_EXTERNAL_SCHEMES.has(parsed.protocol)) {
		throw new Error(
			`openExternal: scheme "${parsed.protocol}" not allowed (only http/https/mailto)`,
		);
	}
	return shell.openExternal(parsed.toString());
};

export const quitApp = (): void => {
	app.quit();
};

export const minimizeWindow = (): void => {
	const window = getCurrentWindow();
	if (window) {
		window.minimize();
	}
};

export const maximizeWindow = (): void => {
	const window = getCurrentWindow();
	if (window) {
		if (window.isMaximized()) {
			window.unmaximize();
		} else {
			window.maximize();
		}
	}
};

export const closeWindow = (): void => {
	const window = getCurrentWindow();
	if (window) {
		window.close();
	}
};

// IPC utilities
// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
export const createIpcHandler = <T extends any[], R>(
	channel: string,
	handler: (event: IpcMainInvokeEvent, ...args: T) => Promise<R>,
): void => {
	ipcMain.handle(channel, handler);
};

export const createIpcListener = (
	channel: string,
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	handler: (event: IpcMainEvent, ...args: any[]) => void,
): void => {
	ipcMain.on(channel, handler);
};

export const removeIpcListener = (
	channel: string,
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	handler: (event: IpcMainEvent, ...args: any[]) => void,
): void => {
	ipcMain.off(channel, handler);
};
