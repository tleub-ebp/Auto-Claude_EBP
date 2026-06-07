/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentToolsButton } from "./AgentToolsButton";

// Mock the API client so the component never actually calls fetch.
vi.mock("../../lib/agent-tools-api", () => ({
	previewBuildCost: vi.fn(),
	fetchRestartPlan: vi.fn(),
	prepareRestart: vi.fn(),
	fetchPromptPreview: vi.fn(),
}));

import * as api from "../../lib/agent-tools-api";

const mocked = api as unknown as {
	previewBuildCost: ReturnType<typeof vi.fn>;
	fetchRestartPlan: ReturnType<typeof vi.fn>;
	prepareRestart: ReturnType<typeof vi.fn>;
	fetchPromptPreview: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
	mocked.previewBuildCost.mockReset();
	mocked.fetchRestartPlan.mockReset();
	mocked.prepareRestart.mockReset();
	mocked.fetchPromptPreview.mockReset();
});

afterEach(() => {
	vi.clearAllMocks();
});

const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
	await user.click(screen.getByRole("button", { name: /agent tools/i }));
};

describe("AgentToolsButton", () => {
	it("renders nothing when no tools are enabled", () => {
		const { container } = render(
			<AgentToolsButton
				projectDir="/p"
				specDir="/p/spec-1"
				tools={[]}
			/>,
		);
		expect(container.firstChild).toBeNull();
	});

	it("opens the cost estimator dialog when 'Estimate cost…' is clicked", async () => {
		mocked.previewBuildCost.mockResolvedValue({
			ok: true,
			data: {
				estimate: {
					spec_id: "spec-1",
					spec_chars: 1000,
					base_input_tokens: 250,
					phases: [
						{
							phase: "planning",
							provider: "anthropic",
							model: "claude-sonnet-4-7",
							input_tokens: 500,
							output_tokens: 4000,
							iterations: 1,
							estimated_cost_usd: 0.06,
							notes: [],
						},
					],
					total_cost_usd: 0.06,
					confidence: "high",
					warnings: [],
				},
			},
		});

		const user = userEvent.setup();
		render(
			<AgentToolsButton
				projectDir="/p"
				specDir="/p/spec-1"
				tools={["cost"]}
			/>,
		);

		await openMenu(user);
		await user.click(await screen.findByText(/Estimate cost/));

		await waitFor(() =>
			expect(mocked.previewBuildCost).toHaveBeenCalledWith(
				"/p/spec-1",
				expect.any(AbortSignal),
			),
		);
		// "$0.06" is rendered both as the total and on the single phase row.
		expect((await screen.findAllByText("$0.06")).length).toBeGreaterThan(0);
		expect(screen.getByText(/high confidence/i)).toBeInTheDocument();
	});

	it("calls onStartBuild when the user confirms the estimate", async () => {
		mocked.previewBuildCost.mockResolvedValue({
			ok: true,
			data: {
				estimate: {
					spec_id: "spec-1",
					spec_chars: 1000,
					base_input_tokens: 250,
					phases: [],
					total_cost_usd: 0,
					confidence: "low",
					warnings: [],
				},
			},
		});
		const onStart = vi.fn();
		const user = userEvent.setup();
		render(
			<AgentToolsButton
				projectDir="/p"
				specDir="/p/spec-1"
				tools={["cost"]}
				onStartBuild={onStart}
			/>,
		);
		await openMenu(user);
		await user.click(await screen.findByText(/Estimate cost/));
		await screen.findByText(/low confidence/i);
		await user.click(screen.getByRole("button", { name: /start build/i }));
		expect(onStart).toHaveBeenCalledTimes(1);
	});

	it("shows the prompt preview when 'Show active prompt…' is clicked", async () => {
		mocked.fetchPromptPreview.mockResolvedValue({
			ok: true,
			data: {
				preview: {
					project_dir: "/p",
					spec_dir: "/p/spec-1",
					agent_type: "coder",
					model: "claude-sonnet-4-7",
					provider: "anthropic",
					system_prompt: "YOU ARE A CODER",
					system_prompt_length: 16,
					claude_md_included: false,
					domain_addendum_included: true,
					domain_addendum_chars: 200,
					allowed_tools: ["Read", "Edit"],
					notes: [],
				},
			},
		});

		const user = userEvent.setup();
		render(
			<AgentToolsButton
				projectDir="/p"
				specDir="/p/spec-1"
				tools={["prompt"]}
			/>,
		);
		await openMenu(user);
		await user.click(await screen.findByText(/Show active prompt/));
		expect(await screen.findByText("YOU ARE A CODER")).toBeInTheDocument();
		expect(screen.getByText(/domain addendum/i)).toBeInTheDocument();
	});

	it("invokes onRestart with the chosen mode after cleanup", async () => {
		mocked.fetchRestartPlan.mockResolvedValue({
			ok: true,
			data: {
				plan: {
					spec_id: "spec-1",
					can_restart_qa: true,
					can_restart_coder: true,
					can_restart_full: true,
					reasons: {},
					next_subtask_for_coder: null,
					completed_subtasks: 2,
					total_subtasks: 4,
					files_to_clean: { qa: [], coder: [], full: [] },
				},
			},
		});
		mocked.prepareRestart.mockResolvedValue({
			ok: true,
			data: { mode: "qa", deleted: ["qa_report.md"], warnings: [] },
		});
		const onRestart = vi.fn();
		const user = userEvent.setup();
		render(
			<AgentToolsButton
				projectDir="/p"
				specDir="/p/spec-1"
				tools={["restart"]}
				onRestart={onRestart}
			/>,
		);
		await openMenu(user);
		await user.click(await screen.findByText(/Restart agent/));
		const restartButtons = await screen.findAllByRole("button", {
			name: /^Restart$/,
		});
		await user.click(restartButtons[0]);
		await waitFor(() =>
			expect(onRestart).toHaveBeenCalledWith("qa", ["qa_report.md"]),
		);
	});
});
