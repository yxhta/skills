#!/bin/bash
# End-to-end skill evals: run each evals.json prompt in a headless claude session
# (user hooks + skills active) and grade the tool calls from the transcript.
# Usage: bash evals/run-e2e.sh [case-id ...]
# ponytail: expectations are graded by grep on tool_use blocks; the prose
# expectation of each case is left to the reader (final answer is printed).

set -uo pipefail
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/shunt-e2e.XXXXXX")
mkdir -p "$WORK/evals" && cp -R "$SKILL_DIR/evals/fixtures" "$WORK/evals/"
echo "workdir: $WORK"
FAILED=0

# tool_use(name, pattern): 0 when some tool call of that name has input matching pattern
tool_use() { jq -c "select(.type==\"assistant\") | .message.content[] | select(.type==\"tool_use\" and .name==\"$1\") | .input" "$T" | grep -qE "$2"; }
check() { local want="$1" label="$2"; shift 2
  if "$@"; then got=yes; else got=no; fi
  if [ "$got" = "$want" ]; then printf "  \033[32mPASS\033[0m  %s\n" "$label"
  else printf "  \033[31mFAIL\033[0m  %s\n" "$label"; FAILED=$((FAILED + 1)); fi; }

ids=${*:-1 2 3}
for id in $ids; do
  prompt=$(jq -r ".evals[] | select(.id==$id) | .prompt" "$SKILL_DIR/evals/evals.json")
  T="$WORK/case-$id.jsonl"
  echo; echo "case $id: $prompt"
  (cd "$WORK" && env -u CLAUDECODE -u CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR \
      -u CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR -u CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES \
      claude -p "$prompt" --output-format stream-json --verbose \
      --allowedTools "Bash,Read,Write,Edit,Glob,Grep,Skill" --max-turns 25 < /dev/null > "$T" 2>"$WORK/case-$id.err")
  case $id in
    1) check yes "bulk-read with --question/--paths" tool_use Bash 'scripts/bulk-read.*--question.*--paths'
       check yes "hook denied the direct read"     grep -q 'threshold: 350' "$T"
       check no  "Read without limit on fixture"   jq -c 'select(.type=="assistant") | .message.content[] | select(.type=="tool_use" and .name=="Read" and (.input.limit|not)) | .input.file_path' "$T" | grep -q websocket-handler ;;
    2) check yes "code-write --spec/--reference/--target" tool_use Bash 'scripts/code-write.*--spec.*--reference.*--target'
       check yes "target test file written"         ls "$WORK"/evals/fixtures/*user-service*test* >/dev/null 2>&1 ;;
    3) check no  "delegated (bulk-read/code-write)" tool_use Bash 'scripts/(bulk-read|code-write)'
       check yes "Read with offset/limit"           tool_use Read '"(offset|limit)":' ;;
  esac
  jq -r 'select(.type=="result") | "  turns=\(.num_turns) cost=$\(.total_cost_usd) duration=\(.duration_ms/1000|floor)s\n  answer: \(.result[0:400]|gsub("\n";" "))"' "$T"
done
echo; echo "failed checks: $FAILED"; [ "$FAILED" -eq 0 ]
