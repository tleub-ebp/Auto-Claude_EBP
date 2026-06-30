/**
 * Helpers for turning a failed PR-creation subprocess into a short, log-safe
 * message suitable for a UI toast.
 */

/**
 * Build a human-readable error from a rejected `execFileSync` PR-creation call.
 *
 * `execFileSync` rejects with a default message of `Command failed: <full
 * command line>`. When a task description carries an inline base64 image
 * (typical of Azure DevOps imports), that command line is kilobytes of HTML —
 * which used to spill, raw and unreadable, straight into the UI toast.
 *
 * We prefer the script's own structured output: the JSON it prints on stdout,
 * then the last meaningful line of stderr (a Python traceback's
 * `ExceptionType: message`), and never the raw command line itself.
 */
export function extractPrCreationError(prError: unknown): string {
	const err = (prError ?? {}) as {
		stdout?: string | Buffer;
		stderr?: string | Buffer;
		code?: string | number;
	};
	const asText = (v: string | Buffer | undefined): string =>
		typeof v === "string" ? v : v ? v.toString("utf-8") : "";

	// 1. The Python script prints a JSON result. If it exited non-zero but still
	//    emitted that payload, surface its structured `error` field.
	const stdout = asText(err.stdout).trim();
	if (stdout) {
		try {
			const parsed = JSON.parse(stdout);
			if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
				return `Failed to create PR: ${parsed.error.trim().slice(0, 500)}`;
			}
		} catch {
			// stdout was not JSON (e.g. an interpreter crash) — fall through.
		}
	}

	// 2. Otherwise use the final non-empty line of stderr.
	const stderr = asText(err.stderr).trim();
	if (stderr) {
		const lines = stderr.split(/\r?\n/).filter((l) => l.trim().length > 0);
		const last = lines[lines.length - 1]?.trim();
		if (last) return `Failed to create PR: ${last.slice(0, 500)}`;
	}

	// 3. Timeouts surface a code but no useful output.
	if (err.code === "ETIMEDOUT") {
		return "Failed to create PR: the operation timed out.";
	}

	return "Failed to create PR. Check the application logs for details.";
}
