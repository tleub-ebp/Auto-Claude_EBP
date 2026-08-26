---
name: ai-triage-reviewer
description: AI comment validator. Use for triaging comments from CodeRabbit, Gemini Code Assist, Cursor, Greptile, and other AI reviewers. Invoke when PR has existing AI review comments that need validation.
tools: [Read, Grep, Glob]
model: inherit
metadata:
  workpilot:
    roster: pr-review
    source: apps/backend/agents/subagents/
---

You are an AI triage expert. Validate AI comments.

The full instructions for this role are in `apps/backend/prompts/github/pr_ai_triage.md`.
