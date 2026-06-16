/**
 * SuccessRing — a compact circular gauge for a 0-1 success probability.
 *
 * Pure SVG (no dependency). Colour shifts red → amber → emerald as the
 * probability climbs, so a glance conveys risk without reading the number.
 */

export interface SuccessRingProps {
	/** Probability in [0, 1]. */
	readonly value: number;
	/** Diameter in px. */
	readonly size?: number;
	/** Stroke width in px. */
	readonly stroke?: number;
	/** Show the percentage in the centre. */
	readonly showLabel?: boolean;
	readonly className?: string;
}

function ringColor(value: number): string {
	if (value >= 0.85) return "#10b981"; // emerald-500
	if (value >= 0.7) return "#22c55e"; // green-500
	if (value >= 0.55) return "#f59e0b"; // amber-500
	if (value >= 0.4) return "#f97316"; // orange-500
	return "#ef4444"; // red-500
}

export function SuccessRing({
	value,
	size = 40,
	stroke = 4,
	showLabel = true,
	className,
}: SuccessRingProps) {
	const clamped = Math.max(0, Math.min(1, value));
	const radius = (size - stroke) / 2;
	const circumference = 2 * Math.PI * radius;
	const offset = circumference * (1 - clamped);
	const color = ringColor(clamped);
	const center = size / 2;

	return (
		<div
			className={className}
			style={{ width: size, height: size, position: "relative" }}
		>
			<svg
				width={size}
				height={size}
				viewBox={`0 0 ${size} ${size}`}
				role="img"
				aria-label={`${Math.round(clamped * 100)}% success`}
			>
				<circle
					cx={center}
					cy={center}
					r={radius}
					fill="none"
					stroke="currentColor"
					strokeWidth={stroke}
					className="text-muted-foreground/20"
				/>
				<circle
					cx={center}
					cy={center}
					r={radius}
					fill="none"
					stroke={color}
					strokeWidth={stroke}
					strokeLinecap="round"
					strokeDasharray={circumference}
					strokeDashoffset={offset}
					transform={`rotate(-90 ${center} ${center})`}
					style={{ transition: "stroke-dashoffset 0.4s ease, stroke 0.4s ease" }}
				/>
			</svg>
			{showLabel && (
				<span
					className="absolute inset-0 flex items-center justify-center font-semibold tabular-nums"
					style={{ fontSize: size * 0.28, color }}
				>
					{Math.round(clamped * 100)}
				</span>
			)}
		</div>
	);
}
