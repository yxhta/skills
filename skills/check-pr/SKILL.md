---
name: check-pr
description: >
  Checks a GitHub pull request for unresolved review comments, failing status checks, and
  incomplete PR descriptions. Waits for pending checks to complete, categorizes issues as
  actionable or informational, and optionally fixes and resolves them. Use when the user wants
  to check a PR's health, address review feedback, see whether a PR is ready to merge, or
  prepare a change for submission — e.g. "check PR 123", "is my PR ready?", "address the
  review comments", "何か指摘残ってる?". Do not use for performing a code review itself
  (use a review skill for that); this skill inspects existing feedback and CI state.
argument-hint: "[pr-number]"
license: MIT
metadata:
  origin: Adapted from greptileai/skills check-pr (MIT), GitHub-only, Greptile-agnostic
---

# Check PR

Analyze a GitHub pull request for review comments, status checks, and description completeness, then help address any issues found.

## Preconditions

Requires `git` and `gh` (GitHub CLI) installed and authenticated. If `gh auth status` fails, stop and tell the user to run `gh auth login` (suggest typing `! gh auth login` if an interactive login is needed) — do not attempt unauthenticated API calls.

## Inputs

- **PR number** (optional): If not provided, detect the PR for the current branch.

## Instructions

### 1. Identify the PR

If a number was provided, use it. Otherwise detect the PR for the current branch:

```bash
gh pr view --json number -q .number
```

If no PR exists for the current branch, report that and stop.

### 2. Fetch PR details and all unresolved review threads

```bash
gh pr view <PR_NUMBER> --json title,body,state,headRefName,statusCheckRollup
```

Then fetch **every unresolved review thread** via GraphQL — this is the primary source of review feedback. Resolution state (`isResolved`) only exists on review threads, not on the REST comments endpoints, so the GraphQL query is not optional:

```bash
gh api graphql -f query='
query($cursor: String) {
  repository(owner: "OWNER", name: "REPO") {
    pullRequest(number: PR_NUMBER) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          comments(first: 10) {
            nodes { body author { login } createdAt }
          }
        }
      }
    }
  }
}'
```

If `hasNextPage` is true, repeat with `-f cursor=ENDCURSOR` until all threads are fetched — a partially fetched list silently drops feedback. Keep every thread where `isResolved` is `false`, regardless of author (human or bot) or `isOutdated` — an outdated thread can still describe an unfixed problem. See [the GraphQL reference](references/graphql-queries.md) for query details.

Also fetch general PR comments for discussion-level feedback (GitHub PRs are also issues, so these live on the issue comments endpoint):

```bash
gh api --paginate "repos/{owner}/{repo}/issues/<PR_NUMBER>/comments?per_page=100"
```

### 3. Wait for pending checks

Before analyzing, ensure all status checks have completed. If any checks in `statusCheckRollup` are `PENDING` or `IN_PROGRESS`, poll `gh pr view` every 30 seconds until all checks reach a terminal state. Tell the user you are waiting and roughly what is still running.

### 4. Analyze the PR

Once all checks are complete, evaluate these areas:

#### A. Status checks

- Are all CI checks passing?
- If any are failing, identify which ones and pull the failure reason (`gh run view <RUN_ID> --log-failed` for Actions runs).

#### B. PR description

- Is the description complete and does it follow team conventions (e.g. the repo's PR template)?
- Are all required sections filled in?
- Are there TODOs or placeholders that need updating?

#### C. Unresolved review threads

Go through **all** unresolved threads from step 2, one by one — do not sample or stop at the first few. For each thread, read the full comment chain (a later reply may already answer or withdraw the original point) and decide what it asks for. This covers human reviewers and bots (linters, security scanners, review bots) alike.

#### D. General comments

- Discussion comments on the PR (issue comments endpoint)
- Bot comments (deploy previews, coverage reports, etc.) — usually informational

### 5. Categorize issues

Categorize each unresolved thread and each other issue found as:

| Category | Meaning |
|---|---|
| **Actionable** | Code changes, test improvements, or fixes needed |
| **Informational** | Verification notes, questions, or FYIs that don't require changes |
| **Already addressed** | Issues that appear to be resolved by subsequent commits |

When judging "already addressed", compare the comment's `path`/position against commits pushed after the comment's `created_at` — do not assume a later push addressed everything.

### 6. Report findings

Present a summary table:

| Area | Issue | Status | Action Needed |
|------|-------|--------|---------------|
| Status Checks | CI build failing | Failing | Fix type error in `src/api.ts` |
| Review | "Add null check" — @reviewer | Actionable | Add guard clause |
| Description | TODO placeholder in test plan | Actionable | Fill in test plan |
| Review | "Looks good" — @teammate | Informational | None |

### 7. Fix issues (if requested)

If there are actionable items:

1. Switch to the PR's branch if not already on it.
2. Ask the user if they want to fix the issues.
3. If yes, make the fixes, then commit and push:

```bash
git add <files>
git commit -m "address review feedback"
git push
```

### 8. Resolve review threads

After addressing comments, resolve the corresponding review threads using the thread IDs already collected in step 2 (re-run the query first if new commits or comments may have changed the thread list):

```bash
gh api graphql -f query='
mutation {
  resolveReviewThread(input: {threadId: "THREAD_ID"}) {
    thread { isResolved }
  }
}'
```

Batch multiple resolutions into a single mutation using aliases (`t1`, `t2`, etc.).

Only resolve threads whose fix has actually been pushed, or that are clearly informational. For human reviewer comments where team culture expects the reviewer to resolve their own threads, reply instead of resolving unless the user says otherwise.

### 9. Multiple PRs

If checking a chain of PRs, process them sequentially and report per-PR.

## Output format

Summarize:
- PR title and current state
- Status checks summary (passing/failing/pending)
- Total issues found
- Actionable items with descriptions
- Items that can be ignored with reasons
- Recommended next steps
