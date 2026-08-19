---
name: herdr-agent-workflow
description: Coordinate an implementation-and-review workflow inside Herdr. Use when the user wants an agent to implement changes and then adversarially review its own diff, with a coordinator managing panes, prompts, waiting, review cycles, and final reporting. The default path requires the implementation agent to be Claude Code with the `codex` plugin installed, since review runs in-process via `/codex:adversarial-review` rather than in a separate review pane; any other agent product goes through the separate-review-pane fallback.
---

# Herdr Agent Workflow

## Overview

Use Herdr to run an implementation loop in a single agent pane. By default, the same pane that implements the change also runs the review step: it invokes `/codex:adversarial-review` (from the `codex` plugin) to get an adversarial critique from Codex, instead of a second agent/pane being spun up.

Independence of the review is preserved by Codex itself, not by pane separation: `/codex:adversarial-review` shells out to the Codex CLI as a fresh, separate process against the current diff. Codex has no access to the implementation agent's reasoning or conversation history, so the critique is still adversarial and independent even though the same pane issues the command. Do not reintroduce a separate review pane by default on the theory that "the agent is grading its own homework" -- it isn't; Codex is the grader.

Only fall back to a separate, independent review agent pane when the user explicitly asks for one (different reviewer product, or stronger isolation than an in-process command call) or when the implementation agent cannot run the codex plugin at all. See "Fallback: Separate Review Agent" at the end of this file.

## Preconditions

- Run only inside Herdr. If `HERDR_ENV=1` is not set or `herdr` commands cannot reach the socket, tell the user to start the coordinator from a Herdr pane.
- Treat pane IDs as opaque and unstable. Inspect current state before using them.
- Do not hard-code agent product names when picking the implementation pane. Use existing panes or user-provided commands.
- Exception: the default review path requires the implementation pane to run Claude Code with the `codex` plugin (marketplace `openai-codex`) installed, since that plugin provides `/codex:adversarial-review`. If the implementation agent is a different product, or Claude Code without that plugin, this in-process path is unavailable -- use the Fallback section instead of guessing.
- The implementation pane needs permission to run `Bash(node:*)` and `Bash(git:*)` non-interactively (the command shells out to `codex-companion.mjs`, which shells out to `git`). If those are gated behind an approval prompt, the pane will stall on it and the coordinator has no way to clear it remotely -- check permissions before relying on this path, or expect to treat a long-idle pane as blocked-on-approval rather than done.

## Role Contract

- **Coordinator**: the current agent using this skill. Owns orchestration, prompt routing, waiting, repository inspection, and final reporting.
- **Implementation agent**: the only writer, and the only pane in the default path. It edits files, runs verification, and -- when the coordinator asks it to -- runs the review step itself by invoking `/codex:adversarial-review`, which reviews the diff without editing anything.

With one pane and a foreground (`--wait`) review call, the review step blocks the implementation agent's turn, so implementation and review can never run concurrently in the default path. That guard only matters again in the Fallback section, where a second pane exists.

Panes are this workflow's parallelism, not subagents. The coordinator drives one implementation pane -- plus one review pane in the Fallback path -- and does not spawn subagents for orchestration, waiting, or inspection.

## Prompting Notes (for maintainers)

Why the prompt templates below are worded the way they are. This section is a note to whoever edits this file, not an instruction to execute.

This skill does not fix the implementation agent's model, so the templates state their requirements outright instead of relying on a model's defaults. Two of them exist specifically to counter documented Claude Opus 5 behavior (Anthropic's "Prompting Claude Opus 5") and are harmless elsewhere: the delegation cap, because Opus 5 delegates to subagents readily and that multiplies cost on small work; and the outcome-first, one-screen summary, because its agentic narration and written deliverables run long and lowering effort does not shorten visible output.

The delegation cap is a default, not a ceiling: when the user asks for parallel work, or the objective genuinely splits into independent tracks, the coordinator raises it in the task section of the implementation prompt -- which is why that rule reads "unless the task above says otherwise". Raising the *count* never relaxes the sole-writer contract, though. Subagents stay read-only, so the implementation agent remains the only thing writing to the tree and the coordinator's diff inspection stays meaningful.

Preserve these two properties when editing:

- **No self-review scaffolding in the implementation or fix prompt.** Do not add "double-check your answer", "re-verify before responding", or "verify with a subagent". The same agent re-grading its own work costs tokens without adding signal, and current models already self-correct. This rule is scoped to an agent checking its own output -- every *cross-agent* check in this workflow stays: the coordinator's own repository inspection (workflow step 5), the Codex review, and the Fallback reviewer pane.
- **Never narrow a review by severity.** Do not put "only high-severity issues", "be conservative", or similar into the focus text, the Fix Prompt, or the Fallback framing. A reviewer follows that literally and reports less, and the filtering belongs to the coordinator at step 8, which has the diff and acceptance criteria in hand. This is a rule against *tightening* the bar, not a promise the coordinator sees every nit: `/codex:adversarial-review` enforces its own material-findings bar (`Report only material findings`, `Prefer one strong finding over several weak ones`) in the plugin's prompt, and focus text cannot reliably override it.

## Pane Setup

1. Inspect Herdr state with `herdr agent list` and, when needed, `herdr pane list`.
2. Reuse a suitable pane when its cwd matches the target checkout (the worktree path, if one is in play) and its role is clear from recent output or pane labels.
3. If the implementation agent works in a git worktree rather than the coordinator's own checkout, give it its own workspace instead of splitting into the coordinator's:

```sh
herdr workspace create --cwd <worktree-path> --label <branch-or-task> --no-focus
```

Parse `result.root_pane.pane_id` from the JSON and start the agent in that pane, instead of the split path below. One worktree, one workspace: the worktree exists to keep the implementation's file state off the coordinator's checkout, and running both in one workspace hands that back at the UI level -- panes look interchangeable, and a `--split`/`--cwd` slip drops the agent into the coordinator's checkout unnoticed. Without a worktree (agent edits the same checkout the coordinator inspects), the split path is fine.

4. If no implementation pane exists and the user supplied a command, create it with `herdr agent start` -- one command that splits, runs, and names the agent:

```sh
herdr agent start impl --cwd <repo> --split right --no-focus -- <agent-command...>
```

`--split` is resolved against the herdr instance's currently *focused* pane, not the pane the coordinator is running in -- if the user has another workspace focused, the new pane lands there, next to unrelated agents. After starting, verify placement from the JSON output (`result.agent.workspace_id` / `tab_id`) and, if it landed in the wrong place, move it (`herdr pane move`) or pass `--workspace <id>` explicitly.

Naming the agent matters: `herdr agent` subcommands (`send`, `read`, `rename`) accept the unique agent name as a target, which sidesteps the pane-ID instability warned about above. Prefer the name as the target where accepted; parse the pane ID from the command's JSON output (`result.agent.pane_id`) or from `herdr agent list` for the `herdr wait` and `herdr pane` commands that need one. If `agent start` is unavailable in the installed herdr version, fall back to a split plus run:

```sh
herdr pane split <current-pane-id> --direction right --cwd <repo> --no-focus
herdr pane run <new-pane-id> "<agent-command>"
```

5. If the command output returns JSON with a new pane ID, parse it instead of guessing the ID.
6. When reusing an existing pane, rename it to a role label (`herdr agent rename <target> impl`) so later commands can target it by name.

If the implementation role cannot be mapped to an existing pane and no command was provided, ask the user for the implementation agent command.

## Sending Prompts to a Pane

The implementation and fix prompts are multi-line. Do not deliver them with `herdr pane run` -- it appends a real Enter, and depending on how the pane handles embedded newlines, the first line may get submitted alone with the rest arriving as stray follow-up input. Instead:

1. Send the full prompt as literal text, no Enter: `herdr agent send <target> "<prompt>"`.
2. Read the pane (`herdr pane read <pane-id> --source visible`) and confirm the whole prompt is sitting in the agent's input box, not partially submitted. Claude Code renders a multi-line send as a collapsed paste (`[Pasted text #N +K lines]`) -- that counts as confirmed. The composer can also render a beat behind the send: if the input box looks empty on the first read, re-read before concluding the text was lost or re-sending it.
3. Submit it: `herdr pane send-keys <pane-id> Enter`.

The single-line Review Prompt can be sent the same way. The point of the read-before-Enter step is that nothing gets submitted until the coordinator has seen the composed input -- a truncated or split prompt is caught before it runs, not after.

One rendering trap: Claude Code shows dimmed "ghost text" suggestions in an idle composer (e.g. `commit this` after a completed change), and plain `pane read` renders them indistinguishably from typed input. If unexpected text appears in the input box that neither the coordinator nor the user sent, check with `pane read --format ansi` before reacting -- ghost text is wrapped in the dim attribute (`ESC[2m`). Do not treat it as pending input or as another agent's prompt.

## Status Polling Cadence

Do not assume event-driven status notifications, and do not block on one long wait: `herdr wait agent-status` watches a single status at a time, so a long blocking wait for `done` would leave a `blocked` pane (for example, stalled on an approval prompt -- see Preconditions) undetected for the entire timeout. Poll with a loop of short waits instead:

- Immediately after sending a prompt, confirm the target pane is mapped correctly with `herdr agent list`.
- Loop: `herdr wait agent-status <pane-id> --status done --timeout 30000`. Success means the pane is done. On timeout (exit code 1), run `herdr agent list` and check the pane's `agent_status` for `blocked` or `idle` before waiting again.
- If the target pane reaches `done`, `blocked`, or `idle`, immediately read recent output with `herdr pane read <pane-id> --source recent-unwrapped --lines 300`. Codex findings and Opus-5 implementation summaries both run long -- always pass a generous `--lines` so the result is not truncated. If the completion marker or the end of the findings list is not in the read, re-read with a larger `--lines` before concluding the step is incomplete.
- If the target pane stays non-terminal for 10 minutes without visible progress, read recent output once to check for silent prompts, stalled commands, or missing user input, then continue the loop.
- Give the loop an overall deadline -- default 30 minutes for the implementation step and again for the review step -- and report to the user rather than looping past it.
- Do not treat `idle` as success until the coordinator has read the pane output and confirmed the completion marker (see the prompt templates) or a complete result.

## Coordination Workflow

1. Capture the objective, acceptance criteria, max review cycles, and verification expectations from the user request. Default to 3 review cycles when unspecified.
2. Send the implementation prompt to the implementation pane.
3. Wait for the implementation agent using the Status Polling Cadence -- a loop of short `herdr wait agent-status <pane-id> --status done --timeout 30000` calls with `herdr agent list` checks between them, not one long blocking wait (which would hide a `blocked` pane for its whole duration). Treat `idle` like `blocked` for coordination purposes: read recent output, determine whether the agent finished without the completion marker, stopped after a prompt, or needs more instruction, then route the next prompt or ask the user. Do not assume `idle` means success.

4. Read recent implementation output:

```sh
herdr pane read <implementation-pane-id> --source recent-unwrapped --lines 300
```

5. Inspect repository state yourself with appropriate read-only commands such as `git status`, `git diff`, and test logs. Do not rely only on the implementation agent's summary.
6. Send the Review Prompt to the same implementation pane, instructing it to run `/codex:adversarial-review` itself.
7. There is no sentinel for this step -- the command's own contract forces the pane to output Codex's review verbatim with nothing before or after, so it will not append a marker like `HERDR_REVIEW_DONE`. Detect completion purely through the Status Polling Cadence: wait for the pane to reach `done`, `blocked`, or `idle`, then read recent output. Treat `idle` as a required inspection point, not a clean review result; verify whether the review actually completed (Codex's findings are present) or the pane stalled (e.g. on an approval prompt) before assuming it finished.
8. Evaluate the review result yourself before routing it. Compare findings against the diff, acceptance criteria, and verification output, then classify **each finding individually** -- one review routinely mixes kinds, so never label the review as a whole. Kinds: `actionable fix`, `design/approach challenge` (the review questions the chosen approach, not a point defect), or `needs user decision`. Keep them in a ledger that persists across cycles -- `id`, `first_cycle`, `kind`, `disposition`, `reason` -- so a finding can be followed from the cycle it appeared in to its final state. Without it, findings resolved in cycle 1 vanish the moment cycle 2 comes back clean.

   Dispositions and the only ways to reach them:

   - `routed` -- sent in a Fix Prompt, outcome not yet confirmed. Transient: it leaves for `fixed`, `needs user decision`, `deferred`, or `rejected`. A run may only end with entries still at `routed` when it ends `blocked` or `stopped after max cycles`, and those entries have to be named in the final report.
   - `fixed` -- you read the diff after the fix and confirmed it. A `HERDR_IMPL_DONE` marker or the agent's own claim is not enough.
   - `rejected` -- you judged the finding wrong or inapplicable. Record the reason; this is the coordinator's call and does not need the user. Reachable from `routed` too, when the fix attempt shows the finding does not hold.
   - `deferred` -- real but deliberately out of scope for this run (it would expand scope, or the cycle budget ran out). Needs the user's agreement, so surface it rather than deciding alone.
   - `needs user decision` -- with the user and still unanswered. Two things land here: a `design/approach challenge` the moment you raise it with the user (step 9), and a `routed` finding the implementation agent stopped on instead of fixing (scope expansion, credentials, destructive change, unsettled product judgment -- the stop conditions in the Fix Prompt). Once the user answers, it moves on to `routed`, `deferred`, or `rejected`.

   Also add the implementation agent's verification result to the ledger: a failing or unrun required verification is an `actionable fix` finding in its own right, even when the review is clean. A clean review over a red test suite is not a passing cycle.
9. Route by finding, not by review. Send all `actionable fix` findings to the implementation pane in one Fix Prompt without asking the user, mark them `routed`, wait for the fix (as in steps 3-5), confirm it in the diff, then repeat from step 6 to re-review. Do not auto-route a `design/approach challenge` -- raise it with the user, unless it resolves to a small, unambiguous point patch. A review holding both kinds is the normal case: route the actionable ones and raise the rest in the same turn, rather than stalling the whole cycle or auto-fixing past a design question -- unless an unanswered question governs the same code the actionable fixes touch, in which case send nothing and wait, since fixing under a decision that may reverse just wastes a cycle. Do not start another review cycle while a `needs user decision` finding is still open. Escalate to the user when a fix would expand scope, need credentials or external approval, risk destructive changes, conflict with acceptance criteria, or turn on a product judgment the agent cannot make.
10. Repeat implementation -> review until every ledger entry is `fixed`, `rejected`, or `deferred` with the user's agreement; the max cycle count is reached; or a blocker needs user input. Prefer continuing the loop over stopping for routine review comments.
11. Once the loop exits with every ledger entry resolved, run a simplification pass in the implementation pane: send `/simplify` and *only* that -- anything after the command name becomes its arguments. Wait with the Status Polling Cadence, then read the pane. `/simplify` edits files, so it goes to the implementation pane and nowhere else; it is a Claude Code command, so skip it when the implementation agent is a different product. Inspect the resulting diff yourself, and if it changed, send a one-line prompt asking the agent to rerun the relevant verification and report the result -- if it fails, have the agent fix or revert the simplification before the final report. Do not start another review cycle on top of it. Skip the pass entirely when the run ends `blocked` or `stopped after max cycles` -- cleanup layered over unresolved findings just obscures what is left.
12. Finish with final status, files changed, verification run, review result, simplification result, and remaining risks.

If `/codex:adversarial-review` is unavailable in the implementation pane (command not found, plugin missing, non-Claude-Code product) or repeatedly errors, stop and ask the user whether to fall back to a separate review agent pane (see Fallback) or a different review method, rather than silently skipping review.

## Implementation Prompt Template

Send a prompt shaped like this to the implementation agent:

```text
You are the implementation agent.

Task:
<objective>

Acceptance criteria:
<criteria>

Rules:
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
- After this, the coordinator will put your diff in front of an independent reviewer -- in the default path, by asking you to run a Codex review command in this pane. Stay in this pane rather than exiting.

When completely finished, end your reply with the completion marker formed by
joining "HERDR_IMPL_" and "DONE" into a single word.
```

The prompt spells the marker in two parts on purpose. The prompt itself gets echoed into the pane transcript, so if it contained the literal marker, any check for it -- a scan of `pane read` output, or `herdr wait output --match` -- would match the echo of the prompt instead of actual completion. With the split spelling, the joined marker only appears when the agent really finished, which also makes `herdr wait output <pane-id> --match "HERDR_IMPL_DONE" --timeout 30000` a valid alternative wait for the implementation and fix steps (on timeout, still check agent status for `blocked` as in the Status Polling Cadence).

## Review Prompt Template

Send this to the same implementation pane, and send *only* this -- no leading or trailing prose:

```text
/codex:adversarial-review --wait Review against this task: <objective>. Acceptance criteria: <criteria>.
```

Everything after the command name becomes Codex's focus text, and the command's own contract already forces the pane to return Codex's output verbatim with nothing before or after (see `commands/adversarial-review.md` in the `codex` plugin). So:

- Keep the focus text on the same line as the command, with no embedded newlines -- a newline would either get folded into the focus text or, depending on how the pane splits input, get treated as a separate line the model isn't expecting.
- Do not add instructional prose ("let it run to completion", "don't fix anything yet") -- it would be read as more focus text for Codex, polluting what it's told to review against. That includes collection policy: the plugin's own prompt already sets the finding bar and weights the focus text heavily, so a "report everything" clause buys nothing and dilutes the objective it is appended to.
- Above all, do not narrow the review from here ("only high-severity issues", "be conservative", "skip nits"). A reviewer follows that literally and reports less, and the filtering it would then do blind is exactly what the coordinator does at step 8 with the diff and acceptance criteria in hand.
- Do not ask for a `HERDR_REVIEW_DONE` sentinel here -- the command suppresses any commentary the pane would otherwise add, so the sentinel would never appear. Detect completion via the Status Polling Cadence instead (see Coordination Workflow step 7).

## Fix Prompt Template

When review findings need fixes, send only the actionable findings:

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

## Fallback: Separate Review Agent

Use this only when the user explicitly asks for an independent reviewer pane (a different product, or isolation stronger than an in-process command call), or when the implementation pane cannot run `/codex:adversarial-review` at all.

1. Bootstrap a second pane the same way as the implementation pane, running the user-specified review command (or `codex` if the user just wants "a separate agent" without naming a product):

```sh
herdr agent start review --cwd <repo> --split right --no-focus -- <review-agent-command...>
```

(Or the split-plus-run fallback from Pane Setup if `agent start` is unavailable.) The reviewer reads the same tree the implementation agent edits, so `--cwd` is that checkout -- and when that is a worktree, the review pane belongs in the implementation agent's workspace (`--workspace <id>`), not the coordinator's.

2. Never allow the implementation and review agents to edit files concurrently in this mode. If the review agent changes files, stop the loop, report the contamination, and ask the user how to proceed.
3. Send it the adversarial framing from the shared `adversarial-review` skill (`$HOME/.agents/skills/adversarial-review`). Only use the `$adversarial-review` marker if the product is known to resolve `$<skill-name>` markers -- verify rather than assume: after sending, read the pane, and if the marker text appears unexpanded in the agent's reply, it did not resolve; resend with the framing inlined. When inlining (the safe default for an unknown product), state: do not edit files; question the approach and assumptions, not just defects; report every material finding without pre-filtering by severity, since the coordinator does the filtering at step 8; keep each finding compact -- a claim, its failure scenario, and a concrete fix -- so the whole list survives one `pane read`; findings first, ordered by severity; separate required fixes from design challenges and optional suggestions; end with the marker formed by joining "HERDR_REVIEW_" and "DONE" into a single word (split for the same echo reason as the implementation prompt's marker).
4. From here the Coordination Workflow still applies, but steps 6-9 split across two panes -- do not send them all to one. The Review Prompt Template does **not** apply: it is a `/codex:adversarial-review` invocation, and the reviewer here is generally not Codex. Concretely:

   - **step 6** -- send the inlined framing from item 3 to the *review* pane, not the review command.
   - **step 7** -- wait on the *review* pane with the Status Polling Cadence. Unlike the default path there *is* a sentinel here (`HERDR_REVIEW_DONE`), so `herdr wait output <review-pane-id> --match "HERDR_REVIEW_DONE"` is available alongside the status loop.
   - **step 8** -- unchanged: the coordinator classifies and keeps the ledger.
   - **step 9** -- the Fix Prompt always goes to the *implementation* pane. Never send it to the review pane; that pane must not edit files (item 2). Confirm the fix in the diff yourself, then loop back to step 6 against the review pane.
