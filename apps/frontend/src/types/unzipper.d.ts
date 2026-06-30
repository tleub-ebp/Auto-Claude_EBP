/**
 * Minimal typings for the subset of `unzipper` we use (archive extraction in
 * the portable Ollama manager). The package ships no bundled declarations.
 */
declare module "unzipper" {
	import type { Writable } from "node:stream";

	interface ExtractStream extends Writable {
		/** Resolves once the archive has been fully written to disk. */
		promise(): Promise<void>;
	}

	export function Extract(opts: { path: string }): ExtractStream;
}
