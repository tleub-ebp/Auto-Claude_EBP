/**
 * Mock Electron module for unit testing
 */
import { EventEmitter } from "node:events";

// Helper function to create mock functions.
// ``T`` is typed as an unknown callable here because createMockFn is used
// both for "empty" mocks (where the caller doesn't supply an impl) and for
// mocks wrapping a concrete function — narrowing with a callable signature
// removes the need for an ``any`` escape hatch.
type AnyFn = (...args: unknown[]) => unknown;

const createMockFn = <T>(impl?: T): T => {
	const mockFn = ((...args: unknown[]) => {
		if (impl && typeof impl === "function") {
			return (impl as AnyFn)(...args);
		}
		return undefined;
	}) as T;
	return mockFn;
};

// Mock app
export const app = {
	getPath: createMockFn((name: string) => {
		const paths: Record<string, string> = {
			userData: "/tmp/test-app-data",
			home: "/tmp/test-home",
			temp: "/tmp",
		};
		return paths[name] || "/tmp";
	}),
	getAppPath: createMockFn(() => "/tmp/test-app"),
	getVersion: createMockFn(() => "0.1.0"),
	isPackaged: false,
	on: createMockFn(),
	quit: createMockFn(),
};

// Mock ipcMain
class MockIpcMain extends EventEmitter {
	private readonly handlers: Map<string, Function> = new Map();

	handle(channel: string, handler: Function): void {
		this.handlers.set(channel, handler);
	}

	handleOnce(channel: string, handler: Function): void {
		this.handlers.set(channel, handler);
	}

	removeHandler(channel: string): void {
		this.handlers.delete(channel);
	}

	// Helper for tests to invoke handlers
	async invokeHandler(
		channel: string,
		event: unknown,
		...args: unknown[]
	): Promise<unknown> {
		const handler = this.handlers.get(channel);
		if (handler) {
			return handler(event, ...args);
		}
		throw new Error(`No handler for channel: ${channel}`);
	}
}

export const ipcMain = new MockIpcMain();

// Mock ipcRenderer
export const ipcRenderer = {
	invoke: createMockFn(),
	send: createMockFn(),
	on: createMockFn(),
	once: createMockFn(),
	removeListener: createMockFn(),
	removeAllListeners: createMockFn(),
	setMaxListeners: createMockFn(),
};

// Mock BrowserWindow
export class BrowserWindow extends EventEmitter {
	webContents = {
		send: createMockFn(),
		on: createMockFn(),
		once: createMockFn(),
		capturePage: createMockFn(() =>
			Promise.resolve({
				toPNG: () => Buffer.from("mock-image"),
			}),
		),
	};

	id = 1;

	constructor(_options?: unknown) {
		super();
	}

	loadURL = createMockFn();
	loadFile = createMockFn();
	show = createMockFn();
	hide = createMockFn();
	close = createMockFn();
	destroy = createMockFn();
	isDestroyed = createMockFn(() => false);
	isFocused = createMockFn(() => true);
	focus = createMockFn();
	blur = createMockFn();
	minimize = createMockFn();
	maximize = createMockFn();
	restore = createMockFn();
	isMinimized = createMockFn(() => false);
	isMaximized = createMockFn(() => false);
	setFullScreen = createMockFn();
	isFullScreen = createMockFn(() => false);
	getBounds = createMockFn(() => ({ x: 0, y: 0, width: 1200, height: 800 }));
	setBounds = createMockFn();
	getContentBounds = createMockFn(() => ({
		x: 0,
		y: 0,
		width: 1200,
		height: 800,
	}));
	setContentBounds = createMockFn();
}

// Mock dialog
export const dialog = {
	showOpenDialog: createMockFn(() =>
		Promise.resolve({ canceled: false, filePaths: ["/test/path"] }),
	),
	showSaveDialog: createMockFn(() =>
		Promise.resolve({ canceled: false, filePath: "/test/save/path" }),
	),
	showMessageBox: createMockFn(() => Promise.resolve({ response: 0 })),
	showErrorBox: createMockFn(),
};

// Mock contextBridge
export const contextBridge = {
	exposeInMainWorld: createMockFn(),
};

// Mock shell
export const shell = {
	openExternal: createMockFn(),
	openPath: createMockFn(),
	showItemInFolder: createMockFn(),
};

// Mock nativeTheme
export const nativeTheme = {
	themeSource: "system" as "system" | "light" | "dark",
	shouldUseDarkColors: false,
	shouldUseHighContrastColors: false,
	shouldUseInvertedColorScheme: false,
	on: createMockFn(),
};

// Mock screen
export const screen = {
	getPrimaryDisplay: createMockFn(() => ({
		workAreaSize: { width: 1920, height: 1080 },
	})),
};

export const desktopCapturer = {
	getSources: createMockFn(() =>
		Promise.resolve([
			{
				id: "screen:0",
				name: "Primary screen",
				thumbnail: {
					getSize: () => ({ width: 1440, height: 1000 }),
					toPNG: () => Buffer.from("mock-desktop-image"),
				},
			},
		]),
	),
};

export default {
	app,
	ipcMain,
	ipcRenderer,
	BrowserWindow,
	dialog,
	contextBridge,
	shell,
	nativeTheme,
	screen,
	desktopCapturer,
};
