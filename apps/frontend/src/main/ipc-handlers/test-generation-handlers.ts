import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { testGenerationService } from "../test-generation-service";

/**
 * Setup IPC handlers for test generation functionality.
 * Call this once when the app initialises.
 */
export function setupTestGenerationHandlers(
	getMainWindow: () => BrowserWindow | null,
): void {
	// Forward service events to renderer
	testGenerationService.on("status", (status: string) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("test-generation:status", status);
		}
	});

	testGenerationService.on("error", (error: string) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("test-generation:error", error);
		}
	});

	testGenerationService.on("result", (result: unknown) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("test-generation:result", result);
		}
	});

	testGenerationService.on("complete", (result: unknown) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("test-generation:complete", result);
		}
	});

	// Live pipeline stage events (detect/read/generate/write/done)
	testGenerationService.on("progress", (event: unknown) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("test-generation:progress", event);
		}
	});

	// Streamed chunks of clean generated test code
	testGenerationService.on("code", (delta: string) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("test-generation:code", delta);
		}
	});

	// Analyze test coverage
	ipcMain.handle(
		"test-generation:analyze-coverage",
		async (
			_,
			params: {
				filePath: string;
				existingTestPath?: string;
				projectPath?: string;
			},
		) => {
			try {
				await testGenerationService.analyzeCoverage(
					params.filePath,
					params.existingTestPath,
					params.projectPath,
				);
				return { success: true };
			} catch (error) {
				console.error("[TestGeneration] analyze-coverage error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Generate unit tests
	ipcMain.handle(
		"test-generation:generate-unit",
		async (
			_,
			params: {
				filePath: string;
				existingTestPath?: string;
				coverageTarget?: number;
				projectPath?: string;
			},
		) => {
			try {
				await testGenerationService.generateUnitTests(
					params.filePath,
					params.existingTestPath,
					params.coverageTarget,
					params.projectPath,
				);
				return { success: true };
			} catch (error) {
				console.error("[TestGeneration] generate-unit error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Generate E2E tests
	ipcMain.handle(
		"test-generation:generate-e2e",
		async (
			_,
			params: { userStory: string; targetModule: string; projectPath?: string },
		) => {
			try {
				await testGenerationService.generateE2ETests(
					params.userStory,
					params.targetModule,
					params.projectPath,
				);
				return { success: true };
			} catch (error) {
				console.error("[TestGeneration] generate-e2e error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Generate TDD tests
	ipcMain.handle(
		"test-generation:generate-tdd",
		async (
			_,
			params: {
				description: string;
				language: string;
				snippetType: string;
				projectPath?: string;
			},
		) => {
			try {
				await testGenerationService.generateTDDTests(
					params.description,
					params.language,
					params.snippetType,
					params.projectPath,
				);
				return { success: true };
			} catch (error) {
				console.error("[TestGeneration] generate-tdd error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Cancel active generation
	ipcMain.handle("test-generation:cancel", async () => {
		try {
			const cancelled = testGenerationService.cancel();
			return { success: true, cancelled };
		} catch (error) {
			console.error("[TestGeneration] cancel error:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});
}

/**
 * Cleanup IPC handlers for test generation.
 * Call this during app shutdown.
 */
export function cleanupTestGenerationHandlers(): void {
	ipcMain.removeHandler("test-generation:analyze-coverage");
	ipcMain.removeHandler("test-generation:generate-unit");
	ipcMain.removeHandler("test-generation:generate-e2e");
	ipcMain.removeHandler("test-generation:generate-tdd");
	ipcMain.removeHandler("test-generation:cancel");

	testGenerationService.removeAllListeners();
	testGenerationService.cancel();
}
