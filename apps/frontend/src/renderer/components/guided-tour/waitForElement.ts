/**
 * Resolve a DOM element matching `selector`, polling on animation frames until
 * it appears or `timeoutMs` elapses. Settings sections render synchronously
 * after a state change, but the change itself is async (React commit), so a
 * short bounded poll is the simplest robust way to wait for the target.
 *
 * Returns the element, or null on timeout. Honours an AbortSignal so a tour
 * step that is cancelled mid-wait stops polling immediately.
 */
export function waitForElement(
	selector: string,
	timeoutMs = 1500,
	signal?: AbortSignal,
): Promise<HTMLElement | null> {
	return new Promise((resolve) => {
		const existing = document.querySelector<HTMLElement>(selector);
		if (existing) {
			resolve(existing);
			return;
		}

		const start = performance.now();
		let rafId = 0;

		const onAbort = () => {
			cancelAnimationFrame(rafId);
			resolve(null);
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		const tick = () => {
			if (signal?.aborted) return;
			const el = document.querySelector<HTMLElement>(selector);
			if (el) {
				signal?.removeEventListener("abort", onAbort);
				resolve(el);
				return;
			}
			if (performance.now() - start >= timeoutMs) {
				signal?.removeEventListener("abort", onAbort);
				resolve(null);
				return;
			}
			rafId = requestAnimationFrame(tick);
		};
		rafId = requestAnimationFrame(tick);
	});
}
