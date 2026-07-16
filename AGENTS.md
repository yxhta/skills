# Repository Guidelines

## Project Structure & Module Organization

This repository contains personal agent skills distributed through `npx skills`. Each skill lives in `skills/<skill-name>/` and must include a `SKILL.md` file with YAML front matter and the skill instructions. Keep supporting files beside the skill they belong to:

- `agents/openai.yaml` defines OpenAI-facing display metadata and default prompts.
- `config/*.toml` stores non-secret, skill-specific configuration.
- `evals/evals.json` contains behavioral evaluation cases.
- A skill-local `README.md` may document setup or usage that does not belong in the agent instructions.

Use lowercase kebab-case for skill directories, for example `skills/adversarial-review/`. Do not add generated artifacts or credentials.

## Build, Test, and Development Commands

There is no compilation step or repository-wide test runner. Use focused checks for the files you change:

```sh
git diff --check
git diff -- AGENTS.md skills/<skill-name>/
npx skills add yxhta/skills --skill <skill-name>
```

`git diff --check` catches whitespace errors. Review the scoped diff before committing. The `npx skills add` command is an optional installation smoke test; run it when changing package layout or skill discovery metadata.

## Coding Style & Naming Conventions

Write concise Markdown with descriptive headings, short paragraphs, and fenced code blocks for commands. Match the existing two-space YAML indentation and JSON/TOML formatting in nearby files. In `SKILL.md`, keep front-matter fields such as `name` and `description` aligned with the directory name and explain instructions as direct, actionable steps. Prefer examples over vague guidance.

## Testing Guidelines

For instruction changes, manually verify that required preconditions, tool calls, failure handling, and output format are unambiguous. Add or update `evals/evals.json` when a skill has behavior that can be captured as prompt/expected-output cases. Validate edited JSON and YAML with an appropriate parser available in your environment, then inspect the complete rendered Markdown.

## Commit & Pull Request Guidelines

Recent history favors short, imperative subjects, optionally using Conventional Commit prefixes such as `feat:`. Keep each commit focused on one skill or workflow change. Pull requests should explain the user-visible behavior, list changed skill paths, and include validation commands and results. Link relevant issues when available; include screenshots only for visual assets or rendered UI changes.
