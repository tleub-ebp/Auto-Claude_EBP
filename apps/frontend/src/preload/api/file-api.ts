import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { IPCResult } from "../../shared/types";

export interface FileAPI {
	// File Explorer Operations
	listDirectory: (
		dirPath: string,
	) => Promise<IPCResult<import("../../shared/types").FileNode[]>>;
	readFile: (filePath: string) => Promise<IPCResult<string>>;
	saveJsonFile: (
		dirPath: string,
		fileName: string,
		data: unknown,
	) => Promise<IPCResult<boolean>>;
	getUserHome: () => Promise<string>;
	searchProjectFiles: (
		rootPath: string,
		query: string,
		mode: "file" | "directory",
	) => Promise<IPCResult<import("../../shared/types").FileSearchResult[]>>;
}

export const createFileAPI = (): FileAPI => ({
	// File Explorer Operations
	listDirectory: (
		dirPath: string,
	): Promise<IPCResult<import("../../shared/types").FileNode[]>> =>
		ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPLORER_LIST, dirPath),
	readFile: (filePath: string): Promise<IPCResult<string>> =>
		ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPLORER_READ, filePath),
	saveJsonFile: (
		dirPath: string,
		fileName: string,
		data: unknown,
	): Promise<IPCResult<boolean>> =>
		ipcRenderer.invoke(
			IPC_CHANNELS.FILE_EXPLORER_SAVE,
			dirPath,
			fileName,
			data,
		),
	getUserHome: (): Promise<string> =>
		ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPLORER_GET_USER_HOME),
	searchProjectFiles: (
		rootPath: string,
		query: string,
		mode: "file" | "directory",
	): Promise<IPCResult<import("../../shared/types").FileSearchResult[]>> =>
		ipcRenderer.invoke(
			IPC_CHANNELS.FILE_EXPLORER_SEARCH,
			rootPath,
			query,
			mode,
		),
});
