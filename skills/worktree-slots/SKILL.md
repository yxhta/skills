---
name: worktree-slots
description: Use when starting or finishing branch work in a reusable Git worktree slot opened through Herdr -- picking a free slot, putting a task branch on it, opening it as a Herdr workspace, or handing it back after the PR merged (including squash merges and dirty trees). Slots are long-lived worktrees kept so dependencies and build caches survive between tasks. Not for one-off worktrees you intend to delete; use `herdr worktree create` / `remove` or `wt-cleanup` for those.
---

# Worktree Slots

## Overview

A slot is a long-lived Git worktree under Herdr's worktree directory that is
reused across tasks instead of created and deleted each time. Herdr is the
only registry: a slot is in use exactly when `herdr worktree list` shows an
`open_workspace_id` for it, and free when that field is null and the tree is
clean. There is no lease file and no separate tool.

## Preconditions

- `HERDR_ENV=1` is set and `herdr`, `gh`, and `git` are available.
- Run `herdr worktree` commands with `--cwd <repo>` pointing at a checkout of
  the target repository.
- Slots live at `~/.herdr/worktrees/<repo>/slot-N` (or wherever
  `[worktrees].directory` in Herdr's config points) and were created once with
  `git -C <repo> worktree add --detach <path> <trunk>`. Creating slots is a
  one-time setup step, not part of every task.
- Run the finish flow from outside the target Herdr workspace. Closing the
  workspace that contains the current agent kills the agent mid-flow.

## Safety contract

- Never work on a detached slot; put a branch on it first. A later reset
  orphans commits that no branch points at.
- Never run `herdr worktree remove` on a slot. It deletes the checkout the
  pool exists to keep. Finishing means closing the **workspace** and
  detaching the slot back to trunk.
- Never take a slot whose `open_workspace_id` is set or whose tree is dirty,
  even if it looks abandoned. Report it instead.
- A closed workspace does not prove anything was merged. Preserve any branch
  whose commits are not provably on the PR head.

## Start branch work

1. Check the preconditions, the repository, and the branch name.
2. List slots and pick a free one:

   ```sh
   herdr worktree list --cwd "$REPO" --json
   ```

   Free means `is_linked_worktree` true, `open_workspace_id` null, and
   `git -C "$path" status --porcelain` empty. Skip the source checkout row
   (`is_linked_worktree` false). If no slot is free, stop and report rather
   than creating one ad hoc.
3. Put the branch on the slot and open it:

   ```sh
   git -C "$path" fetch -q origin "$TRUNK"
   git -C "$path" switch -c "$BRANCH" "origin/$TRUNK"
   herdr worktree open --cwd "$REPO" --path "$path" --label "$BRANCH" --no-focus
   ```

   Read the workspace id from `.result.workspace.workspace_id` and the root
   pane from `.result.root_pane.pane_id`. If the response carries
   `already_open: true`, another caller took the slot between steps 2 and 3:
   detach it again (`git switch --detach`), delete the branch you just made,
   and pick another slot.
4. If `switch` fails, leave the slot detached and clean; do not open Herdr on
   a half-prepared slot.
5. Report the branch, slot path, and Herdr workspace ID.

## Finish merged work

1. From a checkout of the target repository, find the slot whose `branch` is
   `$BRANCH` in `herdr worktree list --cwd "$REPO" --json`. Capture `path`
   and `open_workspace_id`. Stop if zero or several rows match.
2. Confirm the PR is merged onto this branch. Stop unless `state` is `MERGED`
   and `headRefName` equals the local branch; record `headRefOid`:

   ```sh
   gh pr view "$BRANCH" --json state,headRefName,headRefOid
   ```

3. Record the local branch tip with `git -C "$path" rev-parse HEAD`. Stop on
   modified tracked files, untracked files, staged changes, conflicts, or an
   in-progress rebase, merge, or cherry-pick.
4. Close the workspace, never the worktree:

   ```sh
   herdr workspace close "$open_workspace_id"
   ```

   This ends every pane in it, so no process stays bound to the slot.
5. Re-read Git status. Stop if the tree is no longer clean. Then hand the
   slot back:

   ```sh
   git -C "$path" switch -q --detach "origin/$TRUNK"
   ```

   Confirm `herdr worktree list` now shows the slot with no `branch` and
   `open_workspace_id` null.
6. Delete the local branch with `git branch -d`. After a squash merge `-d`
   refuses because the branch's own commits are not ancestors of trunk; use
   `-D` only when the tip recorded in step 3 exactly equals `headRefOid`.
   Otherwise keep the branch and report its extra commits. Do not move them
   to a recovery tag, which only turns a stale branch into a stale tag nobody
   looks at.
7. Verify the slot is free, the Herdr workspace is gone, and the branch
   outcome matches the report.

## Decision table

| Finding | Result |
|---|---|
| No free slot | stop; report which slots are open or dirty |
| `already_open: true` on open | detach, drop the new branch, take another slot |
| PR open, closed, or unknown | stop; keep workspace and branch |
| Dirty tree or Git operation in progress | stop; keep workspace and branch |
| Branch maps to zero or several slots | stop; close nothing |
| Local tip differs from PR `headRefOid` | free the slot; keep the branch |

## Report

State the branch, slot path, workspace actions taken, the PR, clean tree
check, the branch deletion result, and every preserved item with its reason.
