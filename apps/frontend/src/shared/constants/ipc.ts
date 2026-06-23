/**
 * IPC Channel names for Electron communication
 * Main process <-> Renderer process communication
 */

export const IPC_CHANNELS = {
	// Project operations
	PROJECT_ADD: "project:add",
	PROJECT_REMOVE: "project:remove",
	PROJECT_LIST: "project:list",
	PROJECT_UPDATE_SETTINGS: "project:updateSettings",
	PROJECT_RENAME: "project:rename",
	PROJECT_INITIALIZE: "project:initialize",
	PROJECT_CHECK_VERSION: "project:checkVersion",
	PROJECT_CHECK_PATHS: "project:checkPaths",
	PROJECT_REPATH: "project:repath",

	// Tab state operations (persisted in main process)
	TAB_STATE_GET: "tabState:get",
	TAB_STATE_SAVE: "tabState:save",

	// Kanban preferences (per-project column collapse state)
	KANBAN_PREFS_GET: "kanbanPrefs:get",
	KANBAN_PREFS_SAVE: "kanbanPrefs:save",
	// Kanban board view-state (per-project column order, filters, saved views)
	KANBAN_STATE_GET: "kanbanState:get",
	KANBAN_STATE_SAVE: "kanbanState:save",

	// Task operations
	TASK_LIST: "task:list",
	TASK_CREATE: "task:create",
	TASK_DUPLICATE: "task:duplicate", // Clone a task's spec (spec.md, requirements, metadata, attachments) into a fresh backlog task; no plan/worktree/runtime artifacts
	TASK_DELETE: "task:delete",
	TASK_UPDATE: "task:update",
	TASK_START: "task:start",
	TASK_STOP: "task:stop",
	TASK_REVIEW: "task:review",
	TASK_UPDATE_STATUS: "task:updateStatus",
	TASK_UPDATE_PLAN: "task:updatePlan", // Update plan phases and subtasks
	TASK_RECOVER_STUCK: "task:recoverStuck",
	TASK_CHECK_RUNNING: "task:checkRunning",
	TASK_RESUME_PAUSED: "task:resumePaused", // Resume a rate-limited or auth-paused task
	TASK_RESUME_SESSION: "task:resumeSession", // Resume a Claude SDK session (uses .session.json)
	TASK_RESUME_WITH_PROVIDER: "task:resumeWithProvider", // Resume a paused task under a different LLM provider (Niveau 3b)
	TASK_RESET_CONVERSATION: "task:resetConversation", // Clear conversation.jsonl + PROMPT_TOO_LONG_HALT marker so the task can restart with a fresh context
	TASK_RESET: "task:reset", // Full reset: discard plan/subtasks, worktree and runtime artifacts; keep the spec and go back to backlog
	TASK_CHECK_PLAN_CONFLICTS: "task:checkPlanConflicts", // Detect file overlaps between this task's plan and other active tasks (parallel worktrees)

	// CI/CD pipeline loop (« Build rouge » column) — provider-agnostic (Azure DevOps, GitHub Actions, GitLab CI, Jenkins)
	TASK_PIPELINE_STATUS_GET: "task:pipelineStatusGet", // On-demand fetch of the latest build for a task's branch
	TASK_PIPELINE_FIX: "task:pipelineFix", // Launch the agent to repair a red build (writes BUILD_FAILURE.md + fix subtask)
	TASK_PIPELINE_STATUS_EVENT: "task:pipelineStatus", // Event (main -> renderer): pipeline status changed for a task
	TASK_SPEC_INTERVIEW: "task:specInterview", // Generate 3-5 clarifying questions about the spec before planning (answers are appended to the description)
	TASK_LOAD_IMAGE_THUMBNAIL: "task:loadImageThumbnail",

	// Workspace management (for human review)
	// Per-spec architecture: Each spec has its own worktree at .worktrees/{spec-name}/
	TASK_WORKTREE_STATUS: "task:worktreeStatus",
	TASK_WORKTREE_DIFF: "task:worktreeDiff",
	TASK_FILE_DIFF: "task:fileDiff", // Diff à la demande d'un fichier impacté (inclut les changements non commités)
	TASK_WORKTREE_MERGE: "task:worktreeMerge",
	TASK_WORKTREE_MERGE_PREVIEW: "task:worktreeMergePreview", // Preview merge conflicts before merging
	TASK_WORKTREE_DISCARD: "task:worktreeDiscard",
	TASK_WORKTREE_DISCARD_ORPHAN: "task:worktreeDiscardOrphan", // Delete orphaned worktree by spec name (no task association)
	TASK_WORKTREE_SYNC_FROM_BRANCH: "task:worktreeSyncFromBranch", // Merge or rebase worktree from any branch
	TASK_WORKTREE_CREATE_PR: "task:worktreeCreatePR",
	TASK_WORKTREE_ANALYZE_IMPACT: "task:worktreeAnalyzeImpact", // Preview PR body + impact analysis WITHOUT pushing
	TASK_VISUAL_PROOF_RUN: "task:visualProofRun", // Run emulator + screenshot proof for PR
	TASK_VISUAL_PROOF_STATUS: "task:visualProofStatus", // Query whether a visual proof run is in progress for a task
	TASK_WORKTREE_OPEN_IN_IDE: "task:worktreeOpenInIDE",
	TASK_WORKTREE_OPEN_IN_TERMINAL: "task:worktreeOpenInTerminal",
	TASK_WORKTREE_DETECT_TOOLS: "task:worktreeDetectTools", // Detect installed IDEs/terminals
	TASK_WORKTREE_READ_FILE: "task:worktreeReadFile",
	TASK_WORKTREE_WRITE_FILE: "task:worktreeWriteFile",
	TASK_WORKTREE_DELETE_FILES: "task:worktreeDeleteFiles",
	TASK_LIST_WORKTREES: "task:listWorktrees",
	TASK_ARCHIVE: "task:archive",
	TASK_UNARCHIVE: "task:unarchive",
	TASK_CLEAR_STAGED_STATE: "task:clearStagedState",

	// Task events (main -> renderer)
	TASK_PROGRESS: "task:progress",
	TASK_ERROR: "task:error",
	TASK_LOG: "task:log",
	TASK_STATUS_CHANGE: "task:statusChange",
	TASK_EXECUTION_PROGRESS: "task:executionProgress",
	TASK_VISUAL_PROOF_RUNNING: "task:visualProofRunning", // Event: visual proof run started/finished (main -> renderer)

	// Task phase logs (persistent, collapsible logs by phase)
	TASK_LOGS_GET: "task:logsGet", // Load logs from spec dir
	TASK_LOGS_WATCH: "task:logsWatch", // Start watching for log changes
	TASK_LOGS_UNWATCH: "task:logsUnwatch", // Stop watching for log changes
	TASK_LOGS_CHANGED: "task:logsChanged", // Event: logs changed (main -> renderer)
	TASK_LOGS_STREAM: "task:logsStream", // Event: streaming log chunk (main -> renderer)
	TASK_MERGE_PROGRESS: "task:mergeProgress", // Event: merge progress update (main -> renderer)

	// Agent Decision Logger (Feature 30)
	AGENT_DECISION_LOG_GET: "agentDecision:getLog", // Renderer → Main: load persisted log
	AGENT_DECISION_LOG_CLEAR: "agentDecision:clearLog", // Renderer → Main: clear log file
	AGENT_DECISION_LOG_ENTRY: "agentDecision:entry", // Main → Renderer: live entry stream

	// Terminal operations
	TERMINAL_CREATE: "terminal:create",
	TERMINAL_DESTROY: "terminal:destroy",
	TERMINAL_INPUT: "terminal:input",
	TERMINAL_RESIZE: "terminal:resize",
	TERMINAL_INVOKE_CLAUDE: "terminal:invokeClaude",
	TERMINAL_GENERATE_NAME: "terminal:generateName",
	TERMINAL_SET_TITLE: "terminal:setTitle", // Renderer -> Main: user renamed terminal
	TERMINAL_SET_WORKTREE_CONFIG: "terminal:setWorktreeConfig", // Renderer -> Main: worktree association changed

	// Terminal session management
	TERMINAL_GET_SESSIONS: "terminal:getSessions",
	TERMINAL_RESTORE_SESSION: "terminal:restoreSession",
	TERMINAL_CLEAR_SESSIONS: "terminal:clearSessions",
	TERMINAL_RESUME_CLAUDE: "terminal:resumeClaude",
	TERMINAL_ACTIVATE_DEFERRED_RESUME: "terminal:activateDeferredResume", // Trigger deferred Claude resume when terminal becomes active
	TERMINAL_GET_SESSION_DATES: "terminal:getSessionDates",
	TERMINAL_GET_SESSIONS_FOR_DATE: "terminal:getSessionsForDate",
	TERMINAL_RESTORE_FROM_DATE: "terminal:restoreFromDate",
	TERMINAL_CHECK_PTY_ALIVE: "terminal:checkPtyAlive",
	TERMINAL_UPDATE_DISPLAY_ORDERS: "terminal:updateDisplayOrders", // Persist terminal display order after drag-drop reorder

	// Terminal worktree operations (isolated development in worktrees)
	TERMINAL_WORKTREE_CREATE: "terminal:worktreeCreate",
	TERMINAL_WORKTREE_REMOVE: "terminal:worktreeRemove",
	TERMINAL_WORKTREE_LIST: "terminal:worktreeList",
	TERMINAL_WORKTREE_LIST_OTHER: "terminal:worktreeListOther",

	// Terminal events (main -> renderer)
	TERMINAL_OUTPUT: "terminal:output",
	TERMINAL_EXIT: "terminal:exit",
	TERMINAL_TITLE_CHANGE: "terminal:titleChange",
	TERMINAL_WORKTREE_CONFIG_CHANGE: "terminal:worktreeConfigChange", // Worktree config restored/changed (for sync on recovery)
	TERMINAL_CLAUDE_SESSION: "terminal:claudeSession", // Claude session ID captured
	TERMINAL_PENDING_RESUME: "terminal:pendingResume", // Terminal has pending Claude resume (for deferred activation)
	TERMINAL_RATE_LIMIT: "terminal:rateLimit", // Claude Code rate limit detected
	TERMINAL_OAUTH_TOKEN: "terminal:oauthToken", // OAuth token captured from setup-token output
	TERMINAL_AUTH_CREATED: "terminal:authCreated", // Auth terminal created for OAuth flow
	TERMINAL_OAUTH_CODE_NEEDED: "terminal:oauthCodeNeeded", // Request user to paste OAuth code from browser
	TERMINAL_OAUTH_CODE_SUBMIT: "terminal:oauthCodeSubmit", // User submitted OAuth code to send to terminal
	TERMINAL_CLAUDE_BUSY: "terminal:claudeBusy", // Claude Code busy state (for visual indicator)
	TERMINAL_CLAUDE_EXIT: "terminal:claudeExit", // Claude Code exited (returned to shell)
	TERMINAL_ONBOARDING_COMPLETE: "terminal:onboardingComplete", // Claude onboarding complete (ready for input after login)
	TERMINAL_PROFILE_CHANGED: "terminal:profileChanged", // Profile changed, terminals need refresh (main -> renderer)

	// Claude profile management (multi-account support)
	CLAUDE_PROFILES_GET: "claude:profilesGet",
	CLAUDE_PROFILE_SAVE: "claude:profileSave",
	CLAUDE_PROFILE_DELETE: "claude:profileDelete",
	CLAUDE_PROFILE_RENAME: "claude:profileRename",
	CLAUDE_PROFILE_SET_ACTIVE: "claude:profileSetActive",
	CLAUDE_PROFILE_SWITCH: "claude:profileSwitch",
	CLAUDE_PROFILE_INITIALIZE: "claude:profileInitialize",
	CLAUDE_PROFILE_SET_TOKEN: "claude:profileSetToken", // Set OAuth token for a profile
	CLAUDE_PROFILE_AUTHENTICATE: "claude:profileAuthenticate", // Open visible terminal for OAuth login
	CLAUDE_PROFILE_VERIFY_AUTH: "claude:profileVerifyAuth", // Check if profile has been authenticated
	CLAUDE_PROFILE_AUTO_SWITCH_SETTINGS: "claude:autoSwitchSettings",
	CLAUDE_PROFILE_UPDATE_AUTO_SWITCH: "claude:updateAutoSwitch",
	CLAUDE_PROFILE_FETCH_USAGE: "claude:fetchUsage",
	CLAUDE_PROFILE_GET_BEST_PROFILE: "claude:getBestProfile",

	// Account priority order (unified OAuth + API profile ordering)
	ACCOUNT_PRIORITY_GET: "account:priorityGet",
	ACCOUNT_PRIORITY_SET: "account:prioritySet",

	// SDK/CLI rate limit event (for non-terminal Claude invocations)
	CLAUDE_SDK_RATE_LIMIT: "claude:sdkRateLimit",
	// Auth failure event (401 errors requiring re-authentication)
	CLAUDE_AUTH_FAILURE: "claude:authFailure",
	// Retry a rate-limited operation with a different profile
	CLAUDE_RETRY_WITH_PROFILE: "claude:retryWithProfile",

	// Usage monitoring (proactive account switching)
	COSTS_DATA_UPDATED: "costs:dataUpdated", // Event: cost_data.json changed (main -> renderer)
	DASHBOARD_SNAPSHOT_UPDATED: "dashboard:snapshotUpdated", // Event: dashboard_snapshot.json changed (main -> renderer)
	USAGE_UPDATED: "claude:usageUpdated", // Event: usage data updated (main -> renderer)
	USAGE_REQUEST: "claude:usageRequest", // Request current usage snapshot
	ALL_PROFILES_USAGE_REQUEST: "claude:allProfilesUsageRequest", // Request all profiles usage immediately
	ALL_PROFILES_USAGE_UPDATED: "claude:allProfilesUsageUpdated", // Event: all profiles usage data (main -> renderer)
	PROACTIVE_SWAP_NOTIFICATION: "claude:proactiveSwapNotification", // Event: proactive swap occurred

	// Settings
	SETTINGS_GET: "settings:get",
	SETTINGS_SAVE: "settings:save",
	SETTINGS_GET_CLI_TOOLS_INFO: "settings:getCliToolsInfo",
	SETTINGS_CLAUDE_CODE_GET_ONBOARDING_STATUS:
		"settings:claudeCode:getOnboardingStatus", // Check hasCompletedOnboarding from ~/.claude.json

	// API Profile management (custom Anthropic-compatible endpoints)
	PROFILES_GET: "profiles:get",
	PROFILES_SAVE: "profiles:save",
	PROFILES_UPDATE: "profiles:update",
	PROFILES_DELETE: "profiles:delete",
	PROFILES_SET_ACTIVE: "profiles:setActive",
	PROFILES_TEST_CONNECTION: "profiles:test-connection",
	PROFILES_TEST_CONNECTION_CANCEL: "profiles:test-connection-cancel",
	PROFILES_DISCOVER_MODELS: "profiles:discover-models",
	PROFILES_DISCOVER_MODELS_CANCEL: "profiles:discover-models-cancel",

	// Dialogs
	DIALOG_SELECT_DIRECTORY: "dialog:selectDirectory",
	DIALOG_SELECT_FILES: "dialog:selectFiles",
	DIALOG_CREATE_PROJECT_FOLDER: "dialog:createProjectFolder",
	DIALOG_GET_DEFAULT_PROJECT_LOCATION: "dialog:getDefaultProjectLocation",

	// App info
	APP_VERSION: "app:version",

	// Shell operations
	SHELL_OPEN_EXTERNAL: "shell:openExternal",
	SHELL_OPEN_TERMINAL: "shell:openTerminal",
	SHELL_OPEN_TERMINAL_WITH_COMMAND: "shell:openTerminalWithCommand",

	// Roadmap operations
	ROADMAP_GET: "roadmap:get",
	ROADMAP_GET_STATUS: "roadmap:getStatus",
	ROADMAP_SAVE: "roadmap:save",
	ROADMAP_GENERATE: "roadmap:generate",
	ROADMAP_GENERATE_WITH_COMPETITOR: "roadmap:generateWithCompetitor",
	ROADMAP_REFRESH: "roadmap:refresh",
	ROADMAP_STOP: "roadmap:stop",
	ROADMAP_UPDATE_FEATURE: "roadmap:updateFeature",
	ROADMAP_CONVERT_TO_SPEC: "roadmap:convertToSpec",

	// Roadmap events (main -> renderer)
	ROADMAP_PROGRESS: "roadmap:progress",
	ROADMAP_COMPLETE: "roadmap:complete",
	ROADMAP_ERROR: "roadmap:error",
	ROADMAP_STOPPED: "roadmap:stopped",

	// Roadmap progress persistence (per-project state)
	ROADMAP_PROGRESS_SAVE: "roadmap:progressSave",
	ROADMAP_PROGRESS_LOAD: "roadmap:progressLoad",
	ROADMAP_PROGRESS_CLEAR: "roadmap:progressClear",

	// Context operations
	CONTEXT_GET: "context:get",
	CONTEXT_REFRESH_INDEX: "context:refreshIndex",
	CONTEXT_MEMORY_STATUS: "context:memoryStatus",
	CONTEXT_SEARCH_MEMORIES: "context:searchMemories",
	CONTEXT_GET_MEMORIES: "context:getMemories",

	// Environment configuration
	ENV_GET: "env:get",
	ENV_UPDATE: "env:update",
	ENV_CHECK_CLAUDE_AUTH: "env:checkClaudeAuth",
	ENV_INVOKE_CLAUDE_SETUP: "env:invokeClaudeSetup",

	// Ideation operations
	IDEATION_GET: "ideation:get",
	IDEATION_GENERATE: "ideation:generate",
	IDEATION_REFRESH: "ideation:refresh",
	IDEATION_STOP: "ideation:stop",
	IDEATION_UPDATE_IDEA: "ideation:updateIdea",
	IDEATION_CONVERT_TO_TASK: "ideation:convertToTask",
	IDEATION_DISMISS: "ideation:dismiss",
	IDEATION_DISMISS_ALL: "ideation:dismissAll",
	IDEATION_ARCHIVE: "ideation:archive",
	IDEATION_DELETE: "ideation:delete",
	IDEATION_DELETE_MULTIPLE: "ideation:deleteMultiple",

	// Ideation events (main -> renderer)
	IDEATION_PROGRESS: "ideation:progress",
	IDEATION_LOG: "ideation:log",
	IDEATION_COMPLETE: "ideation:complete",
	IDEATION_ERROR: "ideation:error",
	IDEATION_STOPPED: "ideation:stopped",
	IDEATION_TYPE_COMPLETE: "ideation:typeComplete",
	IDEATION_TYPE_FAILED: "ideation:typeFailed",

	// Linear integration
	LINEAR_GET_TEAMS: "linear:getTeams",
	LINEAR_GET_PROJECTS: "linear:getProjects",
	LINEAR_GET_ISSUES: "linear:getIssues",
	LINEAR_IMPORT_ISSUES: "linear:importIssues",
	LINEAR_CHECK_CONNECTION: "linear:checkConnection",

	// Azure DevOps integration
	AZURE_DEVOPS_GET_PROJECTS: "azureDevOps:getProjects",
	AZURE_DEVOPS_GET_WORK_ITEMS: "azureDevOps:getWorkItems",
	AZURE_DEVOPS_GET_WORK_ITEM: "azureDevOps:getWorkItem",
	AZURE_DEVOPS_IMPORT_WORK_ITEMS: "azureDevOps:importWorkItems",
	AZURE_DEVOPS_CHECK_CONNECTION: "azureDevOps:checkConnection",
	AZURE_DEVOPS_LIST_REPOSITORIES: "azureDevOps:listRepositories",
	AZURE_DEVOPS_DETECT_REPOSITORY: "azureDevOps:detectRepository",
	AZURE_DEVOPS_SYNC_TASK_AC: "azureDevOps:syncTaskAC",
	AZURE_DEVOPS_HYDRATE_TASK_DISPLAY: "azureDevOps:hydrateTaskDisplay",

	// Azure DevOps PR Review
	AZURE_DEVOPS_PR_REVIEW: "azureDevOps:prReview",
	AZURE_DEVOPS_PR_GET_REVIEW: "azureDevOps:prGetReview",
	AZURE_DEVOPS_PR_REVIEW_CANCEL: "azureDevOps:prReviewCancel",
	AZURE_DEVOPS_PR_POST_COMMENT: "azureDevOps:prPostComment",

	// Jira integration
	JIRA_GET_ISSUES: "jira:getIssues",
	JIRA_GET_ISSUE: "jira:getIssue",
	JIRA_CHECK_CONNECTION: "jira:checkConnection",
	JIRA_TEST_CONNECTION: "jira:testConnection",

	// GitHub integration
	GITHUB_GET_REPOSITORIES: "github:getRepositories",
	GITHUB_GET_ISSUES: "github:getIssues",
	GITHUB_GET_ISSUE: "github:getIssue",
	GITHUB_GET_ISSUE_COMMENTS: "github:getIssueComments",
	GITHUB_CHECK_CONNECTION: "github:checkConnection",
	GITHUB_INVESTIGATE_ISSUE: "github:investigateIssue",
	GITHUB_IMPORT_ISSUES: "github:importIssues",
	GITHUB_CREATE_RELEASE: "github:createRelease",

	// GitHub OAuth (gh CLI authentication)
	GITHUB_CHECK_CLI: "github:checkCli",
	GITHUB_CHECK_AUTH: "github:checkAuth",
	GITHUB_START_AUTH: "github:startAuth",
	GITHUB_GET_TOKEN: "github:getToken",
	GITHUB_GET_USER: "github:getUser",
	GITHUB_LIST_USER_REPOS: "github:listUserRepos",
	GITHUB_DETECT_REPO: "github:detectRepo",
	GITHUB_GET_BRANCHES: "github:getBranches",
	GITHUB_CREATE_REPO: "github:createRepo",
	GITHUB_ADD_REMOTE: "github:addRemote",
	GITHUB_LIST_ORGS: "github:listOrgs",

	// GitHub OAuth events (main -> renderer) - for streaming device code during auth
	GITHUB_AUTH_DEVICE_CODE: "github:authDeviceCode",
	GITHUB_AUTH_CHANGED: "github:authChanged", // Event: GitHub auth state changed (account swap)

	// GitHub events (main -> renderer)
	GITHUB_INVESTIGATION_PROGRESS: "github:investigationProgress",
	GITHUB_INVESTIGATION_COMPLETE: "github:investigationComplete",
	GITHUB_INVESTIGATION_ERROR: "github:investigationError",

	// GitLab integration
	GITLAB_GET_PROJECTS: "gitlab:getProjects",
	GITLAB_GET_ISSUES: "gitlab:getIssues",
	GITLAB_GET_ISSUE: "gitlab:getIssue",
	GITLAB_GET_ISSUE_NOTES: "gitlab:getIssueNotes",
	GITLAB_CHECK_CONNECTION: "gitlab:checkConnection",
	GITLAB_INVESTIGATE_ISSUE: "gitlab:investigateIssue",
	GITLAB_IMPORT_ISSUES: "gitlab:importIssues",
	GITLAB_CREATE_RELEASE: "gitlab:createRelease",

	// GitLab Merge Requests (equivalent to GitHub PRs)
	GITLAB_GET_MERGE_REQUESTS: "gitlab:getMergeRequests",
	GITLAB_GET_MERGE_REQUEST: "gitlab:getMergeRequest",
	GITLAB_CREATE_MERGE_REQUEST: "gitlab:createMergeRequest",
	GITLAB_UPDATE_MERGE_REQUEST: "gitlab:updateMergeRequest",

	// GitLab OAuth (glab CLI authentication)
	GITLAB_CHECK_CLI: "gitlab:checkCli",
	GITLAB_INSTALL_CLI: "gitlab:installCli",
	GITLAB_CHECK_AUTH: "gitlab:checkAuth",
	GITLAB_START_AUTH: "gitlab:startAuth",
	GITLAB_GET_TOKEN: "gitlab:getToken",
	GITLAB_GET_USER: "gitlab:getUser",
	GITLAB_LIST_USER_PROJECTS: "gitlab:listUserProjects",
	GITLAB_DETECT_PROJECT: "gitlab:detectProject",
	GITLAB_GET_BRANCHES: "gitlab:getBranches",
	GITLAB_CREATE_PROJECT: "gitlab:createProject",
	GITLAB_ADD_REMOTE: "gitlab:addRemote",
	GITLAB_LIST_GROUPS: "gitlab:listGroups",

	// GitLab events (main -> renderer)
	GITLAB_INVESTIGATION_PROGRESS: "gitlab:investigationProgress",
	GITLAB_INVESTIGATION_COMPLETE: "gitlab:investigationComplete",
	GITLAB_INVESTIGATION_ERROR: "gitlab:investigationError",

	// GitLab MR Review operations
	GITLAB_MR_GET_DIFF: "gitlab:mr:getDiff",
	GITLAB_MR_REVIEW: "gitlab:mr:review",
	GITLAB_MR_REVIEW_CANCEL: "gitlab:mr:reviewCancel",
	GITLAB_MR_GET_REVIEW: "gitlab:mr:getReview",
	GITLAB_MR_FOLLOWUP_REVIEW: "gitlab:mr:followupReview",
	GITLAB_MR_POST_REVIEW: "gitlab:mr:postReview",
	GITLAB_MR_POST_NOTE: "gitlab:mr:postNote",
	GITLAB_MR_MERGE: "gitlab:mr:merge",
	GITLAB_MR_ASSIGN: "gitlab:mr:assign",
	GITLAB_MR_APPROVE: "gitlab:mr:approve",
	GITLAB_MR_CHECK_NEW_COMMITS: "gitlab:mr:checkNewCommits",

	// GitLab MR Review events (main -> renderer)
	GITLAB_MR_REVIEW_PROGRESS: "gitlab:mr:reviewProgress",
	GITLAB_MR_REVIEW_COMPLETE: "gitlab:mr:reviewComplete",
	GITLAB_MR_REVIEW_ERROR: "gitlab:mr:reviewError",

	// GitLab Auto-Fix operations
	GITLAB_AUTOFIX_START: "gitlab:autofix:start",
	GITLAB_AUTOFIX_STOP: "gitlab:autofix:stop",
	GITLAB_AUTOFIX_GET_QUEUE: "gitlab:autofix:getQueue",
	GITLAB_AUTOFIX_CHECK_LABELS: "gitlab:autofix:checkLabels",
	GITLAB_AUTOFIX_CHECK_NEW: "gitlab:autofix:checkNew",
	GITLAB_AUTOFIX_GET_CONFIG: "gitlab:autofix:getConfig",
	GITLAB_AUTOFIX_SAVE_CONFIG: "gitlab:autofix:saveConfig",
	GITLAB_AUTOFIX_BATCH: "gitlab:autofix:batch",
	GITLAB_AUTOFIX_GET_BATCHES: "gitlab:autofix:getBatches",

	// GitLab Auto-Fix events (main -> renderer)
	GITLAB_AUTOFIX_PROGRESS: "gitlab:autofix:progress",
	GITLAB_AUTOFIX_COMPLETE: "gitlab:autofix:complete",
	GITLAB_AUTOFIX_ERROR: "gitlab:autofix:error",
	GITLAB_AUTOFIX_BATCH_PROGRESS: "gitlab:autofix:batchProgress",
	GITLAB_AUTOFIX_BATCH_COMPLETE: "gitlab:autofix:batchComplete",
	GITLAB_AUTOFIX_BATCH_ERROR: "gitlab:autofix:batchError",

	// GitLab Issue Analysis Preview (proactive batch workflow)
	GITLAB_AUTOFIX_ANALYZE_PREVIEW: "gitlab:autofix:analyzePreview",
	GITLAB_AUTOFIX_ANALYZE_PREVIEW_PROGRESS:
		"gitlab:autofix:analyzePreviewProgress",
	GITLAB_AUTOFIX_ANALYZE_PREVIEW_COMPLETE:
		"gitlab:autofix:analyzePreviewComplete",
	GITLAB_AUTOFIX_ANALYZE_PREVIEW_ERROR: "gitlab:autofix:analyzePreviewError",
	GITLAB_AUTOFIX_APPROVE_BATCHES: "gitlab:autofix:approveBatches",

	// GitLab Issue Triage operations
	GITLAB_TRIAGE_RUN: "gitlab:triage:run",
	GITLAB_TRIAGE_GET_RESULTS: "gitlab:triage:getResults",
	GITLAB_TRIAGE_APPLY_LABELS: "gitlab:triage:applyLabels",
	GITLAB_TRIAGE_GET_CONFIG: "gitlab:triage:getConfig",
	GITLAB_TRIAGE_SAVE_CONFIG: "gitlab:triage:saveConfig",

	// GitLab Issue Triage events (main -> renderer)
	GITLAB_TRIAGE_PROGRESS: "gitlab:triage:progress",
	GITLAB_TRIAGE_COMPLETE: "gitlab:triage:complete",
	GITLAB_TRIAGE_ERROR: "gitlab:triage:error",

	// GitHub Auto-Fix operations
	GITHUB_AUTOFIX_START: "github:autofix:start",
	GITHUB_AUTOFIX_STOP: "github:autofix:stop",
	GITHUB_AUTOFIX_GET_QUEUE: "github:autofix:getQueue",
	GITHUB_AUTOFIX_CHECK_LABELS: "github:autofix:checkLabels",
	GITHUB_AUTOFIX_CHECK_NEW: "github:autofix:checkNew",
	GITHUB_AUTOFIX_GET_CONFIG: "github:autofix:getConfig",
	GITHUB_AUTOFIX_SAVE_CONFIG: "github:autofix:saveConfig",
	GITHUB_AUTOFIX_BATCH: "github:autofix:batch",
	GITHUB_AUTOFIX_GET_BATCHES: "github:autofix:getBatches",

	// GitHub Auto-Fix events (main -> renderer)
	GITHUB_AUTOFIX_PROGRESS: "github:autofix:progress",
	GITHUB_AUTOFIX_COMPLETE: "github:autofix:complete",
	GITHUB_AUTOFIX_ERROR: "github:autofix:error",
	GITHUB_AUTOFIX_BATCH_PROGRESS: "github:autofix:batchProgress",
	GITHUB_AUTOFIX_BATCH_COMPLETE: "github:autofix:batchComplete",
	GITHUB_AUTOFIX_BATCH_ERROR: "github:autofix:batchError",

	// GitHub Issue Analysis Preview (proactive batch workflow)
	GITHUB_AUTOFIX_ANALYZE_PREVIEW: "github:autofix:analyzePreview",
	GITHUB_AUTOFIX_ANALYZE_PREVIEW_PROGRESS:
		"github:autofix:analyzePreviewProgress",
	GITHUB_AUTOFIX_ANALYZE_PREVIEW_COMPLETE:
		"github:autofix:analyzePreviewComplete",
	GITHUB_AUTOFIX_ANALYZE_PREVIEW_ERROR: "github:autofix:analyzePreviewError",
	GITHUB_AUTOFIX_APPROVE_BATCHES: "github:autofix:approveBatches",

	// GitHub PR Review operations
	GITHUB_PR_LIST: "github:pr:list",
	GITHUB_PR_LIST_MORE: "github:pr:listMore", // Load more PRs (pagination)
	GITHUB_PR_GET: "github:pr:get",
	GITHUB_PR_GET_DIFF: "github:pr:getDiff",
	GITHUB_PR_REVIEW: "github:pr:review",
	GITHUB_PR_REVIEW_CANCEL: "github:pr:reviewCancel",
	GITHUB_PR_GET_REVIEW: "github:pr:getReview",
	GITHUB_PR_GET_REVIEWS_BATCH: "github:pr:getReviewsBatch", // Batch load reviews for multiple PRs
	GITHUB_PR_POST_REVIEW: "github:pr:postReview",
	GITHUB_PR_DELETE_REVIEW: "github:pr:deleteReview",
	GITHUB_PR_MERGE: "github:pr:merge",
	GITHUB_PR_ASSIGN: "github:pr:assign",
	GITHUB_PR_POST_COMMENT: "github:pr:postComment",
	GITHUB_PR_FIX: "github:pr:fix",
	GITHUB_PR_FOLLOWUP_REVIEW: "github:pr:followupReview",
	GITHUB_PR_CHECK_NEW_COMMITS: "github:pr:checkNewCommits",
	GITHUB_PR_CHECK_MERGE_READINESS: "github:pr:checkMergeReadiness",
	GITHUB_PR_MARK_REVIEW_POSTED: "github:pr:markReviewPosted",
	GITHUB_PR_UPDATE_BRANCH: "github:pr:updateBranch",

	// GitHub PR Review events (main -> renderer)
	GITHUB_PR_REVIEW_PROGRESS: "github:pr:reviewProgress",
	GITHUB_PR_REVIEW_COMPLETE: "github:pr:reviewComplete",
	GITHUB_PR_REVIEW_ERROR: "github:pr:reviewError",

	// GitHub PR Logs (for viewing AI review logs)
	GITHUB_PR_GET_LOGS: "github:pr:getLogs",

	// Universal PR Details (supports both GitHub and Azure DevOps)
	PR_DETAILS: "pr:details",

	// GitHub PR Memory operations (saves review insights to memory layer)
	GITHUB_PR_MEMORY_GET: "github:pr:memory:get", // Get PR review memories
	GITHUB_PR_MEMORY_SEARCH: "github:pr:memory:search", // Search PR review memories

	// GitHub Workflow Approval (for fork PRs)
	GITHUB_WORKFLOWS_AWAITING_APPROVAL: "github:workflows:awaitingApproval",
	GITHUB_WORKFLOW_APPROVE: "github:workflow:approve",

	// GitHub Issue Triage operations
	GITHUB_TRIAGE_RUN: "github:triage:run",
	GITHUB_TRIAGE_GET_RESULTS: "github:triage:getResults",
	GITHUB_TRIAGE_APPLY_LABELS: "github:triage:applyLabels",
	GITHUB_TRIAGE_GET_CONFIG: "github:triage:getConfig",
	GITHUB_TRIAGE_SAVE_CONFIG: "github:triage:saveConfig",

	// GitHub Issue Triage events (main -> renderer)
	GITHUB_TRIAGE_PROGRESS: "github:triage:progress",
	GITHUB_TRIAGE_COMPLETE: "github:triage:complete",
	GITHUB_TRIAGE_ERROR: "github:triage:error",

	// Memory Infrastructure status (LadybugDB - no Docker required)
	MEMORY_STATUS: "memory:status",
	MEMORY_LIST_DATABASES: "memory:listDatabases",
	MEMORY_TEST_CONNECTION: "memory:testConnection",

	// Graphiti validation
	GRAPHITI_VALIDATE_LLM: "graphiti:validateLlm",
	GRAPHITI_TEST_CONNECTION: "graphiti:testConnection",

	// Ollama model detection and management
	OLLAMA_CHECK_STATUS: "ollama:checkStatus",
	OLLAMA_CHECK_INSTALLED: "ollama:checkInstalled",
	OLLAMA_INSTALL: "ollama:install",
	OLLAMA_START_SERVER: "ollama:startServer",
	OLLAMA_ENSURE: "ollama:ensure",
	OLLAMA_INSTALL_PROGRESS: "ollama:installProgress",
	OLLAMA_LIST_MODELS: "ollama:listModels",
	OLLAMA_LIST_EMBEDDING_MODELS: "ollama:listEmbeddingModels",
	OLLAMA_PULL_MODEL: "ollama:pullModel",
	OLLAMA_PULL_PROGRESS: "ollama:pullProgress",
	OLLAMA_DELETE_MODEL: "ollama:deleteModel",

	// WorkPilot AI source environment configuration
	AUTOBUILD_SOURCE_ENV_GET: "autobuild:source:env:get",
	AUTOBUILD_SOURCE_ENV_UPDATE: "autobuild:source:env:update",
	AUTOBUILD_SOURCE_ENV_CHECK_TOKEN: "autobuild:source:env:checkToken",

	// Changelog operations
	CHANGELOG_GET_DONE_TASKS: "changelog:getDoneTasks",
	CHANGELOG_LOAD_TASK_SPECS: "changelog:loadTaskSpecs",
	CHANGELOG_GENERATE: "changelog:generate",
	CHANGELOG_SAVE: "changelog:save",
	CHANGELOG_READ_EXISTING: "changelog:readExisting",
	CHANGELOG_SUGGEST_VERSION: "changelog:suggestVersion",
	CHANGELOG_SUGGEST_VERSION_FROM_COMMITS: "changelog:suggestVersionFromCommits",

	// Changelog git operations (for git-based changelog generation)
	CHANGELOG_GET_BRANCHES: "changelog:getBranches",
	CHANGELOG_GET_TAGS: "changelog:getTags",
	CHANGELOG_GET_COMMITS_PREVIEW: "changelog:getCommitsPreview",
	CHANGELOG_SAVE_IMAGE: "changelog:saveImage",
	CHANGELOG_READ_LOCAL_IMAGE: "changelog:readLocalImage",

	// Changelog events (main -> renderer)
	CHANGELOG_GENERATION_PROGRESS: "changelog:generationProgress",
	CHANGELOG_GENERATION_COMPLETE: "changelog:generationComplete",
	CHANGELOG_GENERATION_ERROR: "changelog:generationError",

	// Insights operations
	INSIGHTS_GET_SESSION: "insights:getSession",
	INSIGHTS_SEND_MESSAGE: "insights:sendMessage",
	INSIGHTS_CLEAR_SESSION: "insights:clearSession",
	INSIGHTS_CREATE_TASK: "insights:createTask",
	INSIGHTS_LIST_SESSIONS: "insights:listSessions",
	INSIGHTS_NEW_SESSION: "insights:newSession",
	INSIGHTS_SWITCH_SESSION: "insights:switchSession",
	INSIGHTS_DELETE_SESSION: "insights:deleteSession",
	INSIGHTS_RENAME_SESSION: "insights:renameSession",
	INSIGHTS_UPDATE_MODEL_CONFIG: "insights:updateModelConfig",

	// Insights events (main -> renderer)
	INSIGHTS_STREAM_CHUNK: "insights:streamChunk",
	INSIGHTS_STATUS: "insights:status",
	INSIGHTS_ERROR: "insights:error",
	INSIGHTS_SESSION_UPDATED: "insights:sessionUpdated", // Event: session updated (main -> renderer)

	// File explorer operations
	FILE_EXPLORER_LIST: "fileExplorer:list",
	FILE_EXPLORER_READ: "fileExplorer:read",
	FILE_EXPLORER_SAVE: "fileExplorer:save", // Save JSON files
	FILE_EXPLORER_GET_USER_HOME: "fileExplorer:getUserHome",

	// API Explorer — project route scanning
	API_EXPLORER_SCAN_ROUTES: "apiExplorer:scanRoutes",
	// API Explorer — HTTP proxy (bypasses renderer CSP)
	API_EXPLORER_PROXY_REQUEST: "apiExplorer:proxyRequest",

	// Git operations
	GIT_GET_BRANCHES: "git:getBranches",
	GIT_GET_BRANCHES_WITH_INFO: "git:getBranchesWithInfo",
	GIT_GET_CURRENT_BRANCH: "git:getCurrentBranch",
	GIT_DETECT_MAIN_BRANCH: "git:detectMainBranch",
	GIT_CHECK_STATUS: "git:checkStatus",
	GIT_DETECT_PROVIDER: "git:detectProvider",
	GIT_INITIALIZE: "git:initialize",

	// LLM Provider operations
	PROVIDER_SELECT: "provider:select",
	PROVIDER_GET_SELECTED: "provider:getSelected",

	// App auto-update operations
	APP_UPDATE_CHECK: "app-update:check",
	APP_UPDATE_DOWNLOAD: "app-update:download",
	APP_UPDATE_DOWNLOAD_STABLE: "app-update:download-stable", // Download stable version (for downgrade from beta)
	APP_UPDATE_INSTALL: "app-update:install",
	APP_UPDATE_GET_VERSION: "app-update:get-version",
	APP_UPDATE_GET_DOWNLOADED: "app-update:get-downloaded", // Get downloaded update info (for showing Install button on Settings open)

	// App auto-update events (main -> renderer)
	APP_UPDATE_AVAILABLE: "app-update:available",
	APP_UPDATE_DOWNLOADED: "app-update:downloaded",
	APP_UPDATE_PROGRESS: "app-update:progress",
	APP_UPDATE_ERROR: "app-update:error",
	APP_UPDATE_STABLE_DOWNGRADE: "app-update:stable-downgrade", // Stable version available for downgrade from beta
	APP_UPDATE_READONLY_VOLUME: "app-update:readonly-volume", // App running from read-only volume (DMG), needs to be moved

	// Release operations
	RELEASE_SUGGEST_VERSION: "release:suggestVersion",
	RELEASE_CREATE: "release:create",
	RELEASE_PREFLIGHT: "release:preflight",
	RELEASE_GET_VERSIONS: "release:getVersions",

	// Release events (main -> renderer)
	RELEASE_PROGRESS: "release:progress",

	// Debug operations
	DEBUG_GET_INFO: "debug:getInfo",
	DEBUG_OPEN_LOGS_FOLDER: "debug:openLogsFolder",
	DEBUG_COPY_DEBUG_INFO: "debug:copyDebugInfo",
	DEBUG_GET_RECENT_ERRORS: "debug:getRecentErrors",
	DEBUG_LIST_LOG_FILES: "debug:listLogFiles",
	DEBUG_SIMULATE_RATE_LIMIT: "debug:simulateRateLimit", // Simulate rate limit for testing auto-swap

	// Claude Code CLI operations
	CLAUDE_CODE_CHECK_VERSION: "claudeCode:checkVersion",
	CLAUDE_CODE_INSTALL: "claudeCode:install",
	CLAUDE_CODE_INSTALL_SILENT: "claudeCode:installSilent",
	CLAUDE_CODE_GET_VERSIONS: "claudeCode:getVersions",
	CLAUDE_CODE_INSTALL_VERSION: "claudeCode:installVersion",
	CLAUDE_CODE_GET_INSTALLATIONS: "claudeCode:getInstallations",
	CLAUDE_CODE_SET_ACTIVE_PATH: "claudeCode:setActivePath",

	// Copilot CLI operations (mirrors Claude Code CLI pattern)
	COPILOT_CLI_CHECK_VERSION: "copilotCli:checkVersion",
	COPILOT_CLI_INSTALL: "copilotCli:install",
	COPILOT_CLI_INSTALL_SILENT: "copilotCli:installSilent",
	COPILOT_CLI_GET_INSTALLATIONS: "copilotCli:getInstallations",
	COPILOT_CLI_SET_ACTIVE_PATH: "copilotCli:setActivePath",
	COPILOT_CLI_CHECK_AUTH: "copilotCli:checkAuth",
	COPILOT_CLI_START_AUTH: "copilotCli:startAuth",
	COPILOT_CLI_GET_STATUS: "copilotCli:getStatus", // Get GitHub CLI status for AuthStatusIndicator

	// Copilot OAuth operations (web-based authentication)
	COPILOT_OAUTH_START: "copilotOAuth:start",
	COPILOT_OAUTH_CALLBACK: "copilotOAuth:callback",
	COPILOT_OAUTH_STATUS: "copilotOAuth:status",
	COPILOT_OAUTH_REVOKE: "copilotOAuth:revoke",

	// MCP Server health checks
	MCP_CHECK_HEALTH: "mcp:checkHealth", // Quick connectivity check
	MCP_TEST_CONNECTION: "mcp:testConnection", // Full MCP protocol test

	// MCP Marketplace operations
	MCP_MARKETPLACE_GET_CATALOG: "mcpMarketplace:getCatalog", // Get full server catalog
	MCP_MARKETPLACE_GET_SERVER: "mcpMarketplace:getServer", // Get single server details
	MCP_MARKETPLACE_INSTALL: "mcpMarketplace:install", // Install a server
	MCP_MARKETPLACE_UNINSTALL: "mcpMarketplace:uninstall", // Uninstall a server
	MCP_MARKETPLACE_GET_INSTALLED: "mcpMarketplace:getInstalled", // Get installed servers
	MCP_MARKETPLACE_UPDATE_SERVER: "mcpMarketplace:updateServer", // Update server config
	MCP_MARKETPLACE_TOGGLE_SERVER: "mcpMarketplace:toggleServer", // Enable/disable server
	MCP_MARKETPLACE_HEALTH_CHECK: "mcpMarketplace:healthCheck", // Health check installed server
	MCP_MARKETPLACE_HEALTH_CHECK_ALL: "mcpMarketplace:healthCheckAll", // Health check all installed
	MCP_MARKETPLACE_SAVE_BUILDER: "mcpMarketplace:saveBuilder", // Save builder project
	MCP_MARKETPLACE_GET_BUILDER_PROJECTS: "mcpMarketplace:getBuilderProjects", // List builder projects
	MCP_MARKETPLACE_DELETE_BUILDER: "mcpMarketplace:deleteBuilder", // Delete builder project
	MCP_MARKETPLACE_EXPORT_BUILDER: "mcpMarketplace:exportBuilder", // Export builder as MCP server

	// Hugging Face Hub discovery (via the official HF MCP server)
	HUGGINGFACE_SEARCH_MODELS: "huggingface:searchModels", // Live model search on the Hub

	// Sentry error reporting
	SENTRY_STATE_CHANGED: "sentry:state-changed", // Notify main process when setting changes
	GET_SENTRY_DSN: "sentry:get-dsn", // Get DSN from main process (env var)
	GET_SENTRY_CONFIG: "sentry:get-config", // Get full Sentry config (DSN + sample rates)

	// Spell check
	SPELLCHECK_SET_LANGUAGES: "spellcheck:setLanguages", // Set spell check language (syncs with i18n)

	// Screenshot capture
	SCREENSHOT_GET_SOURCES: "screenshot:getSources", // Get available screens/windows
	SCREENSHOT_CAPTURE: "screenshot:capture", // Capture screenshot from source

	// Queue routing (rate limit recovery)
	QUEUE_GET_RUNNING_TASKS_BY_PROFILE: "queue:getRunningTasksByProfile",
	QUEUE_GET_BEST_PROFILE_FOR_TASK: "queue:getBestProfileForTask",
	QUEUE_ASSIGN_PROFILE_TO_TASK: "queue:assignProfileToTask",
	QUEUE_UPDATE_TASK_SESSION: "queue:updateTaskSession",
	QUEUE_GET_TASK_SESSION: "queue:getTaskSession",

	// Queue routing events (main -> renderer)
	QUEUE_PROFILE_SWAPPED: "queue:profileSwapped", // Task switched to different profile
	QUEUE_SESSION_CAPTURED: "queue:sessionCaptured", // Session ID captured from running task
	QUEUE_BLOCKED_NO_PROFILES: "queue:blockedNoProfiles", // All profiles unavailable

	// Prompt Optimizer operations
	PROMPT_OPTIMIZER_OPTIMIZE: "promptOptimizer:optimize", // Request prompt optimization
	PROMPT_OPTIMIZER_STREAM_CHUNK: "promptOptimizer:streamChunk", // Streaming text chunk (main -> renderer)
	PROMPT_OPTIMIZER_STATUS: "promptOptimizer:status", // Status update (main -> renderer)
	PROMPT_OPTIMIZER_ERROR: "promptOptimizer:error", // Error event (main -> renderer)
	PROMPT_OPTIMIZER_COMPLETE: "promptOptimizer:complete", // Optimization complete (main -> renderer)

	// Learning Loop operations
	LEARNING_LOOP_GET_PATTERNS: "learningLoop:getPatterns",
	LEARNING_LOOP_GET_SUMMARY: "learningLoop:getSummary",
	LEARNING_LOOP_RUN_ANALYSIS: "learningLoop:runAnalysis",
	LEARNING_LOOP_STOP_ANALYSIS: "learningLoop:stopAnalysis",
	LEARNING_LOOP_DELETE_PATTERN: "learningLoop:deletePattern",
	LEARNING_LOOP_TOGGLE_PATTERN: "learningLoop:togglePattern",

	// Learning Loop events (main -> renderer)
	LEARNING_LOOP_STATUS: "learningLoop:status",
	LEARNING_LOOP_STREAM_CHUNK: "learningLoop:streamChunk",
	LEARNING_LOOP_COMPLETE: "learningLoop:complete",
	LEARNING_LOOP_ERROR: "learningLoop:error",

	// Multi-Repo Orchestration operations
	MULTI_REPO_CREATE: "multiRepo:create",
	MULTI_REPO_GET: "multiRepo:get",
	MULTI_REPO_LIST: "multiRepo:list",
	MULTI_REPO_START: "multiRepo:start",
	MULTI_REPO_STOP: "multiRepo:stop",
	MULTI_REPO_GET_STATUS: "multiRepo:getStatus",

	// Multi-Repo events (main -> renderer)
	MULTI_REPO_PROGRESS: "multiRepo:progress",
	MULTI_REPO_REPO_START: "multiRepo:repoStart",
	MULTI_REPO_REPO_COMPLETE: "multiRepo:repoComplete",
	MULTI_REPO_COMPLETE: "multiRepo:complete",
	MULTI_REPO_ERROR: "multiRepo:error",
	MULTI_REPO_BREAKING_CHANGE: "multiRepo:breakingChange",
	MULTI_REPO_GRAPH: "multiRepo:graph",

	// Self-Healing Codebase + Incident Responder
	SELF_HEALING_GET_DASHBOARD: "selfHealing:getDashboard",
	SELF_HEALING_GET_INCIDENTS: "selfHealing:getIncidents",
	SELF_HEALING_GET_OPERATIONS: "selfHealing:getOperations",
	SELF_HEALING_GET_FRAGILITY: "selfHealing:getFragility",
	SELF_HEALING_CICD_ENABLE: "selfHealing:cicd:enable",
	SELF_HEALING_CICD_DISABLE: "selfHealing:cicd:disable",
	SELF_HEALING_CICD_CONFIG: "selfHealing:cicd:config",
	SELF_HEALING_PRODUCTION_CONNECT: "selfHealing:production:connect",
	SELF_HEALING_PRODUCTION_DISCONNECT: "selfHealing:production:disconnect",
	SELF_HEALING_PRODUCTION_CONFIG: "selfHealing:production:config",
	SELF_HEALING_PROACTIVE_SCAN: "selfHealing:proactive:scan",
	SELF_HEALING_PROACTIVE_CONFIG: "selfHealing:proactive:config",
	SELF_HEALING_TRIGGER_FIX: "selfHealing:triggerFix",
	SELF_HEALING_CANCEL_OPERATION: "selfHealing:cancelOperation",
	SELF_HEALING_DISMISS_INCIDENT: "selfHealing:dismissIncident",
	SELF_HEALING_RETRY_INCIDENT: "selfHealing:retryIncident",
	// Events (main -> renderer)
	SELF_HEALING_INCIDENT_DETECTED: "selfHealing:incidentDetected",
	SELF_HEALING_OPERATION_PROGRESS: "selfHealing:operationProgress",
	SELF_HEALING_OPERATION_COMPLETE: "selfHealing:operationComplete",

	// Browser Agent
	BROWSER_AGENT_GET_DASHBOARD: "browserAgent:getDashboard",
	BROWSER_AGENT_NAVIGATE: "browserAgent:navigate",
	BROWSER_AGENT_CAPTURE_SCREENSHOT: "browserAgent:captureScreenshot",
	BROWSER_AGENT_GET_SCREENSHOT_IMAGE: "browserAgent:getScreenshotImage",
	BROWSER_AGENT_SET_BASELINE: "browserAgent:setBaseline",
	BROWSER_AGENT_LIST_BASELINES: "browserAgent:listBaselines",
	BROWSER_AGENT_COMPARE: "browserAgent:compare",
	BROWSER_AGENT_DELETE_BASELINE: "browserAgent:deleteBaseline",
	BROWSER_AGENT_RUN_TESTS: "browserAgent:runTests",
	// Browser Agent events (main -> renderer)
	BROWSER_AGENT_PROGRESS: "browserAgent:progress",
	BROWSER_AGENT_TEST_COMPLETE: "browserAgent:testComplete",
	BROWSER_AGENT_SCREENSHOT_READY: "browserAgent:screenshotReady",

	// Architecture Visualizer
	ARCHITECTURE_VISUALIZER_GENERATE: "architectureVisualizer:generate",
	ARCHITECTURE_VISUALIZER_CANCEL: "architectureVisualizer:cancel",
	ARCHITECTURE_VISUALIZER_CONFIGURE: "architectureVisualizer:configure",
	// Architecture Visualizer events (main -> renderer)
	ARCHITECTURE_VISUALIZER_STATUS: "architectureVisualizer:status",
	ARCHITECTURE_VISUALIZER_STREAM_CHUNK: "architectureVisualizer:streamChunk",
	ARCHITECTURE_VISUALIZER_ERROR: "architectureVisualizer:error",
	ARCHITECTURE_VISUALIZER_COMPLETE: "architectureVisualizer:complete",

	// Code Migration Agent
	CODE_MIGRATION_START: "codeMigration:start",
	CODE_MIGRATION_CANCEL: "codeMigration:cancel",
	CODE_MIGRATION_CONFIGURE: "codeMigration:configure",
	// Code Migration events (main -> renderer)
	CODE_MIGRATION_STATUS: "codeMigration:status",
	CODE_MIGRATION_STREAM_CHUNK: "codeMigration:streamChunk",
	CODE_MIGRATION_ERROR: "codeMigration:error",
	CODE_MIGRATION_COMPLETE: "codeMigration:complete",
	CODE_MIGRATION_TASK_PROGRESS: "codeMigration:taskProgress",

	// Performance Profiler Agent
	PERFORMANCE_PROFILER_START: "performanceProfiler:start",
	PERFORMANCE_PROFILER_CANCEL: "performanceProfiler:cancel",
	PERFORMANCE_PROFILER_CONFIGURE: "performanceProfiler:configure",
	// Performance Profiler events (main -> renderer)
	PERFORMANCE_PROFILER_STATUS: "performanceProfiler:status",
	PERFORMANCE_PROFILER_STREAM_CHUNK: "performanceProfiler:streamChunk",
	PERFORMANCE_PROFILER_ERROR: "performanceProfiler:error",
	PERFORMANCE_PROFILER_COMPLETE: "performanceProfiler:complete",
	PERFORMANCE_PROFILER_IMPLEMENTATION_COMPLETE:
		"performanceProfiler:implementationComplete",

	// Documentation Agent
	DOCUMENTATION_AGENT_GENERATE: "documentationAgent:generate",
	DOCUMENTATION_AGENT_CANCEL: "documentationAgent:cancel",
	DOCUMENTATION_AGENT_CONFIGURE: "documentationAgent:configure",
	// Documentation Agent events (main -> renderer)
	DOCUMENTATION_AGENT_STATUS: "documentationAgent:status",
	DOCUMENTATION_AGENT_STREAM_CHUNK: "documentationAgent:streamChunk",
	DOCUMENTATION_AGENT_ERROR: "documentationAgent:error",
	DOCUMENTATION_AGENT_COMPLETE: "documentationAgent:complete",

	// Pipeline Generator (Feature 23) — AI-powered CI/CD pipeline generation
	PIPELINE_GENERATOR_GENERATE: "pipelineGenerator:generate",
	PIPELINE_GENERATOR_CANCEL: "pipelineGenerator:cancel",
	PIPELINE_GENERATOR_CONFIGURE: "pipelineGenerator:configure",
	// Pipeline Generator events (main -> renderer)
	PIPELINE_GENERATOR_STATUS: "pipelineGenerator:status",
	PIPELINE_GENERATOR_STREAM_CHUNK: "pipelineGenerator:streamChunk",
	PIPELINE_GENERATOR_ERROR: "pipelineGenerator:error",
	PIPELINE_GENERATOR_COMPLETE: "pipelineGenerator:complete",

	// AI Pair Programming (Feature 10) — Real parallel coordinated work
	PAIR_PROGRAMMING_START: "pairProgramming:start",
	PAIR_PROGRAMMING_STOP: "pairProgramming:stop",
	PAIR_PROGRAMMING_SEND_MESSAGE: "pairProgramming:sendMessage",
	PAIR_PROGRAMMING_GET_SESSION: "pairProgramming:getSession",
	// Pair Programming events (main -> renderer)
	PAIR_PROGRAMMING_STREAM_CHUNK: "pairProgramming:streamChunk",
	PAIR_PROGRAMMING_STATUS: "pairProgramming:status",
	PAIR_PROGRAMMING_AI_ACTION: "pairProgramming:aiAction",
	PAIR_PROGRAMMING_CONFLICT: "pairProgramming:conflict",
	PAIR_PROGRAMMING_ERROR: "pairProgramming:error",
	PAIR_PROGRAMMING_COMPLETE: "pairProgramming:complete",

	// Context Mesh — Cross-Project Intelligence
	CONTEXT_MESH_GET_PROJECTS: "contextMesh:getProjects",
	CONTEXT_MESH_REGISTER_PROJECT: "contextMesh:registerProject",
	CONTEXT_MESH_UNREGISTER_PROJECT: "contextMesh:unregisterProject",
	CONTEXT_MESH_GET_PATTERNS: "contextMesh:getPatterns",
	CONTEXT_MESH_DELETE_PATTERN: "contextMesh:deletePattern",
	CONTEXT_MESH_GET_HANDBOOK: "contextMesh:getHandbook",
	CONTEXT_MESH_DELETE_HANDBOOK_ENTRY: "contextMesh:deleteHandbookEntry",
	CONTEXT_MESH_GET_SKILL_TRANSFERS: "contextMesh:getSkillTransfers",
	CONTEXT_MESH_UPDATE_TRANSFER_STATUS: "contextMesh:updateTransferStatus",
	CONTEXT_MESH_GET_RECOMMENDATIONS: "contextMesh:getRecommendations",
	CONTEXT_MESH_UPDATE_RECOMMENDATION_STATUS:
		"contextMesh:updateRecommendationStatus",
	CONTEXT_MESH_GET_SUMMARY: "contextMesh:getSummary",
	CONTEXT_MESH_RUN_ANALYSIS: "contextMesh:runAnalysis",
	CONTEXT_MESH_STOP_ANALYSIS: "contextMesh:stopAnalysis",
	// Context Mesh events (main -> renderer)
	CONTEXT_MESH_STATUS: "contextMesh:status",
	CONTEXT_MESH_STREAM_CHUNK: "contextMesh:streamChunk",
	CONTEXT_MESH_COMPLETE: "contextMesh:complete",
	CONTEXT_MESH_ERROR: "contextMesh:error",

	// Team Knowledge Sync (Feature 31) — Shared Graphiti memory across team members
	TEAM_SYNC_GET_STATUS: "teamSync:getStatus",
	TEAM_SYNC_PUSH: "teamSync:push",
	TEAM_SYNC_PULL: "teamSync:pull",
	TEAM_SYNC_LIST_PEERS: "teamSync:listPeers",
	TEAM_SYNC_GET_PEER_EPISODES: "teamSync:getPeerEpisodes",
	TEAM_SYNC_CONFIGURE: "teamSync:configure",
	TEAM_SYNC_START_SERVER: "teamSync:startServer",
	TEAM_SYNC_STOP_SERVER: "teamSync:stopServer",
	// Team Sync events (main -> renderer)
	TEAM_SYNC_SERVER_STATUS: "teamSync:serverStatus",
	TEAM_SYNC_SYNC_PROGRESS: "teamSync:syncProgress",

	// Live Development Companion — Real-time pair programming
	LIVE_COMPANION_START: "liveCompanion:start",
	LIVE_COMPANION_STOP: "liveCompanion:stop",
	LIVE_COMPANION_GET_STATE: "liveCompanion:getState",
	LIVE_COMPANION_GET_SUGGESTIONS: "liveCompanion:getSuggestions",
	LIVE_COMPANION_DISMISS_SUGGESTION: "liveCompanion:dismissSuggestion",
	LIVE_COMPANION_APPLY_SUGGESTION: "liveCompanion:applySuggestion",
	LIVE_COMPANION_GET_TAKEOVERS: "liveCompanion:getTakeovers",
	LIVE_COMPANION_ACCEPT_TAKEOVER: "liveCompanion:acceptTakeover",
	LIVE_COMPANION_DECLINE_TAKEOVER: "liveCompanion:declineTakeover",
	LIVE_COMPANION_GET_CONFIG: "liveCompanion:getConfig",
	LIVE_COMPANION_UPDATE_CONFIG: "liveCompanion:updateConfig",
	// Live Companion events (main -> renderer)
	LIVE_COMPANION_STATE_CHANGED: "liveCompanion:stateChanged",
	LIVE_COMPANION_SUGGESTION: "liveCompanion:suggestion",
	LIVE_COMPANION_TAKEOVER_PROPOSAL: "liveCompanion:takeoverProposal",
	LIVE_COMPANION_FILE_CHANGE: "liveCompanion:fileChange",
	LIVE_COMPANION_ERROR: "liveCompanion:error",

	// Agent Time Travel — Temporal debugger for AI agents
	TIME_TRAVEL_GENERATE_CHECKPOINTS: "timeTravel:generateCheckpoints",
	TIME_TRAVEL_GET_CHECKPOINTS: "timeTravel:getCheckpoints",
	TIME_TRAVEL_GET_CHECKPOINT: "timeTravel:getCheckpoint",
	TIME_TRAVEL_ADD_CHECKPOINT: "timeTravel:addCheckpoint",
	TIME_TRAVEL_DELETE_CHECKPOINT: "timeTravel:deleteCheckpoint",
	TIME_TRAVEL_FORK_SESSION: "timeTravel:forkSession",
	TIME_TRAVEL_GET_FORK: "timeTravel:getFork",
	TIME_TRAVEL_GET_FORK_CONTEXT: "timeTravel:getForkContext",
	TIME_TRAVEL_LIST_FORKS: "timeTravel:listForks",
	TIME_TRAVEL_UPDATE_FORK_STATUS: "timeTravel:updateForkStatus",
	TIME_TRAVEL_DELETE_FORK: "timeTravel:deleteFork",
	TIME_TRAVEL_SCORE_DECISIONS: "timeTravel:scoreDecisions",
	TIME_TRAVEL_GET_DECISION_SCORES: "timeTravel:getDecisionScores",
	TIME_TRAVEL_GET_DECISION_HEATMAP: "timeTravel:getDecisionHeatmap",
	// Time Travel events (main -> renderer)
	TIME_TRAVEL_CHECKPOINTS_READY: "timeTravel:checkpointsReady",
	TIME_TRAVEL_FORK_STATUS_CHANGED: "timeTravel:forkStatusChanged",
	TIME_TRAVEL_ERROR: "timeTravel:error",

	// === Phase 3-5 backend modules (one HTTP-backed channel per module) ===
	// Longevity Score (#3.8)
	LONGEVITY_SCORE: "longevity:score",
	// Agent Health Monitor (#3.11)
	AGENT_HEALTH_RECORD: "agentHealth:record",
	AGENT_HEALTH_RECORD_BATCH: "agentHealth:recordBatch",
	AGENT_HEALTH_SCORE: "agentHealth:score",
	AGENT_HEALTH_SCORES: "agentHealth:scores",
	AGENT_HEALTH_RESET: "agentHealth:reset",
	// Adaptive Model Routing (#3.1)
	MODEL_ROUTER_ROUTE: "modelRouter:route",
	MODEL_ROUTER_COMPARE: "modelRouter:compare",
	// Domain-Specific Agents (#3.6)
	DOMAIN_AGENTS_LIST: "domainAgents:list",
	DOMAIN_AGENTS_PROFILE: "domainAgents:profile",
	DOMAIN_AGENTS_BUILD: "domainAgents:build",
	// CI/CD Anomaly Detective (#3.4)
	CICD_ANOMALY_SCAN: "cicdAnomaly:scan",
	CICD_ANOMALY_ANALYSE: "cicdAnomaly:analyse",
	// License Governance (#3.7)
	LICENSE_GOV_SCAN: "licenseGov:scan",
	LICENSE_GOV_CLASSIFY: "licenseGov:classify",
	// Architecture Drift (#3.9)
	ARCH_DRIFT_SCAN: "archDrift:scan",
	ARCH_DRIFT_SAVE_BASELINE: "archDrift:saveBaseline",
	ARCH_DRIFT_COMPARE: "archDrift:compare",
	// Generational Testing (#3.10)
	GEN_TESTS_LIST: "genTests:list",
	GEN_TESTS_CAPTURE: "genTests:capture",
	GEN_TESTS_COMPARE: "genTests:compare",
	GEN_TESTS_DELETE: "genTests:delete",
	// i18n Auto-Scaling (#3.12)
	I18N_SCALER_DIFF: "i18nScaler:diff",
	I18N_SCALER_SKELETON: "i18nScaler:skeleton",
	I18N_SCALER_REPORT_FROM_DIR: "i18nScaler:reportFromDir",
	// Cognitive Context Optimizer (#3.2)
	COGNITIVE_CONTEXT_OPTIMIZE: "cognitiveContext:optimize",
	// Audit Trail (#3.3)
	AUDIT_TRAIL_APPEND: "auditTrail:append",
	AUDIT_TRAIL_APPEND_DECISION: "auditTrail:appendDecision",
	AUDIT_TRAIL_EVENTS: "auditTrail:events",
	AUDIT_TRAIL_REPLAY: "auditTrail:replay",
	AUDIT_TRAIL_VERIFY: "auditTrail:verify",
	AUDIT_TRAIL_LIST: "auditTrail:list",
	// Pair Programming Realtime (#3.5)
	PAIR_RT_CREATE_ROOM: "pairRT:createRoom",
	PAIR_RT_LIST_ROOMS: "pairRT:listRooms",
	PAIR_RT_GET_ROOM: "pairRT:getRoom",
	PAIR_RT_CLOSE_ROOM: "pairRT:closeRoom",
	PAIR_RT_JOIN: "pairRT:join",
	PAIR_RT_LEAVE: "pairRT:leave",
	PAIR_RT_EDIT: "pairRT:edit",
	PAIR_RT_CURSOR: "pairRT:cursor",
	PAIR_RT_CHAT: "pairRT:chat",
	PAIR_RT_SUGGESTION: "pairRT:suggestion",
	PAIR_RT_OPS: "pairRT:ops",
	PAIR_RT_SUBSCRIBE: "pairRT:subscribe",
	PAIR_RT_UNSUBSCRIBE: "pairRT:unsubscribe",
	// Pair Programming SSE event (main -> renderer)
	PAIR_RT_OP_EVENT: "pairRT:opEvent",
	PAIR_RT_STREAM_ERROR: "pairRT:streamError",
} as const;
