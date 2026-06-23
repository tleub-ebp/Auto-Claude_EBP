/**
 * Portable Ollama manager
 * =======================
 *
 * Makes a local LLM "just work" on every OS without the user installing
 * anything by hand: it downloads the official **standalone** Ollama binary into
 * the app's own data directory (`userData/ollama/`), extracts it, and runs
 * `ollama serve` itself — no admin/sudo, no system install, no terminal.
 *
 * Cross-platform notes:
 *   - Assets come from the stable GitHub "latest" release URLs.
 *   - Windows ships a .zip (extracted with the bundled `unzipper`), macOS/Linux
 *     ship a .tgz (extracted with the system `tar`, always present there).
 *   - The managed server uses a managed models dir (`userData/ollama/models`)
 *     so pulls and serving stay self-contained and never collide with a
 *     system Ollama the user might also have.
 *
 * A system-wide Ollama, if already installed, is preferred (we don't duplicate
 * a multi-GB download); the portable path is the automatic fallback.
 */

import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { app, net } from "electron";
import unzipper from "unzipper";
import { getOllamaExecutablePaths } from "../platform";

const execFileAsync = promisify(execFile);

const GITHUB_LATEST = "https://github.com/ollama/ollama/releases/latest/download";

export interface EnsureProgress {
	/** Coarse stage so the UI can show a meaningful label. */
	phase: "resolving" | "downloading" | "extracting" | "starting" | "ready";
	/** 0–100 during "downloading"; -1 (indeterminate) otherwise. */
	percentage: number;
	message: string;
}

export interface EnsureResult {
	success: boolean;
	running: boolean;
	url: string;
	/** Whether we used the app-managed portable binary (vs a system install). */
	managed: boolean;
	binaryPath?: string;
	error?: string;
}

/**
 * Map the current platform/arch to the official standalone release asset name.
 * Exported (and pure) so it can be unit-tested without touching the network.
 */
export function ollamaReleaseAsset(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): string | null {
	const a = arch === "arm64" ? "arm64" : "amd64";
	if (platform === "win32") return `ollama-windows-${a}.zip`;
	if (platform === "darwin") return "ollama-darwin.tgz"; // universal binary
	if (platform === "linux") return `ollama-linux-${a}.tgz`;
	return null;
}

function managedDir(): string {
	return path.join(app.getPath("userData"), "ollama");
}

function managedModelsDir(): string {
	return path.join(managedDir(), "models");
}

function extractedDir(): string {
	return path.join(managedDir(), "dist");
}

/**
 * Relative paths where the `ollama` binary may sit inside the extracted archive,
 * across the various release layouts (root, or under bin/).
 */
function binaryCandidates(): string[] {
	const exe = process.platform === "win32" ? "ollama.exe" : "ollama";
	return [exe, path.join("bin", exe)];
}

/** Recursively search a directory for the ollama binary (last-resort locator). */
function findBinaryRecursive(dir: string): string | null {
	const exe = process.platform === "win32" ? "ollama.exe" : "ollama";
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isFile() && e.name === exe) return full;
		if (e.isDirectory()) {
			const hit = findBinaryRecursive(full);
			if (hit) return hit;
		}
	}
	return null;
}

/** Path to the managed portable binary if it has already been extracted. */
function resolveManagedBinary(): string | null {
	const base = extractedDir();
	for (const rel of binaryCandidates()) {
		const full = path.join(base, rel);
		if (fs.existsSync(full)) return full;
	}
	return findBinaryRecursive(base);
}

/**
 * Locate any usable ollama binary: a system install first (so we never
 * re-download what the user already has), then the app-managed portable one.
 */
export function resolveOllamaBinary(): { path: string; managed: boolean } | null {
	for (const p of getOllamaExecutablePaths()) {
		if (fs.existsSync(p)) return { path: p, managed: false };
	}
	const managed = resolveManagedBinary();
	if (managed) return { path: managed, managed: true };
	return null;
}

/** Parse the configured base URL into an OLLAMA_HOST value (host:port). */
function ollamaHostFromUrl(baseUrl: string): string {
	try {
		const u = new URL(baseUrl);
		const port = u.port || "11434";
		// 127.0.0.1 is unambiguous on Windows (no IPv6/localhost surprises).
		const host = u.hostname === "localhost" ? "127.0.0.1" : u.hostname;
		return `${host}:${port}`;
	} catch {
		return "127.0.0.1:11434";
	}
}

/** True when an Ollama server answers on the given base URL. */
export async function isServerRunning(baseUrl: string): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (v: boolean) => {
			if (!settled) {
				settled = true;
				resolve(v);
			}
		};
		try {
			const req = net.request(`${baseUrl.replace(/\/$/, "")}/api/version`);
			req.on("response", (res) => {
				res.on("data", () => {
					/* drain the response so the socket can close */
				});
				res.on("end", () => done((res.statusCode ?? 0) > 0));
			});
			req.on("error", () => done(false));
			// Hard cap so a black-holed port can't hang the caller.
			setTimeout(() => done(false), 2500);
			req.end();
		} catch {
			done(false);
		}
	});
}

/**
 * Delete a pulled model from the running server to reclaim disk space
 * (Ollama API: DELETE /api/delete). Returns a typed result instead of throwing.
 */
export async function deleteModel(
	baseUrl: string,
	name: string,
): Promise<{ success: boolean; error?: string }> {
	const url = `${(baseUrl || "http://localhost:11434").replace(/\/$/, "")}/api/delete`;
	return new Promise((resolve) => {
		let settled = false;
		const done = (r: { success: boolean; error?: string }) => {
			if (!settled) {
				settled = true;
				resolve(r);
			}
		};
		try {
			const req = net.request({ method: "DELETE", url });
			req.setHeader("Content-Type", "application/json");
			req.on("response", (res) => {
				let body = "";
				res.on("data", (c: Buffer) => {
					body += c.toString();
				});
				res.on("end", () => {
					const status = res.statusCode ?? 0;
					if (status >= 200 && status < 300) done({ success: true });
					else
						done({
							success: false,
							error: `HTTP ${status}${body ? `: ${body}` : ""}`,
						});
				});
			});
			req.on("error", (err) => done({ success: false, error: String(err) }));
			req.write(JSON.stringify({ name }));
			req.end();
		} catch (err) {
			done({ success: false, error: String(err) });
		}
	});
}

/** Download a URL to a file, following redirects, reporting 0–1 progress. */
function downloadFile(
	url: string,
	dest: string,
	onProgress: (fraction: number) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = net.request(url); // Electron net follows redirects by default
		request.on("response", (response) => {
			const status = response.statusCode ?? 0;
			if (status >= 400) {
				reject(new Error(`HTTP ${status} en téléchargeant ${url}`));
				return;
			}
			const lenHeader = response.headers["content-length"];
			const total = Number(
				Array.isArray(lenHeader) ? lenHeader[0] : lenHeader ?? 0,
			);
			let received = 0;
			const file = fs.createWriteStream(dest);
			response.on("data", (chunk: Buffer) => {
				received += chunk.length;
				file.write(chunk);
				if (total > 0) onProgress(received / total);
			});
			response.on("end", () => file.end(() => resolve()));
			response.on("error", (err) => {
				file.destroy();
				reject(err);
			});
		});
		request.on("error", reject);
		request.end();
	});
}

/** Extract the downloaded archive (zip on Windows, tgz elsewhere). */
async function extractArchive(archivePath: string, destDir: string): Promise<void> {
	fs.mkdirSync(destDir, { recursive: true });
	if (archivePath.endsWith(".zip")) {
		await fs
			.createReadStream(archivePath)
			.pipe(unzipper.Extract({ path: destDir }))
			.promise();
	} else {
		// .tgz — system tar is always available on macOS/Linux.
		await execFileAsync("tar", ["-xzf", archivePath, "-C", destDir]);
	}
}

/**
 * Ensure a runnable ollama binary exists, downloading+extracting the portable
 * build when neither a system install nor a previous portable one is present.
 */
export async function ensureOllamaBinary(
	onProgress: (p: EnsureProgress) => void,
): Promise<{ path: string; managed: boolean }> {
	onProgress({
		phase: "resolving",
		percentage: -1,
		message: "Recherche d'Ollama…",
	});
	const existing = resolveOllamaBinary();
	if (existing) return existing;

	const asset = ollamaReleaseAsset();
	if (!asset) {
		throw new Error(
			`Plateforme non supportée pour l'installation automatique d'Ollama (${process.platform}/${process.arch}). Installez Ollama depuis ollama.com.`,
		);
	}

	fs.mkdirSync(managedDir(), { recursive: true });
	const archivePath = path.join(managedDir(), asset);
	const url = `${GITHUB_LATEST}/${asset}`;

	onProgress({
		phase: "downloading",
		percentage: 0,
		message: "Téléchargement d'Ollama…",
	});
	await downloadFile(url, archivePath, (f) =>
		onProgress({
			phase: "downloading",
			percentage: Math.round(f * 100),
			message: `Téléchargement d'Ollama… ${Math.round(f * 100)}%`,
		}),
	);

	onProgress({
		phase: "extracting",
		percentage: -1,
		message: "Extraction d'Ollama…",
	});
	// Re-extract cleanly so a partial previous attempt can't leave junk behind.
	fs.rmSync(extractedDir(), { recursive: true, force: true });
	await extractArchive(archivePath, extractedDir());
	try {
		fs.rmSync(archivePath, { force: true });
	} catch {
		/* keep going — the archive is just cache */
	}

	const binary = resolveManagedBinary();
	if (!binary) {
		throw new Error(
			"Ollama a été téléchargé mais le binaire est introuvable après extraction.",
		);
	}
	if (process.platform !== "win32") {
		try {
			fs.chmodSync(binary, 0o755);
		} catch {
			/* best effort */
		}
	}
	return { path: binary, managed: true };
}

/**
 * Spawn `ollama serve` detached so it outlives this call (and the app), bound to
 * the configured host/port. For the managed binary we also pin OLLAMA_MODELS to
 * the managed dir so pulls/serving stay self-contained.
 */
function startServer(
	binaryPath: string,
	baseUrl: string,
	managed: boolean,
): void {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		OLLAMA_HOST: ollamaHostFromUrl(baseUrl),
		// Ollama defaults served models to a 4096-token context, far too small for
		// an agent prompt (system + tools + history) — requests fail with
		// "exceeds the available context size (4096 tokens)". Raise the floor to a
		// sane default; honour an explicit operator override when present.
		OLLAMA_CONTEXT_LENGTH: process.env.OLLAMA_CONTEXT_LENGTH || "8192",
	};
	if (managed) {
		fs.mkdirSync(managedModelsDir(), { recursive: true });
		env.OLLAMA_MODELS = managedModelsDir();
	}
	const child = spawn(binaryPath, ["serve"], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
		env,
	});
	child.unref();
}

/**
 * Stop the server listening on the given port (best-effort, cross-OS). Only call
 * this for a server WE manage — never for a user's system Ollama.
 */
async function stopManagedServer(baseUrl: string): Promise<void> {
	let port = "11434";
	try {
		port = new URL(baseUrl).port || "11434";
	} catch {
		/* keep default */
	}
	try {
		if (process.platform === "win32") {
			await execFileAsync("powershell", [
				"-NoProfile",
				"-Command",
				`Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
					"Select-Object -ExpandProperty OwningProcess | " +
					"ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }",
			]);
		} else {
			const { stdout } = await execFileAsync("sh", [
				"-c",
				`lsof -ti tcp:${port} -sTCP:LISTEN || true`,
			]);
			for (const pid of stdout.split(/\s+/).filter(Boolean)) {
				try {
					process.kill(Number(pid), "SIGTERM");
				} catch {
					/* already gone */
				}
			}
		}
		// Give the OS a moment to release the port before we rebind.
		await new Promise((r) => setTimeout(r, 1000));
	} catch {
		/* best effort — if we can't stop it, startServer will surface the error */
	}
}

/**
 * Top-level entry point: make sure an Ollama server is reachable on `baseUrl`,
 * installing the portable build and starting the daemon as needed.
 *
 * @param opts.forceRestart When true, a server we manage is restarted so it
 *   picks up the current OLLAMA_CONTEXT_LENGTH (an already-running daemon keeps
 *   its old, possibly too-small, context). A system Ollama is never restarted.
 */
export async function ensureOllamaReady(
	baseUrl: string,
	onProgress: (p: EnsureProgress) => void,
	opts: { forceRestart?: boolean } = {},
): Promise<EnsureResult> {
	const url = baseUrl?.trim() || "http://localhost:11434";
	try {
		// The context the managed server should run with, and a marker recording
		// what it was last (re)started with. A managed daemon left over from a
		// previous launch keeps its old (often 4096) context, so when the marker
		// is stale we restart it ONCE — automatically, even from a task launch —
		// instead of forcing a slow restart on every call.
		const desiredCtx = process.env.OLLAMA_CONTEXT_LENGTH || "8192";
		const markerPath = path.join(managedDir(), ".server-ctx");
		const readMarker = (): string => {
			try {
				return fs.readFileSync(markerPath, "utf-8").trim();
			} catch {
				return "";
			}
		};
		const writeMarker = (): void => {
			try {
				fs.mkdirSync(managedDir(), { recursive: true });
				fs.writeFileSync(markerPath, desiredCtx);
			} catch {
				/* best effort */
			}
		};

		const alreadyRunning = await isServerRunning(url);
		// Resolve without downloading, so we know whether a running server is ours.
		const managedRunning = resolveOllamaBinary()?.managed === true;
		const ctxStale = managedRunning && readMarker() !== desiredCtx;

		if (alreadyRunning && !opts.forceRestart && !ctxStale) {
			onProgress({ phase: "ready", percentage: 100, message: "Ollama est prêt." });
			return { success: true, running: true, url, managed: managedRunning };
		}

		const { path: binary, managed } = await ensureOllamaBinary(onProgress);

		// Restart OUR managed server to apply the context; never touch a system one.
		if (alreadyRunning && (opts.forceRestart || ctxStale)) {
			if (!managed) {
				onProgress({
					phase: "ready",
					percentage: 100,
					message: "Ollama (système) est prêt.",
				});
				return { success: true, running: true, url, managed: false };
			}
			onProgress({
				phase: "starting",
				percentage: -1,
				message: "Redémarrage du serveur Ollama (contexte élargi)…",
			});
			await stopManagedServer(url);
		}

		onProgress({
			phase: "starting",
			percentage: -1,
			message: "Démarrage du serveur Ollama…",
		});
		startServer(binary, url, managed);

		// Poll until it answers (cold start + model index can take a few seconds).
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 800));
			if (await isServerRunning(url)) {
				if (managed) writeMarker();
				onProgress({
					phase: "ready",
					percentage: 100,
					message: "Ollama est prêt.",
				});
				return { success: true, running: true, url, managed, binaryPath: binary };
			}
		}
		return {
			success: false,
			running: false,
			url,
			managed,
			binaryPath: binary,
			error: `Ollama a démarré mais n'a pas répondu sur ${url} dans le délai imparti.`,
		};
	} catch (error) {
		return {
			success: false,
			running: false,
			url,
			managed: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Directory helpers exposed for diagnostics/tests. */
export const _internal = {
	managedDir,
	managedModelsDir,
	extractedDir,
	ollamaHostFromUrl,
	homedir: os.homedir,
};
