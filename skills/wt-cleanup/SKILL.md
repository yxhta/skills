---
name: wt-cleanup
description: Use when obsolete local Git worktrees and branches have accumulated, especially branches marked `[gone]`, or when cleanup must account for hc terminals or herdr-app spaces using those worktrees.
---

# Worktree Cleanup

## Overview

Remove only stale work that Git proves safe to delete. `[gone]` identifies a
candidate; it does not prove a merge.

## Safety contract

- Refresh remote-tracking refs before classifying candidates.
- Never remove the main or current worktree.
- Skip dirty, locked, busy, or ambiguous worktrees.
- Prefer `git branch -d`; do not turn a failed safety check into `-D`.
- Use `git branch -D` only after the user sees the unmerged commits and
  explicitly authorizes force deletion of that named branch.
- Stop on failed state reads. Preserve a target when its mutation fails.

## Workflow

### 1. Refresh and inventory

Run:

```bash
git fetch --prune --all
git branch -vv
git worktree list --porcelain
git rev-parse --show-toplevel
```

Stop if fetch fails. Select only `git branch -vv` entries whose upstream marker
ends in `: gone]`; ignore `gone` in commit subjects. Cross-reference them with
the porcelain worktree records.

Resolve trunk from remote HEAD or repository convention; ask if ambiguous.
Exclude the first porcelain record (main worktree) and current worktree.

### 2. Classify every candidate before mutating anything

For a candidate with a linked worktree, inspect:

```bash
git -C "<worktree>" status --short --branch
git merge-base --is-ancestor "<branch>" "<trunk>"
```

A worktree locked with reason `worktree-slot` is a reusable slot: skip it with
`skipped: slot, finish with worktree-slots` and leave its branch alone.

Remove automatically only if the worktree is clean, unlocked, has no Git
operation in progress, and its branch is an ancestor of trunk. Squash- or
rebase-merged branches may fail ancestry; report them for confirmation.

Before acting, classify every candidate as `remove` or `skip` with a reason.

### 3. Handle terminal occupants

Immediately before removal, read who is in the worktree:

```bash
hc ls | jq '.terminals[] | select(.state == "live") | {address, agent, status, cwd}'
herdr-app ls | jq '.spaces[] | {id, folder, terminals: [.tabs[].terminals[].terminal]}'
```

Match a terminal when its `cwd` is the worktree path or under it, using path
boundaries. Match a space when its `folder` is the worktree path.

Skip if a matching terminal is an agent (`agent` set and `status` not
`done`/`idle`), an editor, a server, or anything unclear (`hc read <t>` shows
the screen). If safe, close the space when every terminal in it matches;
otherwise end only the matching terminals:

```bash
herdr-app do space.close --id <space_id> --confirmed true
hc kill <t> && hc rm <t>
```

Re-run `hc ls` before each close and never close the current terminal
(`$HC_TERMINAL_ID`) or the space that holds it.

### 4. Remove eligible entries

For an eligible linked worktree:

```bash
git worktree remove -- "<worktree>"
git branch -d -- "<branch>"
```

Never force worktree removal. Delete the branch only after removal succeeds.
Preserve it if `git branch -d` fails.

For an eligible branch without a worktree:

```bash
git branch -d -- "<branch>"
```

If it fails, preserve the branch. Apply the force-delete rule above.

## Report

Return one row per candidate:

| Branch | Worktree | Terminal action | Result |
|---|---|---|---|
| `feat/merged` | `/path/to/wt` | closed space `sp1a2b` | removed |
| `fix/dirty` | `/path/to/wt` | none | skipped: uncommitted changes |

Finish with removed/skipped counts and the exact reason for every skip.
