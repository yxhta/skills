---
name: swarm
description: Run a planner/worker agent swarm on a large task. Use when the user says "run a swarm", "fan this out", "parallelize this across agents", or hands over work big enough that a single agent would drift: implementing a spec or RFC end to end, porting or rewriting a subsystem, building something from a document, or sweeping a whole codebase (test coverage, a migration, a batch of fixes). Do NOT use when the task fits comfortably in one agent's context or splits into fewer than three genuinely independent units — coordination overhead loses to just doing the work.
argument-hint: [task or path to a spec] [--workers <models>] [--reviewers <list>] [--codex-model <name>] [--codex-effort <level>]
---

# Swarm

## Overview

A swarm is two roles held by different agents. The **planner** (this session, on the most
capable model) decomposes the goal and makes every design decision. **Workers** (subagents on
cheap models) execute single leaves and decide nothing.

The reason this scales is context efficiency, not parallelism. One agent running a long task has
to hold the ancestors, its current position, and the overall goal in context simultaneously —
focus on the leaf and it loses the shape, hold the shape and the leaf comes out badly. Splitting
the roles means the planner's context never fills with implementation detail and each worker's
context is spent entirely on one narrow job. That is also why the split helps on medium tasks,
not just huge ones.

Everything below exists to close one gap: a compiler preserves meaning at every lowering stage,
a swarm is probabilistic at every stage. The decision ledger, the ownership partition, and the
layered review are the error-correction that makes lowering a spec into code survivable.

Requires Claude Code's `Agent` tool. There is no Codex-side equivalent, so this skill ships no
`agents/openai.yaml`. Codex can still hold the reviewer role — see **Assign models** — but never
the worker role.

## Preconditions

- A git repository, and a task that decomposes into **at least three independent leaves**. If it
  does not, say so and do the work directly — a swarm on a small task is pure overhead.
- A working tree you can attribute changes against. Snapshot `git status --short`, `git diff`,
  and `git diff --cached` before the first wave; never stash or commit the user's pre-existing
  changes.
- An objective acceptance check you can run yourself (test suite, build, lint, a script you
  write). Without one you cannot tell progress from plausible-looking churn.
- Only if a `codex` reviewer is in play (see **Arguments**): the `codex` plugin must be installed
  and its CLI authenticated. Resolve the runtime once and reuse it:

```sh
CODEX_PLUGIN_ROOT=$(ls -d "$HOME/.claude/plugins/cache/openai-codex/codex"/*/ 2>/dev/null | sort -V | tail -1)
```

  If that resolves to nothing, or a companion-script call reports a missing or unauthenticated
  CLI, substitute a Claude reviewer on `sonnet` **keeping the vantage**, and disclose the
  substitution in the final report. Never silently drop the vantage — a wave reviewed from two
  angles instead of three is a weaker result than it looks. Stop and tell the user to run
  `/codex:setup` only if they asked for Codex explicitly and a substitute would not answer their
  question.

## Arguments

Everything here is optional. The defaults are calibrated, not arbitrary — read the rationale in
**Assign models** and **Review vantage points** before overriding them.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--workers <models>` | `mechanical=haiku,implementation=sonnet` | Worker model, either one name for every worker (`--workers haiku`) or per leaf kind. |
| `--reviewers <list>` | `diff:codex,spec:sonnet,shortcut:haiku` | Comma-separated `vantage:runner`. Vantage is `diff`, `spec`, or `shortcut`. Runner is a Claude model (`haiku`, `sonnet`, `opus`) or a Codex entry point (`codex` = native `review`, `codex-adversarial`, `codex-task`). A bare runner with no vantage takes the next unused default vantage. |
| `--codex-model <name>` | Codex's own default | Passed through as `--model`. `spark` expands to `gpt-5.3-codex-spark`. |
| `--codex-effort <level>` | Codex's own default | One of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. **Only `codex-task` honours it** — the native review entry points parse `--model` but ignore `--effort`. If effort is set alongside a non-`task` runner, switch that runner to `codex-task` or say the effort is being dropped. |

The user's flags win over your judgment about the wave. Deviating from a flag they passed needs a
reason stated in `design.md` and in the final report, not a silent substitution.

## Role Contract

- **Planner (this session)**: owns the spec, the task tree, and every design decision. Writes
  briefs, dispatches workers, integrates their output, runs the acceptance check, and decides
  what happens next. Does **not** implement leaves — the moment the planner starts writing
  feature code, its context degrades into a worker's and the whole mechanism collapses.
- **Workers (subagents)**: implement exactly one leaf inside the files they were given. They
  never plan, never redesign, never touch files outside their ownership, and never decide a
  question the brief left open — they stop and escalate instead.
- **Reviewers (Claude subagents or Codex)**: read and report only. A reviewer that edits files has
  contaminated the review; revert its writes against the snapshot (escalate first if they overlap
  the user's pre-existing changes) and rerun it. This applies to a Codex reviewer too — a `task`
  call without `--write` is meant to be read-only, but verify against the snapshot rather than
  trusting it.

## Autonomy Contract

Run the loop end to end. The user delegated to get a large task *finished*, so decide yourself
whenever the repo, the spec, project conventions, or ordinary engineering judgment settles the
question — decomposition shape, interfaces, file ownership, worker models, wave size, which
review findings are real. Record each decision in `design.md` so it is auditable afterwards
instead of interrupting for it.

Escalate only when the decision is genuinely the user's: product intent the spec cannot answer,
destructive actions outside the task's writing scope, or a blocker you cannot route around.

## Delegation budget

Delegation multiplies cost and wall time, so it has to be earned. Start from these numbers, then
let the next section adjust them for whichever model is running this session:

- **Up to 6 workers and 3 reviewers per wave, 5 waves** — then stop and report.
- **One worker per leaf that is actually a leaf.** If a leaf is a handful of tool calls, it is not
  a leaf: fold it into a sibling's brief. If one worker can carry a whole wave, dispatch one, not
  three.
- **Reviewers audit code the planner did not write.** That independence is what makes review worth
  paying for, and it is what a second opinion on your own reasoning would not give you.

## Planner model

The mechanics above hold whichever model plans. Two things do change with it.

**On Opus 5** the caps are ceilings. It delegates readily, so the risk is spawning workers for jobs
that were a few tool calls, and it already self-corrects — do not layer verification passes over
your own reasoning, because they compound into wasted tokens rather than better output.

**On Fable 5** the caps are a floor. It dispatches and sustains parallel subagents dependably, so
delegate more rather than less, and change three habits:

- **Keep workers alive across waves.** Hand a worker its next leaf with `SendMessage` (step 9)
  instead of spawning a fresh agent.
- **Do not block on a wave.** Plan wave N+1, update the ledger, and read reports as they land while
  wave N is still running. Step into a worker that has gone off track rather than letting it finish
  badly.
- **Include the spec-conformance reviewer in every wave's 2–3** rather than rotating it out. It
  is the one check that audits your decomposition instead of the code — the part of a swarm you
  cannot audit from the inside.

## Workspace

Create `.swarm/` in your scratchpad directory (or at the repo root if the work spans sessions and
the user wants the audit trail — it is gitignorable):

- `spec.md` — the goal, normalized. This is the unit of work.
- `design.md` — the decision ledger. Every design decision the planner makes, one entry each:
  what was decided, why, and which leaves it binds.
- `waves/wave-N.md` — a status table with one row per leaf (leaf, worker, model, files
  touched, check result), then freeform notes on briefs, reports, and findings. Keep status
  tabular: structured state survives a context refresh, narrative does not.
- `field-guide.md` — one lesson per line, each a one-line summary of something a future agent on
  this codebase would have wanted to know. Inject it into every brief. Only the unexpected earns a
  line: model weights are fixed, so what is worth recording is exactly what a capable agent would
  not have guessed. Update an entry rather than duplicating it, and delete ones that prove wrong.

Keep all of these terse — length is not thoroughness, and none of them should restate what the
diff already says.

## Workflow

1. **Normalize the spec.** Write `spec.md`: the goal, hard constraints, and what "done" means as
   something you can check. If the user's intent is vague, this is where the value is — a swarm
   faithfully lowers whatever you hand it, so an ambiguous spec produces a confidently wrong
   codebase. Ask now, not later.

2. **Define the acceptance check.** Decide how you will measure progress and write the command
   down. Do not tell workers to optimize the check directly — brief them on the behavior the spec
   requires and run the check yourself. A worker told to make a test pass will find ways to make
   that test pass.

3. **Decompose into a tree.** Split the goal into components, recursively, until each leaf is one
   worker's job. Two rules carry most of the weight:
   - **Make every design decision yourself and record it.** Never delegate a decision to a
     worker. The failure this prevents is split-brain: two subtrees independently deciding the
     same question and implementing the same concept two different ways in two places.
   - **Partition file ownership so leaves in a wave are disjoint.** Conflicts between workers are
     a planning failure that surfaces at merge time, not a merge problem. Fix them in the tree.
     When two leaves genuinely cannot be made disjoint, either sequence them across waves or give
     each worker `isolation: "worktree"` and integrate the results yourself.

4. **Assign models.** Planner stays on the strongest model available. For everything else, start
   from `--workers` and `--reviewers` (or their defaults): classify each leaf as `mechanical` or
   `implementation` and take the worker model from that; take the reviewer roster from the
   vantage list. Deviate only when the wave gives you a reason to, and record the reason in
   `design.md` — a default is a default, not a cage, but a flag the user actually passed is
   closer to an instruction.

   Workers dominate token volume and the planner dominates cost, so the payoff is in briefing
   quality: once the planner has turned ambiguity into an explicit instruction, a cheap model
   just follows it.

   **Workers are always Claude subagents.** The two mechanisms workers depend on — file ownership
   enforced by dispatching through `Agent` with an explicit file list, and findings routed back to
   one specific worker with `SendMessage` — both need a per-agent identity that the Codex runtime
   does not expose. `--resume-last` reaches only the most recent Codex job, so with several Codex
   workers in flight there is no way to send a finding to the right one.

   **Reviewers may be either.** A reviewer reads and reports; it needs no file ownership and no
   continuity, so nothing above binds it. Dispatch a `provider = "claude"` reviewer as a read-only
   subagent, and a `provider = "codex"` reviewer through the companion script:

```sh
# runner "codex-task" — a free-form vantage. Omit --write: that is what keeps it read-only.
# Genuinely asynchronous: returns a job id, then collect with `status` and `result`.
node "${CODEX_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background "<reviewer prompt>"

# runner "codex" or "codex-adversarial" — diff-scoped native review.
node "${CODEX_PLUGIN_ROOT}/scripts/codex-companion.mjs" review --scope working-tree
```

   Pass `--model` when `--codex-model` was given, and `--effort` only to `task` — the native
   review entry points accept `--model` but silently ignore `--effort`. An unknown model name
   fails at dispatch, so treat that like a missing plugin: substitute, keep the vantage, disclose.
   Do not invent a model name the user did not ask for.

   The two entry points differ in a way that matters for wave timing. `task --background` really
   does background. `review` and `adversarial-review` accept `--background` but ignore it and run
   to completion in the foreground, so launch those through Bash with `run_in_background: true`
   instead — otherwise one Codex reviewer serializes the whole wave and you lose the parallelism
   the review step depends on. Either way, run the acceptance check while the reviewers work.

   Codex job state is keyed by working directory. Run `task`, `status`, and `result` from the same
   cwd — from anywhere else `status` reports `No job found` for a job that is running fine, which
   reads exactly like a crashed reviewer and will cost you the vantage if you believe it.

   A Codex reviewer is still a reviewer: check the snapshot afterwards and treat any write as
   contamination, exactly as in the Role Contract.

5. **Dispatch a wave.** Up to 6 workers, all `Agent` calls in a **single response block** so they
   run in parallel. Use `subagent_type: "general-purpose"`. Each gets a self-contained brief
   (template below) — a worker cannot see this session, so everything it needs must be in the
   brief, complete and up front; agents finish properly when given the whole spec at the start,
   and degrade when it arrives in fragments.

6. **Integrate.** Read each worker's report and check its claims against `git diff` —
   cross-agent verification of code you did not write, which is where the signal is. Resolve any
   conflict that slipped through yourself, or hand it to a neutral subagent that is party to
   neither side and whose only job is to merge them fairly.

7. **Review, from uncorrelated vantage points.** Dispatch 2–3 reviewers in parallel on a cheap
   model (see below). Stacked low-correlation views get you high reliability out of components
   that are individually incomplete, and reviewing costs far less than the work it audits — in a
   long multi-agent run small errors compound into structural ones if nothing corrects them.

8. **Run the acceptance check yourself** — it does not depend on the reviewers, so run it while
   they work — and record the result in the wave log against the current commit. If the user is happy for you to commit, commit each wave that passes: git
   is the cheapest checkpoint available, and rolling one bad wave back beats extracting it
   from five waves of mixed diff.

9. **Triage, fix, then loop.** Judging the findings is your job: discard the wrong and
   out-of-scope ones with a one-line note in the wave log, and do not ask the user to arbitrate
   individual findings. Route the real ones back to the worker that produced the code — use
   `SendMessage` with that agent's ID (load the tool first if it is deferred) so it keeps its
   context; that is far cheaper than a fresh agent re-deriving the leaf. Fold anything a worker
   flagged as surprising into `field-guide.md`, then plan the next wave.

   Keep going until the acceptance check satisfies the spec, the wave budget is spent, or you
   hit a genuine user decision. If the budget runs out while clearly converging — smaller
   findings each wave, remainder mechanical — take one extension and disclose it.

## Worker brief template

The brief is the product of all the planner's expensive thinking. Two things about its shape
earn their keep. Tag the sections: you paste multi-line content into the middle of this prompt
— decision entries, gotcha lines — and tags keep an injected block from bleeding into the
field after it. And put that pasted context above the task, because an instruction lands more
reliably after its context than before it.

Give the intent behind the leaf but not the tree. Knowing why a leaf exists helps a worker
pick the right context; knowing the whole tree hands back the context cost the split was
meant to remove.

```
<role>You are implementing one leaf of a plan another agent made. The brief is complete
on purpose — work from it rather than reconstructing the larger plan.</role>

<workspace>absolute path to the repository root, plus the exact command that runs the
leaf's check</workspace>
<binding_decisions>verbatim entries from design.md that constrain this leaf</binding_decisions>
<interfaces>exact signatures, schemas, and names the planner fixed — match them</interfaces>
<gotchas>relevant lines from field-guide.md</gotchas>
<files_you_own>exact paths — edit these and nothing else</files_you_own>

<task>
Goal: one sentence, the leaf and not the tree
Why it matters: one sentence on what this leaf enables
Done when: a condition you can verify
</task>

<rules>
- Solve the general problem the goal describes, not the narrowest thing that turns
  "Done when" green. No hardcoded values, no special-casing the check.
- Keep the change minimal: no refactoring around it, no abstractions for hypothetical
  future needs, no error handling for cases that cannot happen.
- Stay inside your files. If a change outside them is genuinely necessary, make the
  smallest patch and leave a `SWARM-NOTE:` comment saying why, so downstream agents
  find the reason.
- Keep every action local and reversible: leave git history alone, leave files you did
  not write alone, and reach green by fixing the code rather than by skipping checks.
- If something is ambiguous, a binding decision looks wrong, or the leaf turns out to
  be infeasible, stop and report it rather than deciding or working around it.
- Delete any scratch files you create while iterating.
</rules>

<report_back>
Files changed, what you verified and how, open questions, and anything surprising a
future agent on this codebase would want to know. Ground every claim in something you
actually ran or read this session, and say so plainly where you did not verify
something. No padding, no restating the diff.
</report_back>
```

Filled in (the fixed `<role>`, `<rules>`, and `<report_back>` blocks go in verbatim and are
omitted here), a brief is this short:

```
<workspace>/home/me/src/acme — run `pytest tests/billing` from there.</workspace>
<binding_decisions>
- Retries live in the transport layer. Call sites stay unaware of them.
- Every request passes an explicit timeout; there is no implicit default anywhere.
</binding_decisions>
<interfaces>
`http.Client(base_url: str, *, timeout: float) -> Client`
`Client.get(path: str, **params) -> Response` — raises `HTTPError` on 4xx and 5xx.
</interfaces>
<gotchas>
- `tests/conftest.py` monkeypatches `requests.Session`, so a call that skips
  `http.Client` reaches the real network in CI without failing loudly.
</gotchas>
<files_you_own>src/billing/invoices.py, tests/billing/test_invoices.py</files_you_own>

<task>
Goal: port `src/billing/invoices.py` from `requests` to `http.Client`.
Why it matters: invoices is the last caller keeping `requests` in the dependency tree.
Done when: no `import requests` remains in the file and `pytest tests/billing` passes.
</task>
```

## Review vantage points

Pick 2–3 with deliberately different inputs. `--reviewers` names which vantages run and who runs
each; these are the three vantages it can name.

- **Diff-only** (`diff`) — sees `git diff` and nothing else. Catches defects in the code as
  written. This is what Codex's native `review` and `adversarial-review` already are, which is why
  `diff:codex` is the default.
- **Spec-conformance** (`spec`) — sees `spec.md` and the resulting code, but not the diff or the
  briefs. Catches building the right thing badly *and* the wrong thing well.
- **Shortcut hunter** (`shortcut`) — sees the brief, the worker's report, and the diff. Catches
  stubs, faked tests, hardcoded values, and reports that overstate what was done.

Vary the model *and the provider* between reviewers where you can; correlated reviewers miss the
same things, and a different provider decorrelates harder than a different model from the same
family. Review accuracy holds up well on cheap models in general, but not uniformly: spec
conformance is the vantage that degrades first, because it requires holding the spec and the code
side by side rather than reacting to a diff. Do not put it on the cheapest model available.

Tell each reviewer to report **everything it finds**, low-confidence items included, and do the
triage yourself in step 9. Asking a reviewer to be conservative or to report only high-severity
issues gets taken literally and suppresses real findings — separating detection from filtering is
strictly better. Review accuracy holds up well on cheap models, so casting a wide net here costs
little.

Require every finding to name the file and line it came from. A reviewer casting a wide net will
otherwise reason about code it never opened, and a speculative finding costs you the same triage
time as a real one while looking exactly like it.

## Reporting during the run

A swarm run is long and the user is usually not watching it, which changes what your messages have
to do.

**Cadence.** One sentence before you dispatch a wave. While it runs, speak up only when you find
something important or change direction. After each wave, lead with the acceptance-check result and
put detail behind it. Save the full accounting for the final report.

**Ground every claim.** You are reporting on work you did not do, summarized by agents whose reports
tend to sound more finished than the diff is. Before stating that something works, point to a tool
result from this session: the check output, the diff, a test run. If a worker claimed something you
have not confirmed, say it is unconfirmed. Fabricated status is what makes a long run worthless,
because every later wave gets planned on top of it.

**Run to the end.** Ending a turn with "I'll now dispatch wave 3" parks the swarm until the user
comes back and pokes it. Before you end a turn, look at your last paragraph: if it is a plan, a
promise, or a list of next steps, do that work now instead. End when the spec is satisfied, the
budget is spent, or you are blocked on something only the user can answer. Long runs are the
expected shape here, and context is managed for you — keep working rather than wrapping up,
summarizing, or proposing a fresh session as the window fills.

## Final Report

Write it for someone who saw none of the run. By the end you have hours of accumulated shorthand
the user never heard; leave it behind. Open with the outcome in one plain sentence, then the
supporting detail, giving each file, flag, or identifier its own plain-language clause. When short
and clear conflict, choose clear.

- `status`: complete, blocked, or stopped after max waves
- `spec`: what was built, and the acceptance-check result with the actual command output
- `waves`: per wave — leaves dispatched, the worker and reviewer models and providers actually
  used, findings, check result. Say plainly if a reviewer was substituted or dropped,
  and why: a wave reviewed by two vantages instead of three is a weaker result than it looks.
- `decisions`: design decisions made on the user's behalf (from `design.md`), one line of
  rationale each
- `unresolved`: known findings not fixed, leaves not attempted, anything unverified
