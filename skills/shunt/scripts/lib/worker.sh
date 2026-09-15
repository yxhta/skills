#!/bin/bash
# Shared plumbing for shunt's delegation scripts.
#
# The worker is a headless `claude -p` run on a cheap model. The message goes
# in on stdin (no ARG_MAX ceiling), the mode's instructions go in as the system
# prompt, and the answer comes back on stdout. Every call stands alone.
# --setting-sources "" keeps the caller's hooks and CLAUDE.md out of the worker;
# --strict-mcp-config with an empty config keeps plugin MCP tool schemas out
# (they otherwise add ~100k tokens per call).
# (--bare would do that too, but it also drops keychain/OAuth auth).

SHUNT_MODEL="${SHUNT_MODEL:-haiku}"
# claude -p caps piped stdin at 10MB; refuse early with a clear message.
SHUNT_MAX_PAYLOAD_BYTES="${SHUNT_MAX_PAYLOAD_BYTES:-9000000}"

# mktemp with cleanup on script exit. Usage: shunt_tmpfile <varname>
SHUNT_TMPFILES=()
shunt_tmpfile() {
  local f
  f=$(mktemp) || return 1
  SHUNT_TMPFILES+=("$f")
  trap 'rm -f "${SHUNT_TMPFILES[@]}"' EXIT
  printf -v "$1" '%s' "$f"
}

shunt_preflight() {
  command -v claude >/dev/null 2>&1 && return 0
  echo "Error: 'claude' (Claude Code CLI) not found on PATH." >&2
  return 1
}

# One headless worker run; extra args are appended to the shared flag set.
# CLAUDECODE is the interactive nesting guard; the *_FILE_DESCRIPTOR vars
# point at fds that only the parent process holds. Drop them like Claude
# Code itself does when it spawns a nested CLI.
shunt_claude() {
  env -u CLAUDECODE -u CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR \
    -u CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR -u CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES \
    claude -p --model "$SHUNT_MODEL" --tools "" --no-session-persistence \
    --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' "$@"
}

# Runs one ephemeral turn and prints the answer.
#   $1 system prompt (the mode's instructions)
#   $2 file holding the message
shunt_invoke() {
  local instructions="$1" message_file="$2"
  local stderr_file answer rc bytes

  bytes=$(wc -c < "$message_file" | tr -d ' ')
  if [ "$bytes" -gt "$SHUNT_MAX_PAYLOAD_BYTES" ]; then
    echo "Error: request is $bytes bytes, over the $SHUNT_MAX_PAYLOAD_BYTES byte limit (claude -p stdin cap). Send fewer or smaller files per call." >&2
    return 1
  fi

  stderr_file=$(mktemp)
  answer=$(shunt_claude --system-prompt "$instructions" < "$message_file" 2>"$stderr_file")
  rc=$?

  if [ "$rc" -ne 0 ]; then
    echo "Error: claude -p failed (exit $rc):" >&2
    cat "$stderr_file" >&2
    rm -f "$stderr_file"
    return 1
  fi
  rm -f "$stderr_file"

  if [ -z "$answer" ]; then
    echo "Error: worker returned no text." >&2
    return 1
  fi

  printf '%s\n' "$answer"
}
