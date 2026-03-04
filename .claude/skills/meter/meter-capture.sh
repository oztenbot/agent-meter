#!/bin/bash
# meter-capture.sh — PostToolUse hook for Claude Code
# Captures API spend from curl/fetch commands to LLM APIs.
# Writes to ~/.agent-meter/spend.jsonl
#
# Install: Add to .claude/settings.json PostToolUse hooks with matcher "Bash"

set -euo pipefail

SPEND_DIR="$HOME/.agent-meter"
SPEND_FILE="$SPEND_DIR/spend.jsonl"

# Read stdin once
INPUT=$(cat)

# Fast exit: only process Bash tool calls
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
[ "$TOOL_NAME" = "Bash" ] || exit 0

# Fast exit: check if command targets a known LLM API
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
case "$COMMAND" in
  *api.anthropic.com*|*api.openai.com*|*generativelanguage.googleapis.com*|*api.groq.com*|*api.mistral.ai*|*api.together.xyz*|*api.cohere.ai*|*api.deepseek.com*)
    ;; # match — continue processing
  *)
    exit 0 ;; # not an API call, fast exit
esac

# Determine API from command
API=""
case "$COMMAND" in
  *api.anthropic.com*)              API="api.anthropic.com" ;;
  *api.openai.com*)                 API="api.openai.com" ;;
  *generativelanguage.googleapis.com*) API="generativelanguage.googleapis.com" ;;
  *api.groq.com*)                   API="api.groq.com" ;;
  *api.mistral.ai*)                 API="api.mistral.ai" ;;
  *api.together.xyz*)               API="api.together.xyz" ;;
  *api.cohere.ai*)                  API="api.cohere.ai" ;;
  *api.deepseek.com*)               API="api.deepseek.com" ;;
esac

# Extract response body from tool_response
# tool_response can be: a JSON object, a JSON string containing JSON, or plain text with JSON embedded
TOKENS_IN=0
TOKENS_OUT=0
MODEL=""
COST_USD=0

# Strategy: use jq to extract tool_response, then try to parse it.
# If tool_response is already an object, jq can query it directly.
# If it's a string containing JSON, we need to parse it first.
PARSED_RESPONSE=$(echo "$INPUT" | jq -r '
  .tool_response
  | if type == "object" then .
    elif type == "string" then (fromjson? // empty)
    else empty
    end
  | if . then . else empty end
' 2>/dev/null) || PARSED_RESPONSE=""

# If direct parsing failed, try extracting JSON from the string response
if [ -z "$PARSED_RESPONSE" ]; then
  RAW_RESPONSE=$(echo "$INPUT" | jq -r '.tool_response // empty' 2>/dev/null) || RAW_RESPONSE=""
  if [ -n "$RAW_RESPONSE" ]; then
    # The response might be curl output with headers + JSON body
    # Extract the last JSON object that contains "usage"
    PARSED_RESPONSE=$(echo "$RAW_RESPONSE" | grep -o '{[^}]*"usage"[^}]*}' 2>/dev/null | tail -1) || PARSED_RESPONSE=""
    # If that didn't work, try getting everything after the last blank line (HTTP body)
    if [ -z "$PARSED_RESPONSE" ]; then
      PARSED_RESPONSE=$(echo "$RAW_RESPONSE" | awk '/^$/{body=""} {body=body $0 "\n"} END{print body}' | jq '.' 2>/dev/null) || PARSED_RESPONSE=""
    fi
  fi
fi

if [ -n "$PARSED_RESPONSE" ]; then
  # Try Anthropic format: usage.input_tokens / usage.output_tokens
  TOKENS_IN=$(echo "$PARSED_RESPONSE" | jq -r '.usage.input_tokens // 0' 2>/dev/null) || TOKENS_IN=0
  TOKENS_OUT=$(echo "$PARSED_RESPONSE" | jq -r '.usage.output_tokens // 0' 2>/dev/null) || TOKENS_OUT=0
  MODEL=$(echo "$PARSED_RESPONSE" | jq -r '.model // empty' 2>/dev/null) || MODEL=""

  # Try OpenAI format if Anthropic yielded nothing
  if [ "$TOKENS_IN" = "0" ] && [ "$TOKENS_OUT" = "0" ]; then
    TOKENS_IN=$(echo "$PARSED_RESPONSE" | jq -r '.usage.prompt_tokens // 0' 2>/dev/null) || TOKENS_IN=0
    TOKENS_OUT=$(echo "$PARSED_RESPONSE" | jq -r '.usage.completion_tokens // 0' 2>/dev/null) || TOKENS_OUT=0
  fi
fi

# Estimate cost based on model (rough per-token pricing as of 2026-03)
# Prices in USD per 1M tokens: [input, output]
estimate_cost() {
  local model="$1" tin="$2" tout="$3"
  case "$model" in
    *opus*)    echo "$tin $tout" | awk '{printf "%.6f", ($1 * 15.0 + $2 * 75.0) / 1000000}' ;;
    *sonnet*)  echo "$tin $tout" | awk '{printf "%.6f", ($1 * 3.0 + $2 * 15.0) / 1000000}' ;;
    *haiku*)   echo "$tin $tout" | awk '{printf "%.6f", ($1 * 0.25 + $2 * 1.25) / 1000000}' ;;
    *gpt-4o-mini*) echo "$tin $tout" | awk '{printf "%.6f", ($1 * 0.15 + $2 * 0.60) / 1000000}' ;;
    *gpt-4o*|*gpt-4*) echo "$tin $tout" | awk '{printf "%.6f", ($1 * 2.50 + $2 * 10.0) / 1000000}' ;;
    *o1*|*o3*) echo "$tin $tout" | awk '{printf "%.6f", ($1 * 10.0 + $2 * 40.0) / 1000000}' ;;
    *deepseek*) echo "$tin $tout" | awk '{printf "%.6f", ($1 * 0.27 + $2 * 1.10) / 1000000}' ;;
    *)         echo "$tin $tout" | awk '{printf "%.6f", ($1 * 3.0 + $2 * 15.0) / 1000000}' ;; # default to sonnet-class
  esac
}

if [ "$TOKENS_IN" != "0" ] || [ "$TOKENS_OUT" != "0" ]; then
  COST_USD=$(estimate_cost "$MODEL" "$TOKENS_IN" "$TOKENS_OUT")
fi

# Get project from cwd (basename of git repo or cwd)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || SESSION_ID=""
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || CWD=""
PROJECT=""
if [ -n "$CWD" ]; then
  PROJECT=$(basename "$CWD")
fi

# Build the JSONL record
TS=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

mkdir -p "$SPEND_DIR"

jq -n -c \
  --arg type "api_call" \
  --arg ts "$TS" \
  --arg api "$API" \
  --arg model "$MODEL" \
  --argjson tokens_in "${TOKENS_IN:-0}" \
  --argjson tokens_out "${TOKENS_OUT:-0}" \
  --argjson cost_usd "${COST_USD:-0}" \
  --arg project "$PROJECT" \
  --arg session_id "$SESSION_ID" \
  --arg source "hook" \
  '{
    type: $type,
    ts: $ts,
    api: $api,
    model: $model,
    tokens_in: $tokens_in,
    tokens_out: $tokens_out,
    cost_usd: ($cost_usd | tonumber),
    project: $project,
    session_id: $session_id,
    source: $source
  }' >> "$SPEND_FILE"
