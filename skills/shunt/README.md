# shunt

Port of Spotify's [shunt](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt)
plugin (Apache-2.0) with the Portal/AiKA transport replaced by a headless `claude -p` call, so it works
anywhere Claude Code is logged in.

Three layers: **hooks** deny large file reads and point at the skill, **scripts** run the worker
model and clean up its output, the **skill** tells Claude when and how to call the scripts.

## Install

```sh
npx skills add yxhta/skills --skill shunt
```

The hooks are the enforcement layer and need a one-time entry in `~/.claude/settings.json`
(`npx skills` installs skills, not hooks). Requires `jq`.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Read", "hooks": [{ "type": "command", "command": "bash \"$HOME/.claude/skills/shunt/hooks/check-file-size\"" }] },
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "bash \"$HOME/.claude/skills/shunt/hooks/check-bash-read\"" }] }
    ]
  }
}
```

Without the hooks the skill still works as a soft suggestion via its description.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `SHUNT_MODEL` | `sonnet` | Worker model passed to `claude -p --model` |
| `SHUNT_MIN_LINES` | `350` | Line count above which the hooks deny and redirect |
| `SHUNT_MAX_PAYLOAD_BYTES` | `9000000` | Refuse a request over this size (`claude -p` caps stdin at 10MB) |

## Known limitations

- The Bash hook is a heuristic parser, not a shell grammar. It handles `&&`/`;` chains, `cd`,
  env prefixes, `command`/`env`/absolute-path wrappers, quoted paths, same-line `VAR=...`
  expansion, and stderr redirects, but
  `bash -c '...'`, `x=$(cat ...)`, `xargs cat`, or a pipeline whose filter matches everything (`| grep -v x`,
  `| head -n 99999`, `head -n 350 a b c` across several files) still get through. The skill description is the primary gate; the hooks
  catch the common accidental cases.

## Differences from the original

- Transport is `claude -p --system-prompt <mode instructions> --tools ""` over stdin. The two
  AiKA modes (`bulk-reader`, `code-writer`) are inlined as system prompts in the scripts.
- No `portal-cli`, no mode registry, no ARG_MAX payload ceiling, no `SHUNT_*_MODE_ID` pins.
- Hooks emit the current `hookSpecificOutput.permissionDecision` shape and stay silent when
  they have no opinion, so they never auto-approve anything.
- The Bash hook lets `head`/`tail` through when an explicit line count (`-n 20`, `-20`,
  `--lines=20`) is within the threshold, mirroring the Read hook's `limit` rule. The original
  blocked those.
- The worker runs with `--strict-mcp-config` and an empty MCP config. Without it, every MCP
  server enabled in the parent (plugins included) loads its tool schemas into the worker, which
  cost ~100k tokens per call in testing.

## Evals

```sh
bash evals/run.sh          # hook routing decisions, no model calls
bash evals/run-e2e.sh      # end-to-end: real claude -p session per evals.json case, ~$0.5 each
bash scripts/self-check    # one cheap model call; fails if the worker's fixed
                           # overhead exceeds SHUNT_OVERHEAD_MAX_TOKENS (2000)
```

Run `self-check` after upgrading Claude Code. The worker flags are version-sensitive, and a
regression shows up as silently expensive calls rather than an error.
