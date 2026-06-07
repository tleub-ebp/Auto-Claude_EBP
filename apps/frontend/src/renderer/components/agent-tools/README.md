# Agent Tools

Three Kanban-side helpers wired to the matching backend endpoints:

| Component | Endpoint | What it does |
|---|---|---|
| `CostEstimatorDialog` | `POST /api/cost-estimator/preview` | Pre-build token / cost projection. |
| `RestartDialog` | `GET /api/restart/plan` + `POST /api/restart/prepare` | Inspect what can be restarted, run cleanup (no agent spawn). |
| `PromptPreviewDialog` | `GET /api/prompt-preview/` | Show the assembled system prompt without spending tokens. |

`AgentToolsButton` packages all three behind a single dropdown menu so a card
gets one button, not three.

## Integration into a Kanban card

Drop the button into any card / row. The hosting component is responsible for
two things only:

1. Pass `projectDir` (from `project.path`) and `specDir` (from `task.specsPath`).
2. Wire the post-action callbacks to the existing build / restart code path.

```tsx
import { AgentToolsButton } from "@/components/agent-tools";

<AgentToolsButton
  projectDir={project.path}
  specDir={task.specsPath ?? ""}
  agentType="coder"
  onStartBuild={() => {
    // Existing path used by the "Start build" button today.
    void window.electronAPI.invoke("task:start", task.id);
  }}
  onRestart={(mode, deleted) => {
    console.log(`[restart] ${mode}; cleaned: ${deleted.join(", ")}`);
    // Same code path as a normal build start — backend cleanup already done.
    void window.electronAPI.invoke("task:start", task.id, { restart: mode });
  }}
/>
```

### Choosing which tools to show

`tools` filters the menu items. Useful when, say, the cost estimator is
irrelevant for a task that has already started:

```tsx
// Only show "Restart" + "Show active prompt" on cards in `in_progress` /
// `ai_review` / `human_review`.
<AgentToolsButton
  projectDir={project.path}
  specDir={task.specsPath ?? ""}
  tools={["restart", "prompt"]}
  ...
/>
```

For cards in `backlog` / `queue`, only the cost estimator is meaningful:

```tsx
<AgentToolsButton ... tools={["cost"]} />
```

## Why three separate dialogs?

Each one fetches its data on open (with `AbortController` cleanup) and resets
on close. They never share state, so adding one doesn't change behaviour of
the others. If the backend module is missing the dialog shows a clean error
message instead of crashing.

## Testing

`AgentToolsButton.test.tsx` mocks the API client and asserts on user-visible
behaviour. Use it as a template if you add a 4th tool — the pattern is:

1. Mock `lib/agent-tools-api`.
2. `userEvent.setup()` (Radix dropdown needs pointer events, not raw clicks).
3. `await openMenu(user)` then `findByText` for the menu item label.
