/**
 * CanvasPanel
 * Interactive visual programming canvas (no-code/low-code).
 * - Flowchart → Code
 * - Architecture diagrams → Implementation
 * - Mockup → Frontend code
 * - Reverse: Code → Visual representation
 */

import {
	ArrowLeftRight,
	FileJson,
	FolderOpen,
	GitBranch,
	Layers,
	LayoutTemplate,
	Loader2,
	Plus,
	Save,
	Sparkles,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactFlow, {
	addEdge,
	Background,
	type Connection,
	Controls,
	type Edge,
	MiniMap,
	useEdgesState,
	useNodesState,
} from "reactflow";
import { Button } from "../ui/button";
import "reactflow/dist/style.css";
import type {
	CodeToVisualResult,
	GenerateCodeResult,
} from "@preload/api/modules/visual-programming-api";
import { saveAs } from "file-saver";
import { toast } from "@/hooks/use-toast";
import type { DiagramType } from "../../stores/visual-to-code-store";
import { useVisualToCodeStore } from "../../stores/visual-to-code-store";
import { FileTree } from "../FileTree";
import { edgeTypes, nodeTypes } from "../reactflowTypes";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select";

export type { DiagramType } from "../../stores/visual-to-code-store";

export const CanvasPanel: React.FC = () => {
	const { t } = useTranslation("visualProgramming");
	const {
		canvasNodes: storedNodes,
		canvasEdges: storedEdges,
		canvasDiagramType: storedDiagramType,
		setCanvasNodes,
		setCanvasEdges,
		setCanvasDiagramType,
	} = useVisualToCodeStore();

	const [nodes, setNodes, onNodesChange] = useNodesState(
		storedNodes.length > 0
			? storedNodes
			: [
					{
						id: "1",
						position: { x: 250, y: 5 },
						data: { label: t("newFlowchart") },
						type: "editable",
					},
				],
	);
	const [edges, setEdges, onEdgesChange] = useEdgesState(storedEdges);
	const [diagramType, setDiagramType] =
		useState<DiagramType>(storedDiagramType);
	const loadInputRef = useRef<HTMLInputElement>(null);
	const [showFrameworkModal, setShowFrameworkModal] = useState(false);
	const [pendingNode, setPendingNode] = useState<{
		id: string;
		type: string;
		position: { x: number; y: number };
	} | null>(null);
	const [selectedFramework, setSelectedFramework] = useState<string>("");
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	const reactFlowRef = useRef<any>(null);
	const [isJsonSaved, setIsJsonSaved] = useState(true);
	const [selectedFolder, setSelectedFolder] = useState<string>("");
	const [showSaveAsDialog, setShowSaveAsDialog] = useState(false);
	const [saveAsFileName, setSaveAsFileName] = useState("");

	// Frameworks par type
	const FRAMEWORKS: Record<string, { value: string; labelKey: string }[]> = {
		frontend: [
			{ value: "React", labelKey: "React" },
			{ value: "Angular", labelKey: "Angular" },
			{ value: "Vue", labelKey: "Vue" },
			{ value: "Svelte", labelKey: "Svelte" },
		],
		backend: [
			{ value: "NodeJs", labelKey: "NodeJs" },
			{ value: "Python", labelKey: "Python" },
			{ value: "DotNet", labelKey: ".Net" },
			{ value: "Django", labelKey: "Django" },
			{ value: "Flask", labelKey: "Flask" },
			{ value: "Spring", labelKey: "Spring" },
		],
		database: [
			{ value: "Postgres", labelKey: "Postgres" },
			{ value: "MySql", labelKey: "MySql" },
			{ value: "MongoDb", labelKey: "MongoDb" },
			{ value: "Sqlite", labelKey: "Sqlite" },
		],
		api: [
			{ value: "Rest", labelKey: "Rest" },
			{ value: "Graphql", labelKey: "Graphql" },
			{ value: "Grpc", labelKey: "Grpc" },
		],
	};

	// ── AI generation state ─────────────────────────────────────────────
	const [isAiRunning, setIsAiRunning] = useState(false);
	const [aiStatus, setAiStatus] = useState("");
	const [showCodeResult, setShowCodeResult] = useState(false);
	const [codeResult, setCodeResult] = useState<GenerateCodeResult | null>(null);
	const [selectedCodeFile, setSelectedCodeFile] = useState(0);
	const codeToVisualInputRef = useRef<HTMLInputElement>(null);

	// Extracted event handlers to reduce nesting
	const handleVisualProgrammingStatus = useCallback((msg: string) => {
		setAiStatus(msg);
	}, []);

	const handleVisualProgrammingError = useCallback(
		(err: string) => {
			setIsAiRunning(false);
			setAiStatus("");
			toast({
				title: t("aiError", "Erreur IA"),
				description: err,
				variant: "destructive",
			});
		},
		[t],
	);

	const handleVisualProgrammingComplete = useCallback(
		(payload: {
			action: string;
			data: GenerateCodeResult | CodeToVisualResult;
		}) => {
			setIsAiRunning(false);
			setAiStatus("");
			if (payload.action === "generate-code") {
				const result = payload.data as GenerateCodeResult;
				setCodeResult(result);
				setSelectedCodeFile(0);
				setShowCodeResult(true);
				toast({
					title: t("codeGenerated", "Code généré !"),
					description: result.summary,
				});
			} else if (payload.action === "code-to-visual") {
				const result = payload.data as CodeToVisualResult;
				const newNodes = result.nodes.map((n, i) => ({
					id: n.id || `imported-${i}`,
					position: { x: 120 + (i % 4) * 220, y: 80 + Math.floor(i / 4) * 120 },
					data: {
						label: n.label,
						type: n.type,
						framework: n.framework,
					},
					type: "editable" as const,
				}));
				const newEdges = result.edges.map((e, i) => ({
					id: `imported-edge-${i}`,
					source: e.source,
					target: e.target,
					data: { label: e.label || "" },
				}));
				setNodes(newNodes);
				setEdges(newEdges);
				setIsJsonSaved(false);
				toast({
					title: t("codeToVisualDone", "Diagramme généré !"),
					description: result.summary,
				});
			}
		},
		[t, setEdges, setNodes],
	);

	// Subscribe to backend events once on mount
	useEffect(() => {
		const offStatus = globalThis.electronAPI?.onVisualProgrammingStatus?.(
			handleVisualProgrammingStatus,
		);
		const offError = globalThis.electronAPI?.onVisualProgrammingError?.(
			handleVisualProgrammingError,
		);
		const offComplete = globalThis.electronAPI?.onVisualProgrammingComplete?.(
			handleVisualProgrammingComplete,
		);
		return () => {
			offStatus?.();
			offError?.();
			offComplete?.();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		handleVisualProgrammingComplete,
		handleVisualProgrammingError,
		handleVisualProgrammingStatus,
	]);

	const handleGenerateCode = async () => {
		if (!globalThis.electronAPI?.runVisualProgramming) {
			toast({
				title: t("aiNotAvailable", "IA non disponible"),
				description: "Electron API manquante",
				variant: "destructive",
			});
			return;
		}
		if (nodes.length === 0) {
			toast({
				title: t("emptyDiagram", "Diagramme vide"),
				description: t(
					"addBlocksFirst",
					"Ajoutez des blocs avant de générer du code.",
				),
				variant: "destructive",
			});
			return;
		}
		setIsAiRunning(true);
		setAiStatus(t("starting", "Démarrage…"));
		const diagramJson = JSON.stringify({ nodes, edges, diagramType });
		await globalThis.electronAPI.runVisualProgramming({
			action: "generate-code",
			diagramJson,
			framework: "",
		});
	};

	const handleCodeToVisual = async (
		event: React.ChangeEvent<HTMLInputElement>,
	) => {
		const file = event.target.files?.[0];
		if (!file) return;
		event.target.value = "";
		if (!globalThis.electronAPI?.runVisualProgramming) {
			toast({
				title: t("aiNotAvailable", "IA non disponible"),
				description: "Electron API manquante",
				variant: "destructive",
			});
			return;
		}
		setIsAiRunning(true);
		setAiStatus(t("starting", "Démarrage…"));
		await globalThis.electronAPI.runVisualProgramming({
			action: "code-to-visual",
			// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
			filePath: (file as any).path || file.name,
		});
	};

	const onConnect = (params: Edge | Connection) =>
		setEdges((eds) => addEdge(params, eds));

	const handleAddNode = () => {
		const newId = (nodes.length + 1).toString();
		setNodes((nds) => [
			...nds,
			{
				id: newId,
				position: { x: 100 + 50 * nodes.length, y: 100 + 30 * nodes.length },
				data: {
					label: t("newBlock", "Nouveau bloc"),
					onRename: handleRenameNode,
				},
				type: "editable",
			},
		]);
	};

	const handleExportCode = () => {
		const exportData = {
			nodes,
			edges,
			diagramType,
			exportedAt: new Date().toISOString(),
		};
		const now = new Date();
		const pad = (n: number, l: number = 2) => n.toString().padStart(l, "0");
		const fileName = `${diagramType}-export-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}.json`;
		saveAs(
			new Blob([JSON.stringify(exportData, null, 2)], {
				type: "application/json",
			}),
			fileName,
		);
	};

	const getDefaultFileName = () => {
		const now = new Date();
		const pad = (n: number, l: number = 2) => n.toString().padStart(l, "0");
		return `${getDiagramPrefix(diagramType)}-export-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}.json`;
	};

	const confirmSaveAs = async () => {
		const exportData = {
			nodes,
			edges,
			diagramType,
			exportedAt: new Date().toISOString(),
		};
		const fileName = saveAsFileName;
		const folderPath = selectedFolder;
		try {
			if (globalThis.electronAPI?.saveJsonFile) {
				const result = await globalThis.electronAPI.saveJsonFile(
					folderPath,
					fileName,
					exportData,
				);
				if (result?.success) {
					setIsJsonSaved(true);
					setShowSaveAsDialog(false);
					toast({
						title: t("saveSuccess", "Sauvegarde réussie"),
						description: `${t("fileSavedIn", "Fichier sauvegardé dans")} ${folderPath}`,
					});
				} else {
					toast({
						title: t("saveError", "Erreur lors de la sauvegarde"),
						description: result?.error || "Erreur inconnue",
					});
				}
			} else {
				toast({
					title: t("saveError", "Electron API non disponible"),
					description: "Impossible de sauvegarder le fichier côté client.",
				});
			}
			// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		} catch (e: any) {
			toast({
				title: t("saveError", "Erreur lors de la sauvegarde"),
				description: e.message,
			});
		}
	};

	const cancelSaveAs = () => {
		setShowSaveAsDialog(false);
		setNextDiagramType(null);
	};

	const handleLoad = async (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		if (!file) return;
		try {
			const content = await file.text();
			const data = JSON.parse(content);
			setNodes(data.nodes || []);
			setEdges(data.edges || []);
			setDiagramType(data.diagramType || "flowchart");
		} catch {
			toast({
				title: t("loadErrorTitle", "Erreur de chargement"),
				description: t("loadErrorDesc", "Le fichier est invalide ou corrompu."),
				variant: "destructive",
			});
		}
	};

	const handleDrop = (event: React.DragEvent) => {
		event.preventDefault();
		const type = event.dataTransfer.getData("application/block-type");
		if (!type) return;
		const reactFlowInstance = reactFlowRef.current;
		const bounds = event.currentTarget.getBoundingClientRect();
		const mouseX = event.clientX - bounds.left;
		const mouseY = event.clientY - bounds.top;
		let position = { x: mouseX, y: mouseY };
		if (reactFlowInstance?.project) {
			position = reactFlowInstance.project({ x: mouseX, y: mouseY });
		}
		if (FRAMEWORKS[type]) {
			const newId = (nodes.length + 1).toString();
			setPendingNode({ id: newId, type, position });
			setShowFrameworkModal(true);
		} else {
			const newId = (nodes.length + 1).toString();
			setNodes((nds) => [
				...nds,
				{
					id: newId,
					position,
					data: {
						label: type.charAt(0).toUpperCase() + type.slice(1),
						type,
						onRename: handleRenameNode,
					},
					type: "editable",
				},
			]);
		}
	};

	const handleDragOver = (event: React.DragEvent) => {
		event.preventDefault();
	};

	const handleFrameworkSelect = (framework: string) => {
		if (!pendingNode) return;

		const pascalType =
			pendingNode.type.charAt(0).toUpperCase() + pendingNode.type.slice(1);
		let label = `${framework} (${pascalType})`;
		if (pendingNode.type === "custom") {
			const customName = globalThis.prompt(
				t("customBlockPrompt", "Nom du bloc personnalisé?"),
			);
			if (customName) label = customName;
		}
		setNodes((nds) => [
			...nds,
			{
				id: pendingNode.id,
				position: pendingNode.position,
				data: {
					label,
					type: pendingNode.type,
					framework,
					onRename: handleRenameNode,
				},
				type: "editable",
			},
		]);
		setShowFrameworkModal(false);
		setPendingNode(null);
		setSelectedFramework("");
	};

	const handleRenameNode = (id: string, newLabel: string) => {
		setNodes((nds) =>
			nds.map((n) =>
				n.id === id
					? {
							...n,
							data: { ...n.data, label: newLabel, onRename: handleRenameNode },
						}
					: n,
			),
		);
	};

	const _handleEdgeLabelChange = (id: string, newLabel: string) => {
		setEdges((eds) =>
			eds.map((e) =>
				e.id === id
					? {
							...e,
							data: { ...e.data, label: newLabel },
							onEdgeLabelChange: _handleEdgeLabelChange,
						}
					: e,
			),
		);
	};

	const [nextDiagramType, setNextDiagramType] = useState<DiagramType | null>(
		null,
	);

	const requestDiagramChange = (type: DiagramType) => {
		setNextDiagramType(type);
		setShowSaveAsDialog(true);
	};

	const handleNewDiagram = (type: DiagramType) => {
		if (!isJsonSaved) {
			setNextDiagramType(type);
			setShowSaveAsDialog(true);
			return;
		}
		setDiagramType(type);
		setNodes([
			{
				id: "1",
				position: { x: 250, y: 5 },
				data: { label: getNodeLabel ? getNodeLabel(type) : "" },
				type: "editable",
				selected: false,
			},
		]);
		setEdges([]);
		setShowFrameworkModal(false);
		setPendingNode(null);
		setSelectedFramework("");
		setNextDiagramType(null);
		setIsJsonSaved(false);
	};

	const getNodeLabel = (type: DiagramType) => {
		if (type === "flowchart") return t("newFlowchart");
		if (type === "architecture") return t("newArchitectureDiagram");
		if (type === "mockup") return t("newMockup");
		return "";
	};

	const getDiagramPrefix = (type: string) => {
		if (type === "architecture") return "architectural";
		if (type === "flowchart") return "organigramme";
		if (type === "mockup") return "mockup";
		return "diagram";
	};

	const reactFlowProps = {
		multiSelectionKeyCode: ["Shift", "Meta", "Control"],
	};

	// Extracted keyboard handler to reduce nesting
	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Delete" || e.key === "Backspace") {
			deleteSelectedElements();
		}
	};

	const deleteSelectedElements = () => {
		setNodes((nds) => nds.filter((n) => !n.selected));
		setEdges((eds) => eds.filter((e) => !e.selected));
	};

	React.useEffect(() => {
		globalThis.addEventListener("keydown", handleKeyDown);
		return () => globalThis.removeEventListener("keydown", handleKeyDown);
		// biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency omission
	}, [handleKeyDown]);

	React.useEffect(() => {
		if (!showSaveAsDialog && nextDiagramType !== null) {
			handleNewDiagram(nextDiagramType);
			setNextDiagramType(null);
		}
		// biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency omission
	}, [showSaveAsDialog, nextDiagramType, handleNewDiagram]);

	const handleSaveAs = () => {
		setSaveAsFileName(getDefaultFileName());
		setShowSaveAsDialog(true);
	};

	// Sync canvas state to store so it survives page/tab navigation
	React.useEffect(() => {
		const serializableNodes = nodes.map((n) => {
			const { onRename: _, ...data } = n.data as Record<string, unknown>;
			return { ...n, data };
		});
		setCanvasNodes(serializableNodes);
	}, [nodes, setCanvasNodes]);

	React.useEffect(() => {
		setCanvasEdges(edges);
	}, [edges, setCanvasEdges]);

	React.useEffect(() => {
		setCanvasDiagramType(diagramType);
	}, [diagramType, setCanvasDiagramType]);

	// Re-inject onRename into restored nodes (functions are not serializable)
	const renameInjectedRef = useRef(false);
	React.useEffect(() => {
		if (!renameInjectedRef.current && storedNodes.length > 0) {
			renameInjectedRef.current = true;
			setNodes((nds) =>
				nds.map((n) => ({
					...n,
					data: { ...n.data, onRename: handleRenameNode },
				})),
			);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
		// biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency omission
	}, [handleRenameNode, setNodes, storedNodes.length]);

	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	const handleNodesChange = (changes: any) => {
		setIsJsonSaved(false);
		onNodesChange(changes);
	};
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	const handleEdgesChange = (changes: any) => {
		setIsJsonSaved(false);
		onEdgesChange(changes);
	};

	const getFallbackExplorerRoot = useCallback(() => {
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		if ((globalThis as any).platform?.isWindows) return "C:\\";
		return "/";
	}, []);
	const [explorerRoot, setExplorerRoot] = useState(getFallbackExplorerRoot());
	const [explorerRootInput, setExplorerRootInput] = useState(explorerRoot);

	React.useEffect(() => {
		let cancelled = false;
		const api = globalThis.electronAPI?.getUserHome;
		if (!api) return;
		(async () => {
			try {
				const home = await api();
				if (cancelled || !home) return;
				setExplorerRoot((prev) =>
					prev === getFallbackExplorerRoot() ? home : prev,
				);
				setExplorerRootInput((prev) =>
					prev === getFallbackExplorerRoot() ? home : prev,
				);
			} catch {
				// keep fallback
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [getFallbackExplorerRoot]);

	React.useEffect(() => {
		if (showSaveAsDialog) {
			setSaveAsFileName(getDefaultFileName());
		}
		// biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency omission
	}, [showSaveAsDialog, getDefaultFileName]);

	const DIAGRAM_OPTIONS: {
		type: DiagramType;
		icon: React.ReactNode;
		label: string;
	}[] = [
		{
			type: "flowchart",
			icon: <GitBranch className="h-3.5 w-3.5" />,
			label: t("newFlowchart"),
		},
		{
			type: "architecture",
			icon: <Layers className="h-3.5 w-3.5" />,
			label: t("newArchitectureDiagram"),
		},
		{
			type: "mockup",
			icon: <LayoutTemplate className="h-3.5 w-3.5" />,
			label: t("newMockup"),
		},
	];

	return (
		<div className="flex flex-col h-full flex-1 relative">
			{/* Toolbar */}
			<div className="flex items-center gap-1 px-2 py-1.5 border-b bg-background shrink-0">
				{/* Group 1 — Diagram type selector */}
				<div className="flex items-center gap-0.5 p-0.5 bg-muted rounded-md">
					{DIAGRAM_OPTIONS.map(({ type, icon, label }) => (
						<button
							key={type}
							type="button"
							onClick={() => requestDiagramChange(type)}
							title={label}
							className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded transition-all ${
								diagramType === type
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground"
							}`}
						>
							{icon}
							<span className="hidden lg:inline">{label}</span>
						</button>
					))}
				</div>

				<div className="h-5 w-px bg-border mx-0.5" />

				{/* Group 2 — Canvas editing */}
				<Button
					size="sm"
					variant="ghost"
					onClick={handleAddNode}
					className="gap-1.5 h-7 px-2 text-xs"
					title={t("addBlock", "Ajouter un bloc")}
				>
					<Plus className="h-3.5 w-3.5" />
					<span className="hidden md:inline">{t("addBlock", "Bloc")}</span>
				</Button>
				<input
					type="file"
					ref={codeToVisualInputRef}
					style={{ display: "none" }}
					accept=".js,.ts,.tsx,.jsx,.py,.cs,.java,.go,.rb,.vue,.svelte"
					onChange={handleCodeToVisual}
				/>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => codeToVisualInputRef.current?.click()}
					disabled={isAiRunning}
					className="gap-1.5 h-7 px-2 text-xs"
					title={t(
						"reverseTooltip",
						"Analyser un fichier source et générer le diagramme correspondant",
					)}
				>
					<ArrowLeftRight className="h-3.5 w-3.5" />
					<span className="hidden md:inline">
						{t("reverse", "Code → Visuel")}
					</span>
				</Button>

				<div className="h-5 w-px bg-border mx-0.5" />

				{/* Group 3 — AI: primary action */}
				<Button
					size="sm"
					onClick={handleGenerateCode}
					disabled={isAiRunning || nodes.length === 0}
					title={t(
						"generateCodeTooltip",
						"Générer du code à partir du diagramme courant",
					)}
					className="gap-1.5 h-7 px-3 text-xs bg-violet-600 hover:bg-violet-700 text-white"
				>
					{isAiRunning ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					) : (
						<Sparkles className="h-3.5 w-3.5" />
					)}
					{isAiRunning
						? aiStatus || t("generating", "Génération…")
						: t("generateCode", "Générer le code")}
				</Button>

				{/* Spacer */}
				<div className="flex-1" />

				{/* Group 4 — File operations */}
				<Button
					size="sm"
					variant="ghost"
					onClick={handleExportCode}
					className="gap-1.5 h-7 px-2 text-xs"
					title={t("export", "Exporter JSON")}
				>
					<FileJson className="h-3.5 w-3.5" />
					<span className="hidden lg:inline">{t("export", "Exporter")}</span>
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={handleSaveAs}
					className="gap-1.5 h-7 px-2 text-xs relative"
					title={t("saveAs", "Enregistrer sous…")}
				>
					<Save className="h-3.5 w-3.5" />
					<span className="hidden lg:inline">{t("saveAs", "Enregistrer")}</span>
					{!isJsonSaved && (
						<span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" />
					)}
				</Button>
				<input
					type="file"
					ref={loadInputRef}
					style={{ display: "none" }}
					accept=".json"
					onChange={handleLoad}
				/>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => loadInputRef.current?.click()}
					className="gap-1.5 h-7 px-2 text-xs"
					title={t("load", "Charger")}
				>
					<FolderOpen className="h-3.5 w-3.5" />
					<span className="hidden lg:inline">{t("load", "Charger")}</span>
				</Button>
			</div>

			<div className="flex flex-col flex-1 min-h-0">
				<div className="flex-1 min-h-0 bg-muted/30 text-muted-foreground overflow-hidden relative">
					<ReactFlow
						ref={reactFlowRef}
						key={diagramType}
						nodes={nodes}
						edges={edges}
						onNodesChange={handleNodesChange}
						onEdgesChange={handleEdgesChange}
						onConnect={onConnect}
						fitView={true}
						edgeTypes={edgeTypes}
						nodeTypes={nodeTypes}
						{...reactFlowProps}
						onDrop={handleDrop}
						onDragOver={handleDragOver}
					>
						<Controls />
						<MiniMap
							style={{
								position: "absolute",
								left: 40,
								width: 180,
								height: 120,
								zIndex: 11,
								background: "rgba(255,255,255,0.9)",
								borderRadius: 8,
								boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
							}}
						/>
						<Background />
					</ReactFlow>
				</div>
			</div>

			<Dialog open={showFrameworkModal} onOpenChange={setShowFrameworkModal}>
				<DialogContent>
					<DialogTitle>{t("chooseFramework")}</DialogTitle>
					<DialogDescription>
						{t(
							"chooseFrameworkDesc",
							"Sélectionnez le framework ou la technologie pour ce bloc.",
						)}
					</DialogDescription>
					{pendingNode && (
						<Select
							value={selectedFramework}
							onValueChange={(fw) => {
								setSelectedFramework(fw);
								handleFrameworkSelect(fw);
							}}
						>
							<SelectTrigger>
								{selectedFramework
									? t(selectedFramework)
									: t("chooseFramework")}
							</SelectTrigger>
							<SelectContent>
								{FRAMEWORKS[pendingNode.type]?.map((fw) => (
									<SelectItem key={fw.value} value={fw.value}>
										{t(fw.labelKey)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				</DialogContent>
			</Dialog>

			<Dialog open={showSaveAsDialog} onOpenChange={setShowSaveAsDialog}>
				<DialogContent>
					<DialogTitle>
						{t("chooseFileName", "Nom du fichier d'export")}
					</DialogTitle>
					<div className="mt-4">
						<DialogDescription>
							{t(
								"chooseFileNameDesc",
								"Vous pouvez modifier le nom du fichier avant l'enregistrement.",
							)}
						</DialogDescription>
					</div>
					<div className="mt-4">
						<label
							htmlFor="explorer-root-input"
							className="block text-xs font-bold mb-1"
						>
							{t("explorerRoot", "Racine de l'explorateur :")}
						</label>
						<div className="flex gap-2">
							<input
								id="explorer-root-input"
								type="text"
								value={explorerRootInput}
								onChange={(e) => setExplorerRootInput(e.target.value)}
								className="w-full p-2 border rounded"
								placeholder="C:\\ ou /"
							/>
							<Button
								variant="secondary"
								onClick={() => setExplorerRoot(explorerRootInput)}
								disabled={explorerRootInput.length === 0}
							>
								{t("selectFolder", "Sélectionner")}
							</Button>
						</div>
					</div>
					<div
						className="mt-4"
						style={{ maxHeight: "60vh", overflowY: "auto" }}
					>
						<FileTree
							rootPath={explorerRoot}
							onSelectFolder={setSelectedFolder}
							selectedFolder={selectedFolder}
						/>
						<div className="mt-2 text-sm font-bold text-primary">
							{t("selectedFolder", "Selected folder")}:{" "}
							{selectedFolder || t("noFolder", "None")}
						</div>
					</div>
					<div className="mt-4">
						{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
						<label className="block text-xs font-bold mb-1">
							{t("fileNameLabel", "Nom du fichier :")}
						</label>
						<input
							type="text"
							value={saveAsFileName}
							onChange={(e) => setSaveAsFileName(e.target.value)}
							className="w-full mt-1 p-2 border rounded"
							placeholder={getDefaultFileName()}
						/>
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={confirmSaveAs}
							disabled={
								!selectedFolder ||
								!saveAsFileName ||
								saveAsFileName.trim().length === 0
							}
						>
							{t("save", "Sauvegarder dans le dossier sélectionné")}
						</Button>
						<Button variant="ghost" onClick={cancelSaveAs}>
							{t("cancel", "Annuler")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Generated Code Dialog */}
			<Dialog open={showCodeResult} onOpenChange={setShowCodeResult}>
				<DialogContent
					style={{ maxWidth: "80vw", maxHeight: "90vh", overflowY: "auto" }}
				>
					<DialogTitle>
						{t("generatedCodeTitle", "Code généré par IA")}
					</DialogTitle>
					{codeResult && (
						<>
							<DialogDescription>{codeResult.summary}</DialogDescription>
							{codeResult.files.length > 1 && (
								<div className="flex gap-1 flex-wrap mt-2">
									{codeResult.files.map((f, i) => (
										<Button
											key={f.filename}
											variant={i === selectedCodeFile ? "default" : "outline"}
											size="sm"
											onClick={() => setSelectedCodeFile(i)}
										>
											{f.filename}
										</Button>
									))}
								</div>
							)}
							{codeResult.files[selectedCodeFile] && (
								<div className="mt-3">
									<p className="text-xs font-mono text-muted-foreground mb-1">
										{codeResult.files[selectedCodeFile].filename}
									</p>
									<pre
										className="text-xs bg-muted rounded p-3 overflow-auto"
										style={{
											maxHeight: "50vh",
											whiteSpace: "pre-wrap",
											wordBreak: "break-all",
										}}
									>
										{codeResult.files[selectedCodeFile].content}
									</pre>
								</div>
							)}
							{codeResult.instructions && (
								<p className="mt-2 text-sm text-muted-foreground">
									{codeResult.instructions}
								</p>
							)}
							<DialogFooter className="mt-4">
								<Button
									variant="outline"
									onClick={() => {
										const file = codeResult.files[selectedCodeFile];
										if (!file) return;
										saveAs(
											new Blob([file.content], { type: "text/plain" }),
											file.filename.split("/").pop() || "generated.txt",
										);
									}}
								>
									{t("downloadFile", "Télécharger ce fichier")}
								</Button>
								<Button
									variant="outline"
									onClick={() => {
										codeResult.files.forEach((f) => {
											saveAs(
												new Blob([f.content], { type: "text/plain" }),
												f.filename.split("/").pop() || "generated.txt",
											);
										});
									}}
								>
									{t("downloadAll", "Tout télécharger")}
								</Button>
								<Button
									variant="ghost"
									onClick={() => setShowCodeResult(false)}
								>
									{t("close", "Fermer")}
								</Button>
							</DialogFooter>
						</>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
};
