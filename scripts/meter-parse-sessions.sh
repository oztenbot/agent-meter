#!/bin/bash
# meter-parse-sessions.sh — OpenClaw session JSONL parser
# Extracts token/cost data from OpenClaw session transcripts.
# Produces the same ~/.agent-meter/spend.jsonl format as the Claude Code hooks.
#
# Usage: ./meter-parse-sessions.sh [--since HOURS]
# Default: parse sessions from the last 24 hours
#
# Run via cron or heartbeat for continuous coverage.

set -euo pipefail

SPEND_DIR="$HOME/.agent-meter"
SPEND_FILE="$SPEND_DIR/spend.jsonl"
STATE_FILE="$SPEND_DIR/.parse-state"
OPENCLAW_DIR="$HOME/.openclaw/agents"
SINCE_HOURS=24

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since) SINCE_HOURS="$2"; shift 2 ;;
    *) echo "Usage: $0 [--since HOURS]"; exit 1 ;;
  esac
done

# Check OpenClaw directory exists
if [ ! -d "$OPENCLAW_DIR" ]; then
  echo "No OpenClaw agents directory found at $OPENCLAW_DIR"
  exit 0
fi

mkdir -p "$SPEND_DIR"

# Load last parse timestamp (for dedup)
LAST_PARSE=""
if [ -f "$STATE_FILE" ]; then
  LAST_PARSE=$(cat "$STATE_FILE")
fi

# Calculate cutoff time
if command -v gdate &>/dev/null; then
  CUTOFF=$(gdate -u -d "$SINCE_HOURS hours ago" +"%Y-%m-%dT%H:%M:%S.000Z")
else
  CUTOFF=$(date -u -v-${SINCE_HOURS}H +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%S.000Z")
fi

RECORDS_ADDED=0

# Process each agent's session files
for AGENT_DIR in "$OPENCLAW_DIR"/*/; do
  [ -d "$AGENT_DIR" ] || continue
  AGENT_ID=$(basename "$AGENT_DIR")
  SESSIONS_DIR="$AGENT_DIR/sessions"
  [ -d "$SESSIONS_DIR" ] || continue

  for SESSION_FILE in "$SESSIONS_DIR"/*.jsonl; do
    [ -f "$SESSION_FILE" ] || continue

    SESSION_ID=$(basename "$SESSION_FILE" .jsonl)

    # Skip if we already parsed this session (check by session_id in spend file)
    if [ -f "$SPEND_FILE" ] && grep -q "\"session_id\":\"$SESSION_ID\"" "$SPEND_FILE" 2>/dev/null; then
      continue
    fi

    # Extract usage records from session JSONL
    # OpenClaw format: each line is a message with optional usage field
    # Look for: message.usage.input_tokens, message.usage.output_tokens, message.usage.cost.total
    while IFS= read -r line; do
      # Skip lines without usage data
      HAS_USAGE=$(echo "$line" | jq -r '.message.usage // .usage // empty' 2>/dev/null) || continue
      [ -n "$HAS_USAGE" ] || continue

      # Extract fields — try message.usage first, then top-level usage
      TOKENS_IN=$(echo "$line" | jq -r '.message.usage.input_tokens // .usage.input_tokens // .usage.prompt_tokens // 0' 2>/dev/null) || TOKENS_IN=0
      TOKENS_OUT=$(echo "$line" | jq -r '.message.usage.output_tokens // .usage.output_tokens // .usage.completion_tokens // 0' 2>/dev/null) || TOKENS_OUT=0
      COST_USD=$(echo "$line" | jq -r '.message.usage.cost.total // .usage.cost.total // 0' 2>/dev/null) || COST_USD=0
      MODEL=$(echo "$line" | jq -r '.message.model // .model // "unknown"' 2>/dev/null) || MODEL="unknown"
      MSG_TS=$(echo "$line" | jq -r '.timestamp // .message.created_at // empty' 2>/dev/null) || MSG_TS=""

      # Skip zero-usage records
      [ "$TOKENS_IN" != "0" ] || [ "$TOKENS_OUT" != "0" ] || continue

      # Use message timestamp or fallback to now
      if [ -z "$MSG_TS" ]; then
        MSG_TS=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
      fi

      # Determine API from model name
      API="unknown"
      case "$MODEL" in
        *claude*|*opus*|*sonnet*|*haiku*) API="api.anthropic.com" ;;
        *gpt*|*o1*|*o3*|*davinci*) API="api.openai.com" ;;
        *gemini*) API="generativelanguage.googleapis.com" ;;
        *deepseek*) API="api.deepseek.com" ;;
        *mistral*|*mixtral*) API="api.mistral.ai" ;;
      esac

      jq -n -c \
        --arg type "api_call" \
        --arg ts "$MSG_TS" \
        --arg api "$API" \
        --arg model "$MODEL" \
        --argjson tokens_in "${TOKENS_IN:-0}" \
        --argjson tokens_out "${TOKENS_OUT:-0}" \
        --argjson cost_usd "${COST_USD:-0}" \
        --arg session_id "$SESSION_ID" \
        --arg agent_id "$AGENT_ID" \
        --arg source "session_parse" \
        '{
          type: $type,
          ts: $ts,
          api: $api,
          model: $model,
          tokens_in: $tokens_in,
          tokens_out: $tokens_out,
          cost_usd: ($cost_usd | tonumber),
          session_id: $session_id,
          agent_id: $agent_id,
          source: $source
        }' >> "$SPEND_FILE"

      RECORDS_ADDED=$((RECORDS_ADDED + 1))
    done < "$SESSION_FILE"
  done
done

# Update parse state
date -u +"%Y-%m-%dT%H:%M:%S.000Z" > "$STATE_FILE"

echo "Parsed $RECORDS_ADDED new records from OpenClaw sessions"
