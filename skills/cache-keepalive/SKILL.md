---
name: cache-keepalive
description: Use when the user asks to keep a Claude Code session's prompt cache warm with a periodic ping, install or inspect the cache-keepalive Mod, or stop its bounded run. Do not use for HTTP health checks, account keepalive, or a claim of guaranteed cache savings. Requires Claude Code Mods.
argument-hint: "[setup | start [hours] | status | stop]"
---

# Cache keepalive

## Overview

This skill carries an experimental Claude Code Mod in `mod/`. The Mod asks for a
short, tool-less response over the current session's cached snapshot every 50
minutes while idle. It starts disabled and runs only for a finite period after an
explicit command. Read [README.md](README.md) for setup and costs.

This skill requires Claude Code. Codex can inspect or test the files, but cannot
run the Mod in its own conversation. Installing this skill does not load the Mod.

## Preconditions

1. Check `claude --version`. Require Claude Code 2.1.287 or later with Mods allowed
   by the user's workspace and organization. This package is tested against
   2.1.289. If Mods are unavailable, report the blocker. Do not substitute a
   separate `claude -p` process, raw API request, cron job, or authentication hack.
2. Find this skill's installed directory and resolve its `mod/` path. Use an
   absolute path when starting Claude with `--plugin-dir`.
3. Explain that both the main conversation and fork request buckets need an
   explicit one-hour TTL. A subscription's default main TTL does not establish
   the fork TTL. The Mod checks settings and environment variables, but cannot
   verify a provider's actual retention policy.
4. Explain the costs before enabling a run. Every ping consumes the existing
   plan or API account's input and output tokens. One-hour cache writes cost more
   than five-minute writes. The public fork API has no output-token cap, timeout,
   or cancellation parameter. Do not promise savings or a fixed maximum charge.

## Autonomy contract

- Read configuration and run offline validation without a live model call.
- Do not edit global settings, change authentication, copy credentials, enable
  usage credits, add an API-key fallback, or install a recurring external job.
- Do not activate a run merely because the user asked to install or review this
  skill. Require a request to start, with a finite duration. If no duration was
  given, explain the four-hour default before starting.
- Ask before changing TTL settings or environment variables. The non-main TTL
  setting also affects subagents and other helper requests.
- Stop immediately when the user asks. An already-submitted fork may still finish
  and consume tokens. The Mod cannot cancel that request through the public API.
- Never bypass denied Mods, tools, managed settings, or provider restrictions.

## Workflow

1. For setup, show the scoped launch command in README.md. Leave execution and
   TTL changes to the user unless they explicitly approve them. Do not start a
   model turn just to create a cache without approval.
2. Complete a normal user-requested main turn with the chosen TTLs. The Mod needs
   an observed successful request with cache usage in this loaded session. A
   resumed or compacted transcript alone is not proof of a usable snapshot.
3. Use `/cache-ping start N` for the approved integer duration, from one to
   eight hours. The default is four hours. Repeating start must not extend an
   existing run. Use `/cache-ping status` to inspect the actual state.
4. Keep the session process running. The Mod skips active main turns, schedules
   from request start time, and refuses a likely expired snapshot after sleep.
   A cache miss, repeated failures, the request budget, or the deadline ends the
   run. A session reset disables it. Compaction requires a fresh main turn.
5. Report the observed request count and cache-read, cache-write, and output
   tokens. These measurements describe the fork responses that returned usage.
   Failed requests without usage have unknown cost. Do not turn a
   positive cache-read count into a claim that the next main turn is guaranteed
   to hit its entire prefix.
6. To stop, run `/cache-ping stop`. Confirm the displayed state. Disabling or
   unloading the Mod also prevents future timers. It does not revoke an already
   submitted API request.

## Verification

Run `scripts/verify.sh` from this skill directory, or from the repository root
with `skills/cache-keepalive/scripts/verify.sh`. The script requires an installed
Claude CLI and TypeScript 5.4 or later. Set `CLAUDE_BIN` and `TSC_BIN` to select
executables. It uses an isolated temporary configuration, validates the plugin,
runs native mocked tests, checks a zero-inference status command, and type-checks
against declarations from that Claude build.

Before claiming real cache retention, perform the opt-in experiment in
[verification.md](verification.md). Report mock coverage separately from an
authenticated provider result.

## Report

State whether the Mod is installed, loaded, enabled, stopped, or blocked. Include
the configured duration, observed counters, and any pending request. Distinguish
configured TTL from provider behavior and measured cache hits from estimated
savings. Include the smallest next step when the environment blocks progress.
