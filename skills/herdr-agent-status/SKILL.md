---
name: herdr-agent-status
description: Check the status of agent sessions running across Herdr workspaces and panes — which agents exist, whether each is idle, working, blocked, or done, and what it is currently doing. Use when the user asks about other agents' status, wants a cross-workspace summary, or needs to find an idle/blocked agent to route work to or wait on.
---

# Herdr Agent Status

## Overview

Report a snapshot of every detected agent session inside the current Herdr instance: where it lives (workspace/tab/pane), what product it is (`claude`, `codex`, ...), and its current `agent_status`. This is a read-only status check — it never edits files or sends input to other panes unless the user explicitly asks for a follow-up action.

## Precondition

Run only inside Herdr. If `HERDR_ENV` is not `1`, or `herdr` commands fail to reach the socket, tell the user this skill only works from a pane inside a running Herdr instance and stop.

## Steps

1. Get the workspace-level rollup:

   ```sh
   herdr workspace list
   ```

   Each workspace reports its own `agent_status`, which summarizes the panes inside it.

2. Get the agent-level detail:

   ```sh
   herdr agent list
   ```

   Each entry includes `agent` (product, e.g. `claude`, `codex`), `agent_status`, `name` (when the agent was given one), `cwd`/`foreground_cwd`, `workspace_id`, `tab_id`, `pane_id`, and `focused`.

3. Plain shells are not in that list. Use `herdr pane list --workspace <id>` only when the user asks about non-agent panes too.

4. Present a compact table: workspace/label, agent product, `agent_status`, cwd, and pane id. Group by workspace so the user can see at a glance which projects have agents idle vs. still working.

5. If the user wants to know what a specific agent is _doing_ right now (not just its status), read its recent output instead of guessing from status alone:

   ```sh
   herdr agent read <name-or-pane_id> --source recent-unwrapped --lines 50
   ```

   If the state itself looks wrong (a visible dialog reported as `idle`, a stuck `unknown`), `herdr agent explain <target>` shows which detection rule produced it.

6. If the user wants to be notified when an agent finishes or gets stuck, offer to block on it instead of polling:

   ```sh
   herdr agent wait <name-or-pane_id> --timeout 1800000
   ```

   Without `--until` it returns on the first of `idle`, `done`, or `blocked`; pass `--until blocked` to watch only for an agent that needs input. Always give a `--timeout` — the wait is otherwise indefinite.

## Status meanings

- `idle` — at its input prompt, and its tab has been seen in the Herdr UI.
- `working` — actively processing.
- `blocked` — Herdr recognized an approval, question, or permission UI. Detection is strict: an unfamiliar dialog shape shows as `idle` instead, so confirm with a read before trusting `idle`.
- `done` — the same state as `idle`, reached after work finished while the tab was not being viewed. CLI reads do not mark it seen; focusing the tab does.
- `unknown` — an agent is present but its state could not be classified. Never treat it as completion.

## Notes

- Pane/tab/workspace ids are opaque handles; parse them from command JSON rather than predicting them. A pane moved to another workspace gets a new id, so re-read after any layout change. Agent commands also accept a unique agent `name`, which follows the agent across moves.
- This skill only reports status. To act on another agent's output (send it a task, coordinate an implement/review loop), use `herdr-workflow` instead.
