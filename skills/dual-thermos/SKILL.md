---
name: dual-thermos
description: Run the Thermos review independently on both Claude and Codex, then let Claude fix the findings and re-review in a loop (at most 3 fix cycles). Use when the user asks for a Claude-and-Codex Thermos review, a "dual thermos", or a Thermos review with automatic fix rounds. Do not use for a single Thermos pass without fixes (run /thermos directly) or for a plain Codex review loop (use claude-codex-workflow).
argument-hint: "[scope: PR number, base ref, or path] [--max-cycles N]"
---

# Dual Thermos

## Overview

Each review round runs Thermos twice, in parallel, from two independent hosts: once inside Claude Code and once inside Codex. Claude merges both reports, fixes the accepted findings, verifies, and starts the next round on the same scope. The loop ends when a round has no accepted findings or the fix budget runs out.

Claude-specific: this skill drives the Claude Code `Agent` tool and the `codex` plugin, so it ships no `agents/openai.yaml`.

## Preconditions

1. Resolve the Thermos skill file. `thermos` sets `disable-model-invocation`, so read the file instead of calling the Skill tool:

   ```sh
   THERMOS_SKILL=$(realpath "$HOME/.claude/skills/thermos/SKILL.md" 2>/dev/null)
   ```

   If it is empty, stop and tell the user Thermos is not installed. Read `SKILL.md` and its `references/runtime-adaptation.md` in full before round 1.

2. Resolve the codex plugin runtime:

   ```sh
   CODEX_PLUGIN_ROOT=$(ls -d "$HOME/.claude/plugins/cache/openai-codex/codex"/*/ 2>/dev/null | sort -V | tail -1)
   ```

   If it is empty, stop and tell the user the codex plugin is not installed. If a companion call fails because the Codex CLI is missing or unauthenticated, stop and tell the user to run `/codex:setup`.

3. Work inside a git repository. Save `git status --short`, `git diff`, and `git diff --cached` to scratchpad files as the baseline. Never stash or commit the user's pre-existing changes.

## Role Contract

- **Claude (the agent using this skill)** coordinates the loop and is the only one that edits files. It fixes findings, runs verification, and writes the report.
- **Claude Thermos reviewer** runs the Thermos workflow from `THERMOS_SKILL`: two fresh background agents (correctness and quality) on the scope, then a synthesis. These agents only review.
- **Codex Thermos reviewer** runs `$thermos` inside Codex through the companion `task` command without `--write`, which keeps Codex in a read-only sandbox. Codex only reviews.

Neither reviewer sees the other's report in the same round. Independence is the point of running two hosts.

## Autonomy Contract

Run the loop end to end without checking in. Decide on your own:

- the review scope when the request, PR, or branch settles it,
- which findings to fix and which to dismiss, each with a one-line reason,
- verification commands, from the repo's test, lint, and CI config.

Escalate only for:

- an ambiguous scope (Thermos requires a real diff, not a guessed one),
- a fix that needs a product decision the repo cannot answer,
- a destructive action outside the task's files,
- a blocker from Preconditions.

## Workflow

1. **Fix the scope once.** Record the base commit (merge base for a branch or PR, `HEAD` for a working-tree review) and whether staged, unstaged, and untracked changes are included. Every round reviews the cumulative diff from this base, fixes included. Set `MAX_CYCLES` to 3 unless the user gave `--max-cycles`.

2. **Review round.** Start both reviewers before waiting for either.

   - Claude side. Follow `THERMOS_SKILL` and its runtime adaptation: gather the diff and changed-file contents, then launch both Thermos agents in one message with `run_in_background: true`. Synthesize their reports as Thermos describes.
   - Codex side. Run in the background:

     ```sh
     node "${CODEX_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "<prompt>"
     ```

     The prompt gives Codex the absolute `THERMOS_SKILL` path and tells it to use the `$thermos` skill on the recorded scope (base SHA, head, working-tree inclusion), to report only and never edit files, and to return findings as `severity | file:line | issue | evidence`. Always start a fresh task. Do not pass `--resume-last`.

   If one side fails, retry it once. If it fails again, mark the round incomplete and stop.

3. **Check for contamination.** Compare `git status --short` and `git diff` against the state before the round. Any change made by a reviewer is contamination. Revert it when the path is outside the user's pre-existing changes, and note it in the report. Escalate when it overlaps the user's own uncommitted work.

4. **Triage.** Merge the two reports and deduplicate. A finding both hosts reported carries more weight. Judge each finding yourself:

   - **fix** when it is a confirmed defect or a concrete quality problem in the scoped diff,
   - **dismiss** when it is wrong, pre-existing, or out of scope, with a reason.

   A failing verification command counts as a fix finding.

5. **Stop or fix.** If no finding is marked fix, the loop is clean. Go to step 7. If `MAX_CYCLES` fix cycles are already used, stop and report the open findings. Otherwise apply the fixes, keep them scoped to the findings, and run the verification commands. This is one fix cycle.

6. **Re-review.** Return to step 2 with fresh reviewers on both hosts. Do not resume a previous round's agents or Codex thread. Give reviewers no history of earlier rounds, so each round judges the code as it stands.

7. **Report** in the format below. Never call the result clean while a fix finding remains open.

## Final Report

- `status`: clean, stopped after max cycles, incomplete, or blocked
- `scope`: base SHA, head, and working-tree inclusion
- `rounds`: per round, finding counts from Claude and Codex, the overlap, and how many were fixed or dismissed
- `changed`: files changed by fix cycles
- `verified`: commands run and their results
- `open`: findings still open, with file:line
- `dismissed`: dismissed findings with reasons
- `gaps`: coverage limits (failed reviewer, truncated context, reverted contamination)
