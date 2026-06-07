/**
 * Velocity Tracker Module
 * Tracks consumption rate of token usage per profile to enable predictive switching.
 *
 * Stores historical usage snapshots and calculates:
 * - Consumption velocity (% per minute) for session and weekly usage
 * - Estimated time-to-limit predictions
 *
 * This data feeds into the profile scorer for smarter switching decisions.
 */

import type { TimeToLimitData, VelocityData } from "./profile-scorer";

// ============================================
// Types
// ============================================

interface UsageDataPoint {
	sessionPercent: number;
	weeklyPercent: number;
	timestamp: number; // Date.now()
}

// ============================================
// Constants
// ============================================

/** Maximum number of data points to retain per profile */
const MAX_DATA_POINTS = 10;

/** Maximum age of data points before they are pruned (30 minutes) */
const MAX_DATA_AGE_MS = 30 * 60 * 1000;

/** Minimum elapsed time between two data points to compute velocity (30 seconds) */
const MIN_ELAPSED_MS = 30 * 1000;

// ============================================
// VelocityTracker
// ============================================

/**
 * Singleton tracker for consumption velocity per profile.
 * Records usage data points over time and calculates how fast
 * each profile is consuming its quota.
 */
class VelocityTracker {
	private static instance: VelocityTracker;

	/** Historical data points per profile (keyed by profileId) */
	private readonly dataPoints: Map<string, UsageDataPoint[]> = new Map();

	private constructor() {}

	static getInstance(): VelocityTracker {
		if (!VelocityTracker.instance) {
			VelocityTracker.instance = new VelocityTracker();
		}
		return VelocityTracker.instance;
	}

	/**
	 * Record a new usage data point for a profile.
	 * Automatically prunes old entries beyond MAX_DATA_POINTS and MAX_DATA_AGE_MS.
	 */
	recordDataPoint(
		profileId: string,
		sessionPercent: number,
		weeklyPercent: number,
	): void {
		if (
			!Number.isFinite(sessionPercent) ||
			!Number.isFinite(weeklyPercent) ||
			sessionPercent < 0 ||
			sessionPercent > 100 ||
			weeklyPercent < 0 ||
			weeklyPercent > 100
		) {
			return;
		}
		const now = Date.now();
		const point: UsageDataPoint = {
			sessionPercent,
			weeklyPercent,
			timestamp: now,
		};

		let points = this.dataPoints.get(profileId);
		if (!points) {
			points = [];
			this.dataPoints.set(profileId, points);
		}

		points.push(point);

		// Prune old data points
		const cutoff = now - MAX_DATA_AGE_MS;
		const pruned = points.filter((p) => p.timestamp >= cutoff);

		// Keep only the most recent MAX_DATA_POINTS
		if (pruned.length > MAX_DATA_POINTS) {
			this.dataPoints.set(profileId, pruned.slice(-MAX_DATA_POINTS));
		} else {
			this.dataPoints.set(profileId, pruned);
		}
	}

	/**
	 * Get the consumption velocity for a profile.
	 *
	 * Calculates the rate of change in usage (% per minute) using a weighted
	 * average of recent deltas. More recent deltas are weighted higher.
	 *
	 * @returns VelocityData with velocities and confidence level
	 */
	getVelocity(profileId: string): VelocityData {
		const points = this.dataPoints.get(profileId);

		if (!points || points.length < 2) {
			return {
				sessionVelocity: 0,
				weeklyVelocity: 0,
				sampleCount: points?.length ?? 0,
				confidence: "low",
			};
		}

		// Calculate weighted average of deltas (more recent = higher weight)
		let sessionVelocitySum = 0;
		let weeklyVelocitySum = 0;
		let weightSum = 0;
		let validDeltas = 0;

		for (let i = 1; i < points.length; i++) {
			const prev = points[i - 1];
			const curr = points[i];
			const elapsedMs = curr.timestamp - prev.timestamp;

			// Skip deltas with too little time elapsed (avoid division by near-zero)
			if (elapsedMs < MIN_ELAPSED_MS) {
				continue;
			}

			const elapsedMinutes = elapsedMs / 60000;
			const sessionDelta =
				(curr.sessionPercent - prev.sessionPercent) / elapsedMinutes;
			const weeklyDelta =
				(curr.weeklyPercent - prev.weeklyPercent) / elapsedMinutes;

			// Weight: more recent deltas get higher weight (linear increase)
			const weight = i;
			sessionVelocitySum += sessionDelta * weight;
			weeklyVelocitySum += weeklyDelta * weight;
			weightSum += weight;
			validDeltas++;
		}

		if (weightSum === 0 || validDeltas === 0) {
			return {
				sessionVelocity: 0,
				weeklyVelocity: 0,
				sampleCount: points.length,
				confidence: "low",
			};
		}

		const sessionVelocity = sessionVelocitySum / weightSum;
		const weeklyVelocity = weeklyVelocitySum / weightSum;

		// Determine confidence based on number of valid deltas
		let confidence: VelocityData["confidence"];
		if (validDeltas >= 5) {
			confidence = "high";
		} else if (validDeltas >= 2) {
			confidence = "medium";
		} else {
			confidence = "low";
		}

		return {
			sessionVelocity: Math.round(sessionVelocity * 1000) / 1000,
			weeklyVelocity: Math.round(weeklyVelocity * 1000) / 1000,
			sampleCount: points.length,
			confidence,
		};
	}

	/**
	 * Estimate how many minutes until a profile hits the given thresholds,
	 * based on current usage and velocity.
	 *
	 * @param profileId - Profile to check
	 * @param sessionThreshold - Session usage threshold (e.g., 95)
	 * @param weeklyThreshold - Weekly usage threshold (e.g., 99)
	 * @returns Time-to-limit prediction (null means not approaching limit)
	 */
	getEstimatedTimeToLimit(
		profileId: string,
		sessionThreshold: number,
		weeklyThreshold: number,
	): TimeToLimitData {
		const points = this.dataPoints.get(profileId);
		const velocity = this.getVelocity(profileId);

		// Need at least current usage to estimate
		if (!points || points.length === 0) {
			return { sessionMinutesRemaining: null, weeklyMinutesRemaining: null };
		}

		// biome-ignore lint/style/noNonNullAssertion: safely accessed after length check
		const latest = points.at(-1)!;

		// Session time-to-limit
		let sessionMinutesRemaining: number | null = null;
		if (
			velocity.sessionVelocity > 0 &&
			latest.sessionPercent < sessionThreshold
		) {
			const remainingPercent = sessionThreshold - latest.sessionPercent;
			sessionMinutesRemaining = remainingPercent / velocity.sessionVelocity;
		}

		// Weekly time-to-limit
		let weeklyMinutesRemaining: number | null = null;
		if (velocity.weeklyVelocity > 0 && latest.weeklyPercent < weeklyThreshold) {
			const remainingPercent = weeklyThreshold - latest.weeklyPercent;
			weeklyMinutesRemaining = remainingPercent / velocity.weeklyVelocity;
		}

		return {
			sessionMinutesRemaining: sessionMinutesRemaining
				? Math.round(sessionMinutesRemaining * 10) / 10
				: null,
			weeklyMinutesRemaining: weeklyMinutesRemaining
				? Math.round(weeklyMinutesRemaining * 10) / 10
				: null,
		};
	}

	/**
	 * Clear all data for a specific profile.
	 * Called on auth failure, manual reset, or profile removal.
	 */
	clearProfile(profileId: string): void {
		this.dataPoints.delete(profileId);
	}

	/**
	 * Clear all tracked data (e.g., on provider switch).
	 */
	clear(): void {
		this.dataPoints.clear();
	}
}

// ============================================
// Exports
// ============================================

/**
 * Get the singleton VelocityTracker instance.
 */
export function getVelocityTracker(): VelocityTracker {
	return VelocityTracker.getInstance();
}

/**
 * Reset the tracker (for testing).
 */
export function resetVelocityTracker(): void {
	VelocityTracker.getInstance().clear();
}
