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

## Pane Setup

1. Inspect Herdr state with `herdr agent list` and, when needed, `herdr pane list`.
2. Reuse a suitable pane when its cwd matches the target repo and its role is clear from recent output or pane labels.
3. If no implementation pane exists and the user supplied a command, create it with `herdr agent start` -- one command that splits, runs, and names the agent:

```sh
herdr agent start impl --cwd <repo> --split right --no-focus -- <agent-command...>
```

`--split` is resolved against the herdr instance's currently *focused* pane, not the pane the coordinator is running in -- if the user has another workspace focused, the new pane lands there, next to unrelated agents. After starting, verify placement from the JSON output (`result.agent.workspace_id` / `tab_id`) and, if it landed in the wrong place, move it (`herdr pane move`) or pass `--workspace <id>` explicitly.

Naming the agent matters: `herdr agent` subcommands (`send`, `read`, `rename`) accept the unique agent name as a target, which sidesteps the pane-ID instability warned about above. Prefer the name as the target where accepted; parse the pane ID from the command's JSON output (`result.agent.pane_id`) or from `herdr agent list` for the `herdr wait` and `herdr pane` commands that need one. If `agent start` is unavailable in the installed herdr version, fall back to a split plus run:

```sh
herdr pane split <current-pane-id> --direction right --cwd <repo> --no-focus
herdr pane run <new-pane-id> "<agent-command>"
```

4. If the command output returns JSON with a new pane ID, parse it instead of guessing the ID.
5. When reusing an existing pane, rename it to a role label (`herdr agent rename <target> impl`) so later commands can target it by name.

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
- If the target pane reaches `done`, `blocked`, or `idle`, immediately read recent output with `herdr pane read <pane-id> --source recent-unwrapped --lines 200`. Codex findings and implementation summaries can be long -- always pass a generous `--lines` so the result is not truncated.
- If the target pane stays non-terminal for 10 minutes without visible progress, read recent output once to check for silent prompts, stalled commands, or missing user input, then continue the loop.
- Give the loop an overall deadline -- default 30 minutes for the implementation step and again for the review step -- and report to the user rather than looping past it.
- Do not treat `idle` as success until the coordinator has read the pane output and confirmed the completion marker (see the prompt templates) or a complete result.

## Coordination Workflow

1. Capture the objective, acceptance criteria, max review cycles, and verification expectations from the user request. Default to 3 review cycles when unspecified.
2. Send the implementation prompt to the implementation pane.
3. Wait for the implementation agent using the Status Polling Cadence -- a loop of short `herdr wait agent-status <pane-id> --status done --timeout 30000` calls with `herdr agent list` checks between them, not one long blocking wait (which would hide a `blocked` pane for its whole duration). Treat `idle` like `blocked` for coordination purposes: read recent output, determine whether the agent finished without the completion marker, stopped after a prompt, or needs more instruction, then route the next prompt or ask the user. Do not assume `idle` means success.

4. Read recent implementation output:

```sh
herdr pane read <implementation-pane-id> --source recent-unwrapped --lines 200
```

5. Inspect repository state yourself with appropriate read-only commands such as `git status`, `git diff`, and test logs. Do not rely only on the implementation agent's summary.
6. Send the Review Prompt to the same implementation pane, instructing it to run `/codex:adversarial-review` itself.
7. There is no sentinel for this step -- the command's own contract forces the pane to output Codex's review verbatim with nothing before or after, so it will not append a marker like `HERDR_REVIEW_DONE`. Detect completion purely through the Status Polling Cadence: wait for the pane to reach `done`, `blocked`, or `idle`, then read recent output. Treat `idle` as a required inspection point, not a clean review result; verify whether the review actually completed (Codex's findings are present) or the pane stalled (e.g. on an approval prompt) before assuming it finished.
8. Evaluate the review result yourself before routing it. Compare findings against the diff, acceptance criteria, and verification output, then classify the result as `no findings`, `actionable fixes`, `design/approach challenge`, or `blocked/needs user input`.
9. For actionable fixes, automatically send a Fix Prompt to the implementation pane without asking the user, wait for it to finish the fix (as in steps 3-5), then repeat from step 6 to re-review. Ask the user only when the fix would expand scope, require credentials or external approval, risk destructive changes, conflict with acceptance criteria, or require a product judgment the agent cannot make. Treat a `design/approach challenge` (the review questions the chosen approach itself, not a point defect) as needing user input rather than auto-routing a Fix Prompt, unless it resolves to a small, unambiguous point patch.
10. Repeat implementation -> review until the review reports no findings, the max cycle count is reached, or a blocker needs user input. Prefer continuing the loop over stopping for routine review comments.
11. Finish with final status, files changed, verification run, review result, and remaining risks.

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
- Keep changes scoped to the task.
- Preserve unrelated user changes.
- Run the relevant verification commands, or explain why they could not be run.
- When finished, summarize files changed, verification run, and unresolved issues.
- After this, the coordinator will ask you to review your own diff using a Codex command -- stay in this pane rather than exiting.

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
- Do not add instructional prose ("let it run to completion", "don't fix anything yet") -- it would be read as more focus text for Codex, polluting what it's told to review against.
- Do not ask for a `HERDR_REVIEW_DONE` sentinel here -- the command suppresses any commentary the pane would otherwise add, so the sentinel would never appear. Detect completion via the Status Polling Cadence instead (see Coordination Workflow step 7).

## Fix Prompt Template

When review findings need fixes, send only the actionable findings:

```text
The Codex adversarial review found these issues. Please fix only these issues and keep the diff scoped:

<findings>

After fixing, rerun the relevant verification and summarize the result.
Do not wait for user confirmation unless you are blocked by scope, credentials, destructive changes, or conflicting requirements.

When completely finished, end your reply with the completion marker formed by
joining "HERDR_IMPL_" and "DONE" into a single word.
```

## Final Report

Keep the final report concise:

- `status`: complete, blocked, or stopped after max cycles
- `changed`: files changed or high-level diff summary
- `verified`: commands run and results
- `review`: no findings or remaining findings
- `risks`: anything not verified or requiring user judgment

## Fallback: Separate Review Agent

Use this only when the user explicitly asks for an independent reviewer pane (a different product, or isolation stronger than an in-process command call), or when the implementation pane cannot run `/codex:adversarial-review` at all.

1. Bootstrap a second pane the same way as the implementation pane, running the user-specified review command (or `codex` if the user just wants "a separate agent" without naming a product):

```sh
herdr agent start review --cwd <repo> --split right --no-focus -- <review-agent-command...>
```

(Or the split-plus-run fallback from Pane Setup if `agent start` is unavailable.)

2. Never allow the implementation and review agents to edit files concurrently in this mode. If the review agent changes files, stop the loop, report the contamination, and ask the user how to proceed.
3. Send it the adversarial framing from the shared `adversarial-review` skill (`$HOME/.agents/skills/adversarial-review`). Only use the `$adversarial-review` marker if the product is known to resolve `$<skill-name>` markers -- verify rather than assume: after sending, read the pane, and if the marker text appears unexpanded in the agent's reply, it did not resolve; resend with the framing inlined. When inlining (the safe default for an unknown product), state: do not edit files; question the approach and assumptions, not just defects; findings first, ordered by severity; separate required fixes from design challenges and optional suggestions; end with the marker formed by joining "HERDR_REVIEW_" and "DONE" into a single word (split for the same echo reason as the implementation prompt's marker).
4. Otherwise, follow the same Coordination Workflow steps 6-9 against this separate pane instead of the implementation pane.
