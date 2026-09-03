---
name: treehouse
description: Use when starting or finishing branch work in a Treehouse-managed Git worktree opened through Herdr — leasing a pool slot, opening it as a Herdr workspace, or returning it after a PR merged (including squash merges, stale slots, and lingering processes). Not for worktrees outside the Treehouse pool; use `wt-cleanup` for those.
---

# Treehouse Worktrees

## Overview

Treehouse owns a pool of reusable worktrees and hands them out as leases;
Herdr only opens and closes a workspace on top of one. Acquire and return
slots without losing commits or corrupting Treehouse state. Treehouse state is
the only lease registry; never keep a parallel state file.

## Preconditions

- The path is a Treehouse pool slot. Legacy worktrees belong to `wt-cleanup`.
- `treehouse --version` reports `v2.3.0`. Flags differ across versions (for
  example `get --base` does not exist here), so stop for a version review if
  it differs instead of guessing.
- `HERDR_ENV=1` is set and `treehouse`, `herdr`, `gh`, and `git` are available.
- Run `treehouse` from a checkout of the target repository: it resolves the
  pool from cwd.
- Run the finish flow from outside the target Herdr workspace. Closing the
  workspace that contains the current agent kills the agent mid-flow.

## Safety contract

- Never work on the detached HEAD that `treehouse get` returns; a slot reset
  orphans commits that no branch points at. Create the branch first.
- Never use `treehouse return --force` or `herdr worktree remove` on a pool
  slot. `--force` skips the lease check, and `worktree remove` deletes the
  checkout Treehouse expects to reuse.
- Return only with `treehouse return --if-lease-id "$lease_id" "$path"`, so a
  slot re-leased by someone else is never reset underneath them.
- A returned slot does not prove anything was merged. Preserve any branch whose
  commits are not provably on the PR head.

## Start branch work

1. Check the preconditions, the repository, and the branch name.
2. Acquire a lease and capture `path` and `lease_id` from the JSON:

   ```sh
   treehouse get --lease --lease-holder "$BRANCH" --json
   ```

3. Immediately create the branch and open the workspace:

   ```sh
   git -C "$path" switch -c "$BRANCH"
   herdr worktree open --path "$path" --branch "$BRANCH" \
     --label "$BRANCH" --no-focus
   ```

4. If either command fails, do not leave an idle lease. Do not open Herdr on a
   half-prepared slot. Confirm the tree is clean, then return that exact
   acquisition:

   ```sh
   treehouse return --if-lease-id "$lease_id" "$path" </dev/null
   ```

5. Report the branch, path, lease ID, and Herdr workspace ID.

## Finish merged work

1. From a checkout of the target repository, resolve exactly one leased pool
   entry for the branch with `treehouse status --json`. Capture `path` and
   `lease_id`.
2. Confirm the PR is merged onto this branch. Stop unless `state` is `MERGED`
   and `headRefName` equals the local branch; record `headRefOid`:

   ```sh
   gh pr view "$BRANCH" --json state,headRefName,headRefOid
   ```

3. Record the local branch tip with `git -C "$path" rev-parse HEAD`. Stop on
   modified tracked files, untracked files, staged changes, conflicts, or an
   in-progress rebase, merge, or cherry-pick.
4. Resolve the Herdr workspace immediately before closing it, because IDs are
   unstable. Stop if the path maps to zero or several workspaces:

   ```sh
   herdr worktree list --cwd "$path" --json   # read open_workspace_id for $path
   herdr workspace close "$workspace_id"
   ```

   Close the **workspace**, never the worktree.
5. Re-read `treehouse status --json` and Git status. Stop if the lease changed
   or the tree is no longer clean. Report any process still bound to the path;
   conditional return terminates cwd-bound processes itself before the reset,
   so a lingering process is not by itself a reason to stop.
6. Return the slot:

   ```sh
   treehouse return --if-lease-id "$lease_id" "$path" </dev/null
   ```

   Run it with stdin closed (`</dev/null`): on a dirty tree `return` asks
   "Clean and return?" and exits 0 after aborting, so a stray "y" would wipe
   changes and a zero exit proves nothing. If it fails or the slot is not
   `available` in `treehouse status --json` afterwards, keep the branch and
   lease untouched and report the error.
7. Delete the local branch with `git branch -d`. After a squash merge `-d`
   refuses because the branch's own commits are not ancestors of trunk; use
   `-D` only when the tip recorded in step 3 exactly equals `headRefOid`.
   Otherwise keep the branch and report its extra commits. Do not move them
   to a recovery tag, which only turns a stale branch into a stale tag nobody
   looks at.
8. Verify the slot is available, the Herdr workspace is gone, and the branch
   outcome matches the report.

## Decision table

| Finding | Result |
|---|---|
| PR open, closed, or unknown | stop; keep lease and branch |
| Dirty tree or Git operation in progress | stop; keep lease and branch |
| Path maps to zero or several Herdr workspaces | stop; close nothing |
| Lease ID changed since step 1 | stop; do not return |
| Return fails, or slot not `available` afterwards | keep lease and branch; report the error |
| Process still bound to the path after close | report it; return anyway |
| Local tip differs from PR `headRefOid` | return the slot; keep the branch |

## Report

State the branch, pool path, lease and workspace actions taken, the PR, clean
tree, and process checks, the branch deletion result, and every preserved item
with its reason.
