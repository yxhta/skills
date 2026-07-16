# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A personal collection of Claude Code Agent Skills, installable via [`npx skills`](https://github.com/vercel-labs/skills). There is no build, lint, or test tooling — the repository is pure content (Markdown skill definitions plus small config files). "Development" here means writing/editing `SKILL.md` files and their sidecar config.

## Layout

Each skill lives at `skills/<name>/SKILL.md` (flat layout, per the `npx skills` convention — do not nest skills or introduce alternate directory shapes). A skill directory may also carry agent-specific sidecar files alongside `SKILL.md`:

- `agents/openai.yaml` — Codex-side metadata (`interface.display_name`, `short_description`, `default_prompt`) for skills also meant to be invoked from Codex. Only add this when the skill is genuinely dual-purpose; skills that hard-depend on Claude Code internals (e.g. the `Agent` tool, a specific plugin) omit it and say so explicitly in their SKILL.md instead of shipping a non-functional stub.
- `config/*.toml` — non-secret, user-editable configuration (e.g. `summarize-ai-news/config/notion.toml`). Local overrides follow the `<name>.local.toml` pattern and are gitignored; never commit credentials or tokens into `config/`.
- `evals/evals.json` — scenario-based evals for a skill: prompt, expected agent behavior, and any files needed. Used to check that the skill's description/instructions actually trigger and steer behavior as intended (see `consult-opus/evals/evals.json` for the shape).

## SKILL.md conventions

- Frontmatter requires `name` and `description`. Write `description` as a trigger spec, not a summary: state concretely when to invoke the skill ("Use when...") and, where it matters, when *not* to (routine cases that don't warrant it). The description is what the invoking agent matches against, so precision here directly controls correct triggering.
- Optional frontmatter: `argument-hint` for slash-command-style invocation.
- Prefer imperative, numbered workflows over prose narrative — most existing skills are structured as Overview → Preconditions → Role/Coordination steps → Output/Report shape. Keep that shape for new orchestration-style skills.
- Skills that coordinate multiple agents (`claude-codex-workflow`, `herdr-agent-workflow`) spell out an explicit **Role Contract** (who edits files vs. who only reviews) and an **Autonomy Contract** (what the agent may decide on its own vs. what must be escalated to the user). Follow this pattern for any new multi-agent or loop-style skill rather than leaving autonomy boundaries implicit.
- Review-only skills (`adversarial-review`) must say so explicitly under a "Core constraint" heading and must never edit files.
- When a skill depends on an external plugin or tool being installed (e.g. the `codex` plugin), state the precondition and the exact fallback/error behavior if it's missing, rather than assuming it's present.

## Language

Skill bodies are written in English; a companion `README.md` inside a skill directory may exist in Japanese for human-facing project context (see `claude-codex-workflow/README.md`) but is not required by the `npx skills` convention — do not assume every skill needs one.
