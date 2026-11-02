---
name: worktree-slots
description: Use when starting or finishing branch work in a reusable Git worktree slot opened as a herdr-app space -- picking a free slot, putting a task branch on it, opening it as a space (optionally with an agent), or handing it back after the PR merged (including squash merges and dirty trees). Slots are long-lived worktrees kept so dependencies and build caches survive between tasks. Not for one-off worktrees you intend to delete; use the herdr-app worktree dialog or `wt-cleanup` for those.
---

# Worktree Slots

## Overview

A slot is a long-lived Git worktree under `~/.herdr/worktrees/<repo>/` that is
reused across tasks instead of created and deleted each time. Git is the slot
list; herdr-app and herdr-core (`hc`) say who is using one. There is no lease
file and no separate tool.

A slot is **in use** when any of these holds:

- a herdr-app space has `folder` equal to the slot path (`herdr-app ls`),
- a live hc terminal has `cwd` at or under the slot path (`hc ls`),
- the slot has a branch checked out, or its tree is dirty.

A slot is **free** only when none holds: detached HEAD, clean tree, no space,
no terminal.

## Preconditions

- `git`, `gh`, `hc`, and `herdr-app` are available, and the herdr-app window
  is open (`herdr-app status`).
- Slots were created once with
  `git -C <repo> worktree add --detach <path> <trunk>` followed by
  `git -C <repo> worktree lock --reason worktree-slot <path>`. The lock keeps
  `wt-cleanup` and `git worktree remove`/`prune` from deleting the slot; it
  does not block `switch`. Creating slots is a one-time setup step, not part
  of every task.
- Run the finish flow from outside the slot's space. Closing the space that
  contains the current agent kills the agent mid-flow.

## Safety contract

- Never work on a detached slot; put a branch on it first. A later reset
  orphans commits that no branch points at.
- Never `git worktree remove` a slot or close it through the herdr-app
  worktree dialog's remove action. Both delete the checkout the pool exists
  to keep. Finishing means closing the **space** and detaching the slot back
  to trunk.
- Never take a slot that is in use, even if it looks abandoned. Report it
  instead.
- Never `hc kill` a terminal in a slot that you did not start. Report it.
- A closed space does not prove anything was merged. Preserve any branch
  whose commits are not provably on the PR head.

## Start branch work

1. Check the preconditions, the repository, and the branch name.
2. List slots and pick a free one:

   ```sh
   git -C "$REPO" worktree list --porcelain   # rows with "locked worktree-slot"
   herdr-app ls | jq -r '.spaces[].folder'
   hc ls | jq -r '.terminals[] | select(.state == "live") | .cwd'
   ```

   Apply the free test from the overview, including
   `git -C "$path" status --porcelain` empty and
   `git -C "$path" branch --show-current` empty. If no slot is free, stop and
   report rather than creating one ad hoc.
3. Re-check that slot right before switching (another caller may have taken
   it since step 2), then put the branch on it and open it:

   ```sh
   git -C "$path" fetch -q origin "$TRUNK"
   git -C "$path" switch -c "$BRANCH" "origin/$TRUNK"
   herdr-app do space.new --name "$BRANCH" --folder "$path"
   ```

   The reply carries `space`, `tab`, and `terminal` ids. To start an agent in
   the space, add `--argv '["claude"]' --task "<first message>"` to
   `space.new`. To start one without a space, use
   `hc run --bg --name <name> --cwd "$path" ...` per `hc --skill`.
4. If `switch` fails, leave the slot detached and clean; do not open a space
   on a half-prepared slot.
5. Report the branch, slot path, and the space and terminal ids.

## Finish merged work

1. Find the slot whose branch is `$BRANCH` in
   `git -C "$REPO" worktree list --porcelain`. Capture `path`. Stop if zero
   or several rows match.
2. Confirm the PR is merged onto this branch. Stop unless `state` is `MERGED`
   and `headRefName` equals the local branch; record `headRefOid`:

   ```sh
   gh pr view "$BRANCH" --json state,headRefName,headRefOid
   ```

3. Record the local branch tip with `git -C "$path" rev-parse HEAD`. Stop on
   modified tracked files, untracked files, staged changes, conflicts, or an
   in-progress rebase, merge, or cherry-pick.
4. Close the slot's space, never the worktree:

   ```sh
   herdr-app ls | jq -r --arg p "$path" '.spaces[] | select(.folder == $p) | .id'
   herdr-app do space.close --id "$SPACE_ID" --confirmed true
   ```

   This ends every terminal in it. Then re-run `hc ls`: if a live terminal
   still has its `cwd` in the slot, stop and report it (kill it only if you
   started it). Remove finished terminals you started with `hc rm`.
5. Re-read Git status. Stop if the tree is no longer clean. Then hand the
   slot back:

   ```sh
   git -C "$path" switch -q --detach "origin/$TRUNK"
   ```

6. Delete the local branch with `git branch -d`. After a squash merge `-d`
   refuses because the branch's own commits are not ancestors of trunk; use
   `-D` only when the tip recorded in step 3 exactly equals `headRefOid`.
   Otherwise keep the branch and report its extra commits. Do not move them
   to a recovery tag, which only turns a stale branch into a stale tag nobody
   looks at.
7. Verify the slot passes the free test, and the branch outcome matches the
   report.

## Decision table

| Finding | Result |
|---|---|
| No free slot | stop; report which slots are in use and why |
| Slot taken between list and switch | pick another slot |
| PR open, closed, or unknown | stop; keep space and branch |
| Dirty tree or Git operation in progress | stop; keep space and branch |
| Branch maps to zero or several slots | stop; close nothing |
| Live terminal you did not start stays in the slot | stop; report it |
| Local tip differs from PR `headRefOid` | free the slot; keep the branch |

## Report

State the branch, slot path, space and terminal actions taken, the PR, clean
tree check, the branch deletion result, and every preserved item with its
reason.
