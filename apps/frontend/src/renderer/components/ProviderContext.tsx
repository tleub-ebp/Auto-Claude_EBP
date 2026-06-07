import type React from "react";
import {
	createContext,
	type ReactNode,
	useContext,
	useMemo,
	useState,
} from "react";

interface ProviderContextType {
	selectedProvider: string;
	setSelectedProvider: (provider: string) => void;
}

export const ProviderContext = createContext<ProviderContextType | undefined>(
	undefined,
);

interface ProviderContextProviderProps {
	children: ReactNode;
}

export const ProviderContextProvider: React.FC<
	ProviderContextProviderProps
> = ({ children }) => {
	// Initialize from localStorage to avoid the empty-provider window on mount.
	// ProviderSelector persists the selection to localStorage on change,
	// so this gives UsageIndicator a valid provider immediately instead of ''
	// which would cause a brief "N/D" flash before the context is populated.
	const [selectedProvider, setSelectedProvider] = useState<string>(() => {
		try {
			return localStorage.getItem("selectedProvider") || "";
		} catch {
			return "";
		}
	});

	const contextValue = useMemo(
		() => ({
			selectedProvider,
			setSelectedProvider,
		}),
		[selectedProvider],
	);

	return (
		<ProviderContext.Provider value={contextValue}>
			{children}
		</ProviderContext.Provider>
	);
};

export const useProviderContext = () => {
	const context = useContext(ProviderContext);
	if (!context) {
		throw new Error(
			"useProviderContext must be used within a ProviderContextProvider",
		);
	}
	return context;
};
