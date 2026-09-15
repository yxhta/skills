---
name: shunt
description: "Shunt I/O-heavy work to a cheap worker model (claude -p) so large file contents never enter your context. Use when you need to read a file over 350 lines, answer a question across 3+ files, summarize a large diff, or generate boilerplate (tests, config, stubs, docstrings) where >80% is predictable from a reference file. Do NOT use for debugging, for editing where you need exact content (use offset/limit reads), for files under 350 lines, or for design/architecture judgment calls."
allowed-tools: Bash(bash ${CLAUDE_SKILL_DIR}/scripts/bulk-read *), Bash(bash ${CLAUDE_SKILL_DIR}/scripts/code-write *)
---

# shunt

Claude Code only: needs the `claude` CLI on PATH (the worker is a nested `claude -p`) and,
for enforcement, PreToolUse hooks. No Codex counterpart is shipped.

## Preconditions

- `claude` on PATH and logged in. `SHUNT_MODEL` picks the worker model (default `sonnet`).
- Optional hooks that deny large reads and point here — install once, see `README.md`.

## bulk-read — read files without loading them

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/bulk-read --question "<question>" --paths <file1> [<file2> ...]
```

Each call is independent. To ask a follow-up, ask again with the same `--paths` — the files
go to the worker, never into your context, so re-sending them costs you nothing.

Verify specific line numbers or exact values before using them in edits.

A call takes tens of seconds; for corpora over a few thousand lines, pass a larger Bash
`timeout` so the answer comes back in the tool result instead of being backgrounded.

## code-write — generate boilerplate from a reference

```bash
# Generate and write directly to the target file
bash ${CLAUDE_SKILL_DIR}/scripts/code-write --spec "<what to generate>" --reference <reference-file> --target <output-path>

# Output to stdout instead (omit --target)
bash ${CLAUDE_SKILL_DIR}/scripts/code-write --spec "<what to generate>" --reference <reference-file>
```

`--reference` is required: without a file to match patterns against, the worker generates
context-free code that fits nothing. To build on what was just generated, pass that file as
the `--reference` for the next call.

Review the output and make surgical edits for the ~5-20% that needs your judgment.

## When not to delegate

- **Debugging** — needs your reasoning, not a summary.
- **Editing** — you need exact content; read the section with offset/limit.
- **Small files** — under 350 lines the overhead exceeds the savings.
- **Design decisions** — judgment stays with you.
