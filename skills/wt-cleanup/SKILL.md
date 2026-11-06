---
name: wt-cleanup
description: Use when obsolete local Git worktrees and branches have accumulated, especially branches marked `[gone]` or already merged (including squash merges), and they should be removed with Worktrunk (`wt`). Requires the `wt` CLI. Not for creating or switching worktrees.
---

# Worktree Cleanup

## Overview

Remove only stale work that Worktrunk proves safe to delete. `[gone]` marks a
candidate; it does not prove a merge. Worktrunk's integration checks
(`display.state` of `empty` or `integrated`) are the proof, and they cover
squash and rebase merges.

## Preconditions

`wt --version` must succeed. If `wt` is missing, stop and tell the user to
install Worktrunk; do not fall back to raw `git worktree remove`.

## Safety contract

- Refresh remote-tracking refs before classifying candidates.
- Never remove the main or current worktree.
- Skip dirty, locked, prunable, busy, or ambiguous worktrees.
- Never pass `--force`/`-f` or `--force-delete`/`-D` to `wt remove`, and never
  pass `--reap`.
- Use `-D` only after the user sees the unmerged commits and explicitly
  authorizes force deletion of that named branch.
- Stop on failed state reads. Preserve a target when its removal fails.

## Workflow

### 1. Refresh and inventory

```bash
git fetch --prune --all
git branch -vv
wt list --format=json --branches
```

Stop if fetch fails. Candidates are:

- branches whose `git branch -vv` upstream marker ends in `: gone]` (ignore
  `gone` in commit subjects), and
- `wt list` items whose `display.state` is `empty` or `integrated`.

Exclude items with `worktree.main` or `worktree.current` true, and the
`repo.default_branch`.

### 2. Classify every candidate before removing anything

Mark a candidate `remove` only if all hold:

- `display.state` is `empty` or `integrated`. A `[gone]` branch in any other
  state has unmerged changes: skip it and show `git log --oneline
  <default>..<branch>` in the report.
- If it has a worktree: every `worktree.changes` flag is false, and
  `worktree.locked`, `worktree.prunable`, `worktree.detached`,
  `worktree.branch_mismatch`, and `worktree.duplicate_branch` are absent or
  false.
- No process is working in the worktree (step 3).

`integration` being `null` means a check was skipped or timed out: skip as
ambiguous. Classify every candidate as `remove` or `skip` with a reason first.

### 3. Check for processes in the worktree

Immediately before removing a worktree, list processes whose cwd is the
worktree or under it:

```bash
lsof -nP -d cwd -Fpcn 2>/dev/null | awk -v w="<worktree>" '
  /^p/{p=substr($0,2)} /^c/{c=substr($0,2)}
  /^n/{n=substr($0,2); if (n==w || index(n, w"/")==1) print p, c, n}'
```

Skip the worktree if any match: an agent, editor, server, or idle shell may
hold unsaved state. Do not kill them. Report the PIDs and commands so the user
can close them.

### 4. Remove eligible entries

One call per candidate, so one failure does not hide the others:

```bash
wt remove --foreground --format=json -- "<branch>"
```

This works for branches with and without a worktree. Read `branch_outcome`:
`deleted` is success; any `retained_*` value means the branch was preserved,
so report it as skipped with that value. If `wt` stops because a project hook
needs approval, stop and tell the user to run `wt config approvals add`; do
not pass `--yes` or `--no-hooks` on their behalf.

## Report

Return one row per candidate:

| Branch | Worktree | State | Result |
|---|---|---|---|
| `feat/merged` | `/path/to/wt` | `integrated` | removed |
| `fix/dirty` | `/path/to/wt` | `integrated` | skipped: uncommitted changes |
| `wip/unmerged` | none | `ahead` | skipped: 3 unmerged commits |

Finish with removed/skipped counts and the exact reason for every skip.
