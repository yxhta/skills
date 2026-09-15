#!/bin/bash
# Hook routing evals for shunt. Usage: bash evals/run.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Under $PWD so a $PWD-relative eval can reach it
FIXTURES=$(mktemp -d "$PWD/.shunt-evals.XXXXXX")
FIXTURES_REL=${FIXTURES#"$PWD"/}
trap 'rm -rf "$FIXTURES"' EXIT
PASSED=0
FAILED=0
TOTAL=0

generate_fixture() {
  local path="$1" lines="$2"
  if [ "$lines" -eq 0 ]; then
    touch "$path"
  else
    seq 1 "$lines" | awk '{print "line "NR}' > "$path"
  fi
}

setup_fixtures() {
  local evals_file="$1"
  rm -rf "${FIXTURES:?}"/*

  local count
  count=$(jq '.evals | length' "$evals_file")

  for ((i = 0; i < count; i++)); do
    local fixture
    fixture=$(jq -r ".evals[$i].fixture" "$evals_file")
    [ "$fixture" = "null" ] && continue

    local lines
    lines=$(jq -r ".evals[$i].fixture.lines" "$evals_file")

    # Every {{FIXTURES}}/... token in the input gets a fixture of `lines` lines,
    # except names that another eval already generated (so a multi-file command
    # can mix a small and a large file).
    local input_path
    while IFS= read -r input_path; do
      [ -z "$input_path" ] && continue
      [ -e "$input_path" ] || generate_fixture "$input_path" "$lines"
    done < <(jq -r ".evals[$i].input.tool_input | (.file_path // .command // empty)" "$evals_file" | sed -E 's/cd \{\{FIXTURES\}\} && cat /cat {{FIXTURES}}\//; s/\$PWD\/\{\{FIXTURES_REL\}\}/{{FIXTURES}}/' | grep -oE '"\{\{FIXTURES\}\}/[^"]+"|\{\{FIXTURES\}\}/[^ ;*)]+' | tr -d '"' | sed "s|{{FIXTURES}}|$FIXTURES|")
  done
}

run_eval() {
  local hook="$1" name="$2" input="$3" expected="$4" reason="$5" env_json="$6"
  TOTAL=$((TOTAL + 1))

  local result actual
  if [ -n "$env_json" ] && [ "$env_json" != "null" ]; then
    local env_cmd=""
    while IFS='=' read -r key val; do
      env_cmd="$env_cmd $key=$val"
    done < <(echo "$env_json" | jq -r 'to_entries[] | "\(.key)=\(.value)"')
    result=$(echo "$input" | env $env_cmd bash "$hook" 2>/dev/null)
  else
    result=$(echo "$input" | bash "$hook" 2>/dev/null)
  fi
  # Silence means no opinion (allow); a deny is the only thing the hooks print.
  if [ -z "$result" ]; then
    actual="allow"
  else
    actual=$(echo "$result" | jq -r '.hookSpecificOutput.permissionDecision')
    [ "$actual" = "deny" ] && actual="block"
  fi

  if [ "$actual" = "$expected" ]; then
    printf "  \033[32mPASS\033[0m  %-30s %s\n" "$name" "$reason"
    PASSED=$((PASSED + 1))
  else
    printf "  \033[31mFAIL\033[0m  %-30s expected=%s got=%s\n" "$name" "$expected" "$actual"
    FAILED=$((FAILED + 1))
  fi
}

run_suite() {
  local hook="$1" evals_file="$2" label="$3"

  setup_fixtures "$evals_file"

  echo ""
  echo "$label"
  echo "────────────────────────────────────────────────────────────────"

  local count
  count=$(jq '.evals | length' "$evals_file")

  for ((i = 0; i < count; i++)); do
    local name expected reason input
    name=$(jq -r ".evals[$i].name" "$evals_file")
    expected=$(jq -r ".evals[$i].expected_decision" "$evals_file")
    reason=$(jq -r ".evals[$i].reason" "$evals_file")
    input=$(jq -c ".evals[$i].input" "$evals_file" | sed "s|{{FIXTURES}}|$FIXTURES|g; s|{{FIXTURES_REL}}|$FIXTURES_REL|g")

    local env_json
    env_json=$(jq -r ".evals[$i].env // empty" "$evals_file")
    run_eval "$hook" "$name" "$input" "$expected" "$reason" "$env_json"
  done
}

run_suite "$SCRIPT_DIR/../hooks/check-file-size" "$SCRIPT_DIR/hook-evals.json" "Read hook (check-file-size)"
run_suite "$SCRIPT_DIR/../hooks/check-bash-read" "$SCRIPT_DIR/bash-hook-evals.json" "Bash hook (check-bash-read)"

echo ""
printf "Total: \033[32m%d passed\033[0m, \033[31m%d failed\033[0m, %d total\n" "$PASSED" "$FAILED" "$TOTAL"
[ "$FAILED" -gt 0 ] && exit 1
exit 0
