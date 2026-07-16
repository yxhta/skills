---
name: adversarial-review
description: Run an adversarial review that challenges the implementation approach, design choices, tradeoffs, and assumptions behind a set of changes -- not just a stricter defect pass. Review-only, never edits files. Use when reviewing a diff, uncommitted changes, or a PR and a straight defect-hunting review would miss a wrong approach.
argument-hint: '[objective] [acceptance criteria] [diff scope]'
---

# Adversarial Review

Run a review that questions the chosen implementation, design choices, tradeoffs, and assumptions -- not a stricter pass over implementation defects.

## Core constraint

- Review-only. Never edit files, apply patches, or say you are about to make changes.
- Your only job is to review and report findings.

## Determine scope

- Default to the current uncommitted changes: run `git status --short --untracked-files=all` first, then inspect both `git diff` (unstaged) and `git diff --cached` (staged) -- or `git diff HEAD` to cover all tracked changes in one pass. A plain `git diff` alone misses staged-only changes; do not treat an empty unstaged diff as "nothing to review" without also checking staged and untracked files.
- If the caller specifies a base ref, branch, or PR instead, review that diff.

## What to challenge

- Whether the current approach is the right one, and what alternatives were available.
- What assumptions the implementation depends on.
- Where the design could fail under real-world conditions (scale, concurrency, bad input, partial failure).
- Whether the tradeoffs made were the right ones.

## What to also check

- Bugs, regressions, missing tests, risky assumptions, and gaps against any stated task or acceptance criteria.

## Output format

- Findings first, ordered by severity, with file/line references.
- Separate concrete required fixes from design/approach challenges, and from optional suggestions or questions.
- If there are no findings, say that clearly and mention residual test risk.
