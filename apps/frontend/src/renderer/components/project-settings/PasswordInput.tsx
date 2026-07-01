import { Eye, EyeOff } from "lucide-react";
import { forwardRef, useState } from "react";
import { Input } from "../ui/input";

interface PasswordInputProps
	extends Omit<
		React.InputHTMLAttributes<HTMLInputElement>,
		"value" | "onChange" | "type"
	> {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	className?: string;
}

/**
 * Password field with a show/hide toggle.
 *
 * Forwards `ref` and spreads extra props (e.g. `data-guide`) onto the real
 * `<input>` so the guided tour can anchor a spotlight on it and call `.focus()`.
 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
	function PasswordInput({ value, onChange, placeholder, className, ...rest }, ref) {
		const [showPassword, setShowPassword] = useState(false);

		return (
			<div className="relative">
				<Input
					ref={ref}
					type={showPassword ? "text" : "password"}
					placeholder={placeholder}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					className={className || "pr-10"}
					{...rest}
				/>
				<button
					type="button"
					onClick={() => setShowPassword(!showPassword)}
					className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
				>
					{showPassword ? (
						<EyeOff className="h-4 w-4" />
					) : (
						<Eye className="h-4 w-4" />
					)}
				</button>
			</div>
		);
	},
);
