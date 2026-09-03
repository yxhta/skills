---
name: herdr-workflow
description: Coordinate an implementation-and-review workflow inside Herdr. Use when the user wants an agent to implement changes in a worktree and have an independent Codex reviewer agent, started in a second pane of that same worktree, adversarially review the diff -- with a coordinator managing panes, prompts, waiting, review cycles, and final reporting. Needs the `codex` CLI on PATH for the reviewer; the implementation agent can be any Herdr-supported product.
---

# Herdr Agent Workflow

## Overview

Use Herdr to run an implementation loop across two panes in the target worktree's workspace: `impl`, the implementation agent (the only writer), and `reviewer`, a Codex agent started in a second pane of the same worktree that reviews the diff and never edits. The reviewer is a separate process in a separate pane with no access to the implementation agent's conversation, so its critique is independent; the coordinator drives both, routes findings, and reports.

## Preconditions

- Run only inside Herdr. If `HERDR_ENV=1` is not set or `herdr` commands cannot reach the socket, tell the user to start the coordinator from a Herdr pane.
- The installed binary is the authority on syntax. This skill is written against the `agent prompt` / `agent wait` / `pane wait-output` surface (herdr 0.8+); if a command below is missing, run the group without a subcommand (`herdr agent`, `herdr pane`) and adapt, rather than guessing flags.
- `codex` is on PATH for the reviewer. Default reviewer args are `-m gpt-5.6-sol` unless the user names another model or flags. Codex's approval and sandbox flags are not assumed here: if the reviewer keeps landing in `blocked` on reads like `git diff` or test runs, check `codex --help` for its read-only sandbox / approval-policy options and restart it with those.
- Treat pane IDs as opaque. Parse them from JSON responses (`.result.pane.pane_id`, `.result.root_pane.pane_id`, `.result.agent.pane_id`), never predict them, and prefer the agent *name* as the target wherever an agent command accepts one.
- Always pass `--timeout` to `agent start`, `agent prompt --wait`, `agent wait`, and `pane wait-output`. Without it, waits are indefinite.
- Either agent may stop at `blocked` on an approval prompt. That is visible -- every wait in this skill returns on `blocked` -- but the coordinator must not answer the dialog on its own: read it (`herdr agent read <target> --source visible`), show it to the user, and only on their say-so respond with `herdr agent send-keys <target> <key>`, then resume with `herdr agent wait <target> --timeout <ms>`.

## Role Contract

- **Coordinator**: the current agent using this skill. Owns orchestration, prompt routing, waiting, repository inspection, and final reporting.
- **Implementation agent** (`impl`): the only writer. It edits files and runs verification.
- **Reviewer** (`reviewer`): Codex in its own pane of the same worktree. It reads the diff and reports findings; it never edits files. Enforce that, do not just state it: before prompting the reviewer, snapshot the tree (`git -C <worktree> status --porcelain` and `git -C <worktree> diff | shasum`), and compare after it settles. Any difference is contamination -- stop the loop, report it, and ask the user how to proceed.

The two agents are never `working` at the same time: the reviewer is prompted only after `impl` settles, and the Fix Prompt goes to `impl` only after the reviewer settles. Panes are this workflow's parallelism, not subagents. The coordinator does not spawn subagents for orchestration, waiting, or inspection.

## Prompting Notes (for maintainers)

Why the prompt templates below are worded the way they are. This section is a note to whoever edits this file, not an instruction to execute.

This skill does not fix the implementation agent's model, so the templates state their requirements outright instead of relying on a model's defaults. Two of them exist specifically to counter documented Claude Opus 5 behavior (Anthropic's "Prompting Claude Opus 5") and are harmless elsewhere: the delegation cap, because Opus 5 delegates to subagents readily and that multiplies cost on small work; and the outcome-first, one-screen summary, because its agentic narration and written deliverables run long and lowering effort does not shorten visible output.

The delegation cap is a default, not a ceiling: when the user asks for parallel work, or the objective genuinely splits into independent tracks, the coordinator raises it in the task section of the implementation prompt -- which is why that rule reads "unless the task above says otherwise". Raising the *count* never relaxes the sole-writer contract, though. Subagents stay read-only, so the implementation agent remains the only thing writing to the tree and the coordinator's diff inspection stays meaningful.

Preserve these two properties when editing:

- **No self-review scaffolding in the implementation or fix prompt.** Do not add "double-check your answer", "re-verify before responding", or "verify with a subagent". The same agent re-grading its own work costs tokens without adding signal, and current models already self-correct. This rule is scoped to an agent checking its own output -- every *cross-agent* check in this workflow stays: the coordinator's own repository inspection (workflow step 5) and the reviewer pane.
- **Never narrow a review by severity.** Do not put "only high-severity issues", "be conservative", or similar into the Review Prompt, the Fix Prompt, or the cycle-2 addendum. A reviewer follows that literally and reports less, and the filtering belongs to the coordinator at step 8, which has the diff and acceptance criteria in hand.

## Agent Lifecycle States

Herdr classifies the agent in a pane as one of five states. The coordinator's decisions key off them, so read them precisely:

- `working` -- the agent is running a turn.
- `idle` / `done` -- the same underlying state: the agent is at its input prompt. `done` is what an unseen background finish looks like; it turns into `idle` once the tab is viewed in the Herdr UI. CLI reads do not mark it seen, so the coordinator usually observes `done`. Treat the two identically, and treat neither as success until the pane output has been read and the completion marker (or a complete result) confirmed.
- `blocked` -- Herdr recognized an approval, question, or permission UI. Detection is deliberately strict: a dialog shape Herdr does not know shows as `idle` instead. That is the second reason a settled state must always be followed by a read.
- `unknown` -- an agent is present but its state cannot be classified. It never proves completion, and the default waits do not match it.

When a state looks wrong (stuck `unknown`, `done` with no marker in the output, a visible dialog reported as `idle`), run `herdr agent explain <target>` and include its output when reporting to the user.

## Pane Setup

1. Inspect Herdr state with `herdr agent list` and, when needed, `herdr pane list --workspace "$HERDR_WORKSPACE_ID"`.
2. Reuse a suitable pane when its cwd matches the target checkout (the worktree path, if one is in play) and its role is clear from recent output or pane labels. Give it a role name so later commands can target it by name: `herdr agent rename <pane-id> impl`. Names must match `[a-z][a-z0-9_-]{0,31}` and be unique among live agents; the name follows the agent and is cleared when it exits.
3. Otherwise create a shell pane for `impl` first -- `agent start` never creates, splits, or moves layout; it needs an existing pane sitting at its interactive shell prompt.

   - Same checkout as the coordinator: split the coordinator's own pane. `--current` targets the calling pane; omitting the target uses whichever pane the UI has focused, which may be in another workspace entirely.

     ```sh
     herdr pane split --current --direction right --cwd <repo> --no-focus
     ```

     Read the new pane from `.result.pane.pane_id`.

   - Git worktree: give the implementation agent its own workspace instead of splitting into the coordinator's. If the worktree is already open as a workspace (`herdr worktree open`, e.g. via `treehouse`), reuse that workspace's root pane from `herdr pane list --workspace <id>` instead of creating another; otherwise:

     ```sh
     herdr workspace create --cwd <worktree-path> --label <branch-or-task> --no-focus
     ```

     Read the pane from `.result.root_pane.pane_id`. One worktree, one workspace: the worktree exists to keep the implementation's file state off the coordinator's checkout, and running both in one workspace hands that back at the UI level -- panes look interchangeable, and a `--cwd` slip drops the agent into the coordinator's checkout unnoticed.

4. Start the implementation agent in that pane:

   ```sh
   herdr agent start impl --kind <kind> --pane <impl-pane-id> --timeout 60000 -- <agent-args...>
   ```

   `--kind` is required and selects the product's canonical executable; run `herdr agent` for the installed list, and ask the user for the kind rather than guessing. Arguments after `--` go to the agent unchanged. Success means Herdr detected the agent and it is ready for input, and the response carries `.result.agent.pane_id` for later pane-level commands. If it returns `agent_not_ready`, the agent came up `blocked` (a trust or onboarding dialog): the name already resolves for `agent read` and `agent send-keys`, so read the dialog, surface it to the user, and once it is cleared run `herdr agent wait impl --timeout 60000` before prompting.

5. Start the reviewer in a second pane of the same worktree, split from the *impl* pane (never from the coordinator's) so it lands in the right workspace and cwd:

   ```sh
   herdr pane split <impl-pane-id> --direction right --cwd <worktree-path> --no-focus
   herdr agent start reviewer --kind codex --pane <review-pane-id> --timeout 60000 -- -m gpt-5.6-sol
   ```

   Codex may show a trust or onboarding dialog on first launch; handle `agent_not_ready` as in step 4. Start the reviewer once and prompt it each cycle -- do not restart it per cycle.

If the implementation role cannot be mapped to an existing pane and no command was provided, ask the user for the implementation agent command.

## Sending Prompts and Waiting

One command submits a prompt and waits for the agent to settle:

```sh
herdr agent prompt <target> "<prompt>" --wait --timeout 1800000
```

`agent prompt` honors the pane's bracketed-paste mode, so the multi-line templates below go through as one submission -- no need to send text, read the composer, and press Enter separately. Do not use `pane run` for prompts; it appends a raw Enter and can submit the first line alone. `--wait` returns on the first settled state, which is `idle`, `done`, or `blocked` by default -- do not restate those with `--until`. Since `blocked` is among the defaults, one long wait is safe: a stalled approval prompt surfaces as soon as it appears instead of hiding behind the timeout. Default the timeout to 30 minutes per step (implementation, review, fix) and report to the user rather than waiting past it.

Outcomes and what to do with each:

- **Success** -- `.result.agent.agent_status` in the JSON says which settled state was reached. In every case, read the output next (below); a settled state is an inspection point, not a result.
- `agent_blocked` -- nothing was sent: the agent was already at a dialog. Read it with `--source visible`, resolve it with the user, then resend.
- `agent_prompt_stalled` -- the text was sent but no lifecycle change followed within five seconds. Read with `--source visible`: if the prompt is sitting unsubmitted in the composer, press `herdr agent send-keys <target> enter` and switch to `herdr agent wait <target> --timeout <ms>`; if the composer is empty, resend.
- **timeout** (exit 1) -- the prompt was delivered and the agent is still not settled. Check `herdr agent get <target>` (this is where `unknown` shows up, since the default wait ignores it), read recent output once for silent prompts or stalled commands, then either `herdr agent wait <target> --timeout <ms>` to keep waiting or report to the user.

The wait tracks lifecycle state, not turns: if the agent is already `working` when the prompt lands, completion of that active turn may satisfy the wait early. Prompt only a settled agent, and confirm the marker on read rather than trusting the wait alone.

**Slash commands** (`/simplify`) are sent the same way. If a pasted leading-slash line ends up sitting in Claude Code's composer instead of running (visible with `--source visible`), fall back to the raw pane surface for that one send: `herdr pane send-text <pane-id> "<command line>"`, read to confirm, then `herdr pane send-keys <pane-id> enter`, and wait with `herdr agent wait <target> --timeout <ms>`.

**Marker wait alternative.** Every prompt template ends with a completion marker, so `herdr pane wait-output <pane-id> --match "HERDR_IMPL_DONE" --timeout <ms>` (or `HERDR_REVIEW_DONE` on the reviewer pane) is a valid alternative to the state wait (pane ID from `.result.agent.pane_id`). It searches the existing snapshot immediately, which is why the templates spell the marker in two parts -- see the note under the Implementation Prompt Template. On timeout still check `agent get` for `blocked`.

## Reading Output

After every settled state:

```sh
herdr agent read <target> --source recent-unwrapped --lines 300
```

Review findings and implementation summaries both run long -- always pass a generous `--lines`. Full-screen agents such as Claude Code render their transcript on the terminal's alternate screen, so rows scrolled off it are not in Herdr's host scrollback; for an *idle* recognized agent, `agent read --lines N` beyond the visible screen makes Herdr page the agent's own viewport and return it to the bottom. That auto-scroll only works on an idle agent: while it is `working`, `blocked`, or `unknown`, a `--lines` larger than the screen returns `agent_not_idle` -- for a blocked dialog use `--source visible` instead. If the completion marker or the end of the findings list is still missing after re-reading with a larger `--lines`, ask the agent (a one-line prompt, not part of the original template) to write its full reply as Markdown to a temporary file and answer with only the path, then read that file.

One rendering trap: Claude Code shows dimmed "ghost text" suggestions in an idle composer (e.g. `commit this` after a completed change), and plain text reads render them indistinguishably from typed input. If unexpected text appears in the input box that neither the coordinator nor the user sent, check with `--format ansi` before reacting -- ghost text is wrapped in the dim attribute (`ESC[2m`). Do not treat it as pending input or as another agent's prompt.

## Coordination Workflow

1. Capture the objective, acceptance criteria, max review cycles, and verification expectations from the user request. Default to 3 review cycles when unspecified.
2. Send the implementation prompt: `herdr agent prompt impl "<Implementation Prompt>" --wait --timeout 1800000`, handling the outcomes as in Sending Prompts and Waiting.
3. Treat every settled state (`idle`, `done`, `blocked`) as an inspection point, never as success on its own; on `blocked`, surface the dialog to the user as described in Preconditions before doing anything else.
4. Read the implementation output (Reading Output) and determine whether the agent finished with the completion marker, stopped after a question, or needs more instruction. Then route the next prompt or ask the user.
5. Inspect repository state yourself with appropriate read-only commands such as `git status`, `git diff`, and test logs. Do not rely only on the implementation agent's summary.
6. Snapshot the tree (Role Contract), then send the Review Prompt to the reviewer: `herdr agent prompt reviewer "<Review Prompt>" --wait --timeout 1800000`.
7. Read the reviewer pane, confirm the `HERDR_REVIEW_DONE` marker and that the findings list is complete, and re-check the tree snapshot for contamination.
8. Evaluate the review result yourself before routing it. Compare findings against the diff, acceptance criteria, and verification output, then classify **each finding individually** -- one review routinely mixes kinds, so never label the review as a whole. Kinds: `actionable fix`, `design/approach challenge` (the review questions the chosen approach, not a point defect), or `needs user decision`. Keep them in a ledger that persists across cycles -- `id`, `first_cycle`, `kind`, `disposition`, `reason` -- so a finding can be followed from the cycle it appeared in to its final state. Without it, findings resolved in cycle 1 vanish the moment cycle 2 comes back clean.

   Dispositions and the only ways to reach them:

   - `routed` -- sent in a Fix Prompt, outcome not yet confirmed. Transient: it leaves for `fixed`, `needs user decision`, `deferred`, or `rejected`. A run may only end with entries still at `routed` when it ends `blocked` or `stopped after max cycles`, and those entries have to be named in the final report.
   - `fixed` -- you read the diff after the fix and confirmed it. A `HERDR_IMPL_DONE` marker or the agent's own claim is not enough.
   - `rejected` -- you judged the finding wrong or inapplicable. Record the reason; this is the coordinator's call and does not need the user. Reachable from `routed` too, when the fix attempt shows the finding does not hold.
   - `deferred` -- real but deliberately out of scope for this run (it would expand scope, or the cycle budget ran out). Needs the user's agreement, so surface it rather than deciding alone.
   - `needs user decision` -- with the user and still unanswered. Two things land here: a `design/approach challenge` the moment you raise it with the user (step 9), and a `routed` finding the implementation agent stopped on instead of fixing (scope expansion, credentials, destructive change, unsettled product judgment -- the stop conditions in the Fix Prompt). Once the user answers, it moves on to `routed`, `deferred`, or `rejected`.

   Also add the implementation agent's verification result to the ledger: a failing or unrun required verification is an `actionable fix` finding in its own right, even when the review is clean. A clean review over a red test suite is not a passing cycle.
9. Route by finding, not by review. Send all `actionable fix` findings to `impl` -- never to `reviewer` -- in one Fix Prompt without asking the user, mark them `routed`, wait for the fix (as in steps 2-5), confirm it in the diff, then repeat from step 6 to re-review. Do not auto-route a `design/approach challenge` -- raise it with the user, unless it resolves to a small, unambiguous point patch. A review holding both kinds is the normal case: route the actionable ones and raise the rest in the same turn, rather than stalling the whole cycle or auto-fixing past a design question -- unless an unanswered question governs the same code the actionable fixes touch, in which case send nothing and wait, since fixing under a decision that may reverse just wastes a cycle. Do not start another review cycle while a `needs user decision` finding is still open. Escalate to the user when a fix would expand scope, need credentials or external approval, risk destructive changes, conflict with acceptance criteria, or turn on a product judgment the agent cannot make.
10. Repeat implementation -> review until every ledger entry is `fixed`, `rejected`, or `deferred` with the user's agreement; the max cycle count is reached; or a blocker needs user input. Prefer continuing the loop over stopping for routine review comments.
11. Once the loop exits with every ledger entry resolved, run a simplification pass in the implementation pane: `herdr agent prompt impl "/simplify" --wait --timeout 1800000` -- send *only* the command, since anything after the command name becomes its arguments. Read the pane afterwards. `/simplify` edits files, so it goes to the implementation pane and nowhere else; it is a Claude Code command, so skip it when the implementation agent is a different product. Inspect the resulting diff yourself, and if it changed, send a one-line prompt asking the agent to rerun the relevant verification and report the result -- if it fails, have the agent fix or revert the simplification before the final report. Do not start another review cycle on top of it. Skip the pass entirely when the run ends `blocked` or `stopped after max cycles` -- cleanup layered over unresolved findings just obscures what is left.
12. Finish with final status, files changed, verification run, review result, simplification result, and remaining risks.

## Implementation Prompt Template

Send a prompt shaped like this to the implementation agent:

```text
You are the implementation agent.

Task:
<objective>

Acceptance criteria:
<criteria>

Rules:
- Before any investigation or implementation work, invoke
  `$ponytail:ponytail full`. If that skill is unavailable, stop and report
  instead of coding.
- You are the only agent allowed to edit files.
- Preserve unrelated user changes.
- Keep changes scoped to the task, and finish the whole task -- no stubs,
  placeholders, or "TODO: wire this up".
- Make routine judgment calls yourself and keep going. Stop and report instead
  when the work would need scope expansion, credentials or external approval, or
  destructive changes; would conflict with the acceptance criteria; or turns on a
  product judgment the criteria do not settle, or an ambiguity where different
  readings produce materially different work. If the request merely looks
  suboptimal to you, say so in one sentence and do it as asked rather than quietly
  narrowing, widening, or transforming it.
- Run the project's own verification commands (tests, build, lint) for what you
  changed, or explain why they could not be run. Do not add a self-review or
  double-check pass beyond that -- an independent review runs next.
- Do not spawn subagents unless the task above says otherwise, and never more than
  one, only for a large, genuinely independent track of work you cannot finish
  yourself. Any subagent is read-only -- investigation and search, never edits, and
  never to verify or double-check your own work. You stay the only writer.
- While working, give a brief update only when you find something important or
  change direction.
- Finish with a summary that leads with the outcome, then lists files changed,
  verification run and its result, and unresolved issues. Keep it to roughly one
  screen: cover the substance, no filler sections or restated boilerplate.
- After this, the coordinator will put your diff in front of an independent
  reviewer running in another pane of this worktree. Stay in this pane rather
  than exiting.

When completely finished, end your reply with the completion marker formed by
joining "HERDR_IMPL_" and "DONE" into a single word.
```

The prompt spells the marker in two parts on purpose. The prompt itself gets echoed into the pane transcript, and `pane wait-output` searches the existing snapshot immediately, so if the prompt contained the literal marker, any check for it -- a scan of `agent read` output, or `pane wait-output --match` -- would match the echo of the prompt instead of actual completion. With the split spelling, the joined marker only appears when the agent really finished. The same applies to the review marker below.

## Review Prompt Template

Send this to the reviewer each cycle:

```text
You are an independent adversarial reviewer. Review the current uncommitted
diff in this worktree (`git diff`, plus any untracked files from `git status`)
against this task.

Task:
<objective>

Acceptance criteria:
<criteria>

Rules:
- Do not edit files, run formatters, or stage anything. Read-only commands only.
- Challenge the approach, design choices, and assumptions behind the change, not
  just point defects. Check the diff actually meets the acceptance criteria.
- Report every material finding. Do not pre-filter by severity; the coordinator
  decides what gets fixed.
- Keep each finding compact: the claim, a concrete failure scenario, and a
  concrete fix. Findings first, ordered by severity, then separate required
  fixes from design challenges and optional suggestions. No preamble.
- If you find nothing material, say so explicitly.

When completely finished, end your reply with the marker formed by joining
"HERDR_REVIEW_" and "DONE" into a single word.
```

From cycle 2 on, insert this block before the Rules, worded so the list is not read as the review's scope:

```text
Since your last review, these findings were sent for fixing:
<routed findings with ids>
Confirm whether each is actually resolved in the current diff, and review the
whole diff afresh -- the fixes may have introduced new problems.
```

Do not narrow the review from here ("only high-severity issues", "be conservative", "skip nits"). A reviewer follows that literally and reports less, and the filtering it would then do blind is exactly what the coordinator does at step 8 with the diff and acceptance criteria in hand.

## Fix Prompt Template

When review findings need fixes, send only the actionable findings to `impl`:

```text
The independent adversarial review found these issues. Please fix only these issues and keep the diff scoped:

<findings>

Fix exactly these findings at the scope stated. Do not widen the change to
neighboring cleanups, and do not narrow it by skipping a finding you disagree
with -- if a finding is wrong, say so in one sentence and leave that code alone.

After fixing, rerun the relevant verification and report the result. No extra
self-review pass beyond that; the coordinator re-runs the independent review next.
Lead the summary with the outcome and keep it short.

Do not wait for user confirmation. Stop and report instead when a fix would need
scope expansion, credentials or external approval, or destructive changes; would
conflict with the acceptance criteria; or turns on a product judgment the criteria
do not settle, or an ambiguity where different readings produce materially
different work.

When completely finished, end your reply with the completion marker formed by
joining "HERDR_IMPL_" and "DONE" into a single word.
```

## Final Report

Lead with the outcome in one sentence, then the fields below. Cover the substance and stop -- do not restate the loop's history, re-summarize each cycle, or pad with sections that carry no new information:

- `status`: complete, blocked, or stopped after max cycles. `complete` requires every ledger entry resolved (`fixed`, `rejected`, or user-agreed `deferred`) *and* the required verification passing. A finding still sitting at `routed` or `needs user decision`, or a red test suite, makes this `blocked` or `stopped after max cycles` -- never `complete`
- `changed`: files changed or high-level diff summary
- `verified`: commands run and results
- `review`: the finding ledger across *all* cycles, each with its final disposition (`fixed`, `deferred`, `rejected` + reason, `needs user decision`, or an unconfirmed `routed`). Report `no findings` only when no cycle ever produced one -- a clean final cycle does not erase what earlier cycles found and fixed
- `simplified`: what the `/simplify` pass changed, or why it was skipped
- `risks`: anything not verified or requiring user judgment

## Alternative: In-Process Review

Only when the user explicitly asks for a single pane and `impl` is Claude Code with the `codex` plugin (marketplace `openai-codex`) installed: skip Pane Setup step 5 and, at workflow step 6, have `impl` run the review itself:

```sh
herdr agent prompt impl "/codex:adversarial-review --wait Review against this task: <objective>. Acceptance criteria: <criteria>." --wait --timeout 1800000
```

The inner `--wait` belongs to the plugin command (Codex runs in the foreground); the outer one is herdr's. Everything after the command name becomes Codex's focus text, so keep it on one line, add no instructional prose, and never narrow it by severity. The command returns Codex's output verbatim with nothing appended, so there is no `HERDR_REVIEW_DONE` marker here -- at step 7, verify from the read that findings are present rather than a stalled approval prompt. The plugin applies its own material-findings bar (`Report only material findings`) that focus text cannot override. Requires the pane to run `Bash(node:*)` and `Bash(git:*)` without approval prompts. Everything else in the workflow is unchanged.
