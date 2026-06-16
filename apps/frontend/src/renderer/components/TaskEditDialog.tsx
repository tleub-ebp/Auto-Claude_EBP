/**
 * TaskEditDialog - Dialog for editing task details
 *
 * Allows users to modify all task properties including title, description,
 * classification fields, images, and review settings.
 *
 * Now uses the shared TaskModalLayout for consistent styling with other task modals,
 * and TaskFormFields for the form content.
 *
 * Features:
 * - Pre-populates form with current task values
 * - Form validation (description required)
 * - Editable classification fields (category, priority, complexity, impact)
 * - Editable image attachments (add/remove images)
 * - Editable review settings (requireReviewBeforeCoding)
 * - Saves changes via persistUpdateTask (updates store + spec files)
 * - Prevents save when no changes have been made
 *
 * @example
 * ```tsx
 * <TaskEditDialog
 *   task={selectedTask}
 *   open={isEditDialogOpen}
 *   onOpenChange={setIsEditDialogOpen}
 *   onSaved={() => console.log('Task updated!')}
 * />
 * ```
 */

import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	DEFAULT_AGENT_PROFILES,
	DEFAULT_PHASE_MODELS,
	DEFAULT_PHASE_THINKING,
} from "../../shared/constants";
import type {
	ImageAttachment,
	Task,
	TaskCategory,
	TaskComplexity,
	TaskImpact,
	TaskPriority,
	ThinkingLevel,
} from "../../shared/types";
import type {
	PhaseModelConfig,
	PhaseThinkingConfig,
} from "../../shared/types/settings";
import { cn } from "../lib/utils";
import { useProjectStore } from "../stores/project-store";
import { useSettingsStore } from "../stores/settings-store";
import { duplicateTask, persistUpdateTask } from "../stores/task-store";
import { useProviderContext } from "./ProviderContext";
import { TaskFormFields } from "./task-form/TaskFormFields";
import { TaskModalLayout } from "./task-form/TaskModalLayout";
import type { FileReferenceData } from "./task-form/useImageUpload";
import { Button } from "./ui/button";

/**
 * Props for the TaskEditDialog component
 */
interface TaskEditDialogProps {
	/** The task to edit (in "duplicate" mode, the source task to clone) */
	readonly task: Task;
	/** Whether the dialog is open */
	readonly open: boolean;
	/** Callback when the dialog open state changes */
	readonly onOpenChange: (open: boolean) => void;
	/** Optional callback when task is successfully saved (edit mode) */
	readonly onSaved?: () => void;
	/** Callback pour fermeture explicite de la tâche courante (remonte jusqu'à App.tsx) */
	readonly onCloseTask?: () => void;
	/**
	 * Dialog behaviour:
	 * - "edit" (default): update the existing task in place.
	 * - "duplicate": pre-fill from the source task, let the user edit the
	 *   fields, then create a brand-new backlog task on submit.
	 */
	readonly mode?: "edit" | "duplicate";
	/** Optional callback when a duplicate is successfully created (duplicate mode) */
	readonly onCreated?: (newTaskId: string) => void;
}

export function TaskEditDialog({
	task,
	open,
	onOpenChange,
	onSaved,
	onCloseTask,
	mode = "edit",
	onCreated,
}: TaskEditDialogProps) {
	const { t } = useTranslation(["tasks", "common"]);
	const isDuplicate = mode === "duplicate";
	// In duplicate mode the title is pre-filled with a localized "(copy)" suffix.
	const initialTitle = isDuplicate
		? `${task.title} ${t("tasks:actions.duplicateSuffix")}`
		: task.title;
	// Get selected agent profile from settings for defaults
	const { settings } = useSettingsStore();
	// Global provider, used as the per-task default when the task has none yet.
	const { selectedProvider } = useProviderContext();
	const selectedProfile =
		DEFAULT_AGENT_PROFILES.find(
			(p) => p.id === settings.selectedAgentProfile,
			// biome-ignore lint/style/noNonNullAssertion: value is guaranteed by context
		) || DEFAULT_AGENT_PROFILES.find((p) => p.id === "auto")!;

	// Get project path for loading image thumbnails from disk
	const projects = useProjectStore((state) => state.projects);
	const projectPath = useMemo(() => {
		const project = projects.find((p) => p.id === task.projectId);
		return project?.path;
	}, [projects, task.projectId]);

	// Form state
	const [title, setTitle] = useState(initialTitle);
	const [description, setDescription] = useState(task.description);
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showClassification, setShowClassification] = useState(false);
	// 2-step wizard: 1 = task details, 2 = execution engine (provider/LLM/effort),
	// so the engine choice gets a dedicated, prominent page instead of being buried.
	const [step, setStep] = useState<1 | 2>(1);

	// Classification fields
	const [category, setCategory] = useState<TaskCategory | "">(
		task.metadata?.category || "",
	);
	const [priority, setPriority] = useState<TaskPriority | "">(
		task.metadata?.priority || "",
	);
	const [complexity, setComplexity] = useState<TaskComplexity | "">(
		task.metadata?.complexity || "",
	);
	const [impact, setImpact] = useState<TaskImpact | "">(
		task.metadata?.impact || "",
	);

	// Per-task LLM provider. Defaults to the task's own provider, else the global
	// selection. `initialProviderRef` lets edit mode tell "untouched" from an
	// explicit change so we don't silently pin a provider the user didn't pick.
	const defaultProvider =
		task.metadata?.provider || selectedProvider || "anthropic";
	const [provider, setProvider] = useState<string>(defaultProvider);
	const initialProviderRef = useRef<string>(defaultProvider);

	// Agent profile / model configuration
	const [profileId, setProfileId] = useState<string>(() => {
		if (task.metadata?.isAutoProfile) {
			return "auto";
		}
		const taskModel = task.metadata?.model;
		const taskThinking = task.metadata?.thinkingLevel;
		if (taskModel && taskThinking) {
			const matchingProfile = DEFAULT_AGENT_PROFILES.find(
				(p) =>
					p.model === taskModel &&
					p.thinkingLevel === taskThinking &&
					!p.isAutoProfile,
			);
			return matchingProfile?.id || "custom";
		}
		return settings.selectedAgentProfile || "auto";
	});
	const [model, setModel] = useState<string>(
		task.metadata?.model || selectedProfile.model,
	);
	const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | "">(
		task.metadata?.thinkingLevel || selectedProfile.thinkingLevel,
	);
	const [phaseModels, setPhaseModels] = useState<PhaseModelConfig | undefined>(
		task.metadata?.phaseModels ||
			selectedProfile.phaseModels ||
			DEFAULT_PHASE_MODELS,
	);
	const [phaseThinking, setPhaseThinking] = useState<
		PhaseThinkingConfig | undefined
	>(
		task.metadata?.phaseThinking ||
			selectedProfile.phaseThinking ||
			DEFAULT_PHASE_THINKING,
	);

	// Image attachments
	const [images, setImages] = useState<ImageAttachment[]>(
		task.metadata?.attachedImages || [],
	);

	// Review setting
	const [requireReviewBeforeCoding, setRequireReviewBeforeCoding] = useState(
		task.metadata?.requireReviewBeforeCoding ?? false,
	);

	// TDD override (per-task)
	const [tddMode, setTddMode] = useState(task.metadata?.tddMode ?? false);

	// Reset form when task changes or dialog opens
	useEffect(() => {
		if (open) {
			setTitle(initialTitle);
			setDescription(task.description);
			setCategory(task.metadata?.category || "");
			setPriority(task.metadata?.priority || "");
			setComplexity(task.metadata?.complexity || "");
			setImpact(task.metadata?.impact || "");

			// Reset model configuration
			const taskModel = task.metadata?.model;
			const taskThinking = task.metadata?.thinkingLevel;
			const isAutoProfile = task.metadata?.isAutoProfile;

			if (isAutoProfile) {
				setProfileId("auto");
				setModel(taskModel || selectedProfile.model);
				setThinkingLevel(taskThinking || selectedProfile.thinkingLevel);
				setPhaseModels(task.metadata?.phaseModels || DEFAULT_PHASE_MODELS);
				setPhaseThinking(
					task.metadata?.phaseThinking || DEFAULT_PHASE_THINKING,
				);
			} else if (taskModel && taskThinking) {
				const matchingProfile = DEFAULT_AGENT_PROFILES.find(
					(p) =>
						p.model === taskModel &&
						p.thinkingLevel === taskThinking &&
						!p.isAutoProfile,
				);
				setProfileId(matchingProfile?.id || "custom");
				setModel(taskModel);
				setThinkingLevel(taskThinking);
				setPhaseModels(task.metadata?.phaseModels || DEFAULT_PHASE_MODELS);
				setPhaseThinking(
					task.metadata?.phaseThinking || DEFAULT_PHASE_THINKING,
				);
			} else {
				setProfileId(settings.selectedAgentProfile || "auto");
				setModel(selectedProfile.model);
				setThinkingLevel(selectedProfile.thinkingLevel);
				setPhaseModels(selectedProfile.phaseModels || DEFAULT_PHASE_MODELS);
				setPhaseThinking(
					selectedProfile.phaseThinking || DEFAULT_PHASE_THINKING,
				);
			}

			setImages(task.metadata?.attachedImages || []);
			setRequireReviewBeforeCoding(
				task.metadata?.requireReviewBeforeCoding ?? false,
			);
			setTddMode(task.metadata?.tddMode ?? false);
			const resolvedProvider =
				task.metadata?.provider || selectedProvider || "anthropic";
			setProvider(resolvedProvider);
			initialProviderRef.current = resolvedProvider;
			setError(null);
			setStep(1);

			// Auto-expand classification if it has content
			if (
				task.metadata?.category ||
				task.metadata?.priority ||
				task.metadata?.complexity ||
				task.metadata?.impact
			) {
				setShowClassification(true);
			} else {
				setShowClassification(false);
			}
		}
	}, [
		open,
		task,
		initialTitle,
		settings.selectedAgentProfile,
		selectedProfile.model,
		selectedProfile.thinkingLevel,
		selectedProfile.phaseModels,
		selectedProfile.phaseThinking,
		selectedProvider,
	]);

	// Resolve Azure DevOps attachment images (PAT-protected URLs the renderer
	// cannot load) into inlined data URIs so they render in the WYSIWYG editor,
	// mirroring the read-only detail view. Only applies while the description is
	// still untouched, so it never clobbers in-progress edits.
	useEffect(() => {
		if (!open) return;
		if (!task.description?.includes("/_apis/wit/attachments/")) return;

		let cancelled = false;
		(async () => {
			try {
				const res =
					await globalThis.electronAPI?.hydrateAzureDevOpsTaskDisplay?.(
						task.projectId,
						task.id,
					);
				const html = res?.data?.html;
				if (!cancelled && res?.success && html) {
					setDescription((current) =>
						current === task.description ? html : current,
					);
				}
			} catch {
				// Non-blocking: keep the original description.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [open, task.id, task.projectId, task.description]);

	/**
	 * Handle file reference drop from FileTreeItem drag
	 * Appends @filename to the end of the description (no textarea ref in edit dialog)
	 */
	const handleFileReferenceDrop = useCallback(
		(reference: string, _data: FileReferenceData) => {
			// Append to description using functional update to ensure latest state
			// This prevents stale closure issues with rapid consecutive drops
			setDescription((prev) => {
				const separator = prev.endsWith(" ") || prev === "" ? "" : " ";
				return `${prev + separator + reference} `;
			});
		},
		[],
	);

	const handleSave = async () => {
		// Validate input
		if (!description.trim()) {
			setError(t("tasks:form.errors.descriptionRequired"));
			return;
		}

		const trimmedTitle = title.trim();
		const trimmedDescription = description.trim();
		// Provider is "changed" only when the user picked a different one than the
		// value the dialog opened with (so plain edits don't pin a provider).
		const providerChanged = provider !== initialProviderRef.current;

		// Edit mode short-circuits when nothing changed. Duplicate always creates.
		if (!isDuplicate) {
			const hasChanges =
				trimmedTitle !== task.title ||
				trimmedDescription !== task.description ||
				category !== (task.metadata?.category || "") ||
				priority !== (task.metadata?.priority || "") ||
				complexity !== (task.metadata?.complexity || "") ||
				impact !== (task.metadata?.impact || "") ||
				providerChanged ||
				model !== (task.metadata?.model || "") ||
				thinkingLevel !== (task.metadata?.thinkingLevel || "") ||
				requireReviewBeforeCoding !==
					(task.metadata?.requireReviewBeforeCoding ?? false) ||
				tddMode !== (task.metadata?.tddMode ?? false) ||
				JSON.stringify(images) !==
					JSON.stringify(task.metadata?.attachedImages || []) ||
				JSON.stringify(phaseModels) !==
					JSON.stringify(task.metadata?.phaseModels || DEFAULT_PHASE_MODELS) ||
				JSON.stringify(phaseThinking) !==
					JSON.stringify(
						task.metadata?.phaseThinking || DEFAULT_PHASE_THINKING,
					);

			if (!hasChanges) {
				onOpenChange(false);
				return;
			}
		}

		setIsSaving(true);
		setError(null);

		// Build metadata updates (shared by edit + duplicate)
		const metadataUpdates: Partial<typeof task.metadata> = {};
		if (category) metadataUpdates.category = category;
		if (priority) metadataUpdates.priority = priority;
		if (complexity) metadataUpdates.complexity = complexity;
		if (impact) metadataUpdates.impact = impact;
		if (model) metadataUpdates.model = model;
		if (thinkingLevel) metadataUpdates.thinkingLevel = thinkingLevel;
		if (phaseModels && phaseThinking) {
			metadataUpdates.isAutoProfile = profileId === "auto";
			metadataUpdates.phaseModels = phaseModels;
			metadataUpdates.phaseThinking = phaseThinking;
		}
		// Pin the provider on this task (uniformly across phases) when it was
		// chosen for a clone or explicitly changed, so the task runs with the
		// selected provider regardless of the global selection.
		if ((isDuplicate || providerChanged) && provider) {
			metadataUpdates.provider = provider;
			metadataUpdates.phaseProviders = {
				spec: provider,
				planning: provider,
				coding: provider,
				qa: provider,
			};
		}
		// Always set attachedImages to persist removal when all images are deleted
		metadataUpdates.attachedImages = images.length > 0 ? images : [];
		metadataUpdates.requireReviewBeforeCoding = requireReviewBeforeCoding;
		// Only persist tddMode when it diverges from the current value, so that
		// "inherit project default" (undefined) is preserved unless explicitly changed.
		if (tddMode !== (task.metadata?.tddMode ?? false)) {
			metadataUpdates.tddMode = tddMode;
		}

		if (isDuplicate) {
			// Clone the source task (copies spec.md/requirements/metadata/attachments
			// on disk, preserving images), then apply the edited fields to the
			// freshly created backlog task.
			const dup = await duplicateTask(task.id, trimmedTitle);
			if (dup.success && dup.task) {
				await persistUpdateTask(dup.task.id, {
					title: trimmedTitle,
					description: trimmedDescription,
					metadata: metadataUpdates,
				});
				onOpenChange(false);
				onCreated?.(dup.task.id);
			} else {
				setError(dup.error || t("tasks:duplicate.errors.createFailed"));
			}
			setIsSaving(false);
			return;
		}

		const success = await persistUpdateTask(task.id, {
			title: trimmedTitle,
			description: trimmedDescription,
			metadata: metadataUpdates,
		});

		if (success) {
			onOpenChange(false);
			onSaved?.();
		} else {
			setError(t("tasks:edit.errors.updateFailed"));
		}

		setIsSaving(false);
	};

	const isValid = description.trim().length > 0;

	// Advance to the engine step, enforcing the only hard requirement (description)
	// before leaving the details page.
	const goToEngineStep = () => {
		if (!description.trim()) {
			setError(t("tasks:form.errors.descriptionRequired"));
			return;
		}
		setError(null);
		setStep(2);
	};

	return (
		<TaskModalLayout
			open={open}
			onOpenChange={onOpenChange}
			title={isDuplicate ? t("tasks:duplicate.title") : t("tasks:edit.title")}
			description={
				isDuplicate
					? t("tasks:duplicate.description")
					: t("tasks:edit.description")
			}
			disabled={isSaving}
			onClose={onCloseTask}
			footer={
				<div className="flex items-center justify-between gap-3">
					{/* Step indicator — makes the 2 pages explicit */}
					<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
						<span className={cn(step === 1 && "font-medium text-foreground")}>
							1. {t("tasks:form.stepDetails")}
						</span>
						<ChevronRight className="h-3.5 w-3.5" />
						<span className={cn(step === 2 && "font-medium text-foreground")}>
							2. {t("tasks:form.stepEngine")}
						</span>
					</div>
					<div className="flex items-center gap-3">
						{step === 1 ? (
							<>
								<Button
									variant="outline"
									onClick={() => onOpenChange(false)}
									disabled={isSaving}
								>
									{t("common:buttons.cancel")}
								</Button>
								<Button onClick={goToEngineStep} disabled={isSaving || !isValid}>
									{t("tasks:form.nextStep")}
									<ChevronRight className="ml-2 h-4 w-4" />
								</Button>
							</>
						) : (
							<>
								<Button
									variant="outline"
									onClick={() => setStep(1)}
									disabled={isSaving}
								>
									<ChevronLeft className="mr-2 h-4 w-4" />
									{t("tasks:form.previousStep")}
								</Button>
								<Button onClick={handleSave} disabled={isSaving || !isValid}>
									{isSaving ? (
										<>
											<Loader2 className="mr-2 h-4 w-4 animate-spin" />
											{isDuplicate
												? t("common:buttons.creating")
												: t("common:buttons.saving")}
										</>
									) : isDuplicate ? (
										t("tasks:duplicate.createButton")
									) : (
										t("tasks:edit.saveChanges")
									)}
								</Button>
							</>
						)}
					</div>
				</div>
			}
		>
			<TaskFormFields
				section={step === 1 ? "content" : "engine"}
				projectPath={projectPath}
				specId={task.specId}
				description={description}
				onDescriptionChange={setDescription}
				richText
				title={title}
				onTitleChange={setTitle}
				profileId={profileId}
				model={model}
				thinkingLevel={thinkingLevel}
				provider={provider}
				onProviderChange={setProvider}
				phaseModels={phaseModels}
				phaseThinking={phaseThinking}
				onProfileChange={(newProfileId, newModel, newThinkingLevel) => {
					setProfileId(newProfileId);
					setModel(newModel);
					setThinkingLevel(newThinkingLevel);
				}}
				onModelChange={setModel}
				onThinkingLevelChange={setThinkingLevel}
				onPhaseModelsChange={setPhaseModels}
				onPhaseThinkingChange={setPhaseThinking}
				category={category}
				priority={priority}
				complexity={complexity}
				impact={impact}
				onCategoryChange={setCategory}
				onPriorityChange={setPriority}
				onComplexityChange={setComplexity}
				onImpactChange={setImpact}
				showClassification={showClassification}
				onShowClassificationChange={setShowClassification}
				images={images}
				onImagesChange={setImages}
				requireReviewBeforeCoding={requireReviewBeforeCoding}
				onRequireReviewChange={setRequireReviewBeforeCoding}
				tddMode={tddMode}
				onTddModeChange={setTddMode}
				disabled={isSaving}
				error={error}
				onError={setError}
				onFileReferenceDrop={handleFileReferenceDrop}
				idPrefix="edit"
			/>
		</TaskModalLayout>
	);
}
