#!/bin/bash
# meter-session-end.sh — Stop hook for Claude Code
# Aggregates session API calls into a session_summary record.
# Writes to ~/.agent-meter/spend.jsonl

set -euo pipefail

SPEND_DIR="$HOME/.agent-meter"
SPEND_FILE="$SPEND_DIR/spend.jsonl"

# No spend file means no API calls were captured this session
[ -f "$SPEND_FILE" ] || exit 0

# Read stdin for session context
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || SESSION_ID=""

# Need session_id to aggregate
[ -n "$SESSION_ID" ] || exit 0

# Find all api_call records for this session
MATCHES=$(grep "\"session_id\":\"$SESSION_ID\"" "$SPEND_FILE" | grep '"type":"api_call"' 2>/dev/null) || true
[ -n "$MATCHES" ] || exit 0

# Aggregate: count, total tokens, total cost, dominant API
SUMMARY=$(echo "$MATCHES" | jq -s '{
  total_calls: length,
  tokens_in: (map(.tokens_in) | add // 0),
  tokens_out: (map(.tokens_out) | add // 0),
  cost_usd: (map(.cost_usd) | add // 0),
  api: (group_by(.api) | sort_by(-length) | .[0][0].api // "unknown")
}' 2>/dev/null) || exit 0

TOTAL_CALLS=$(echo "$SUMMARY" | jq -r '.total_calls')
TOKENS_IN=$(echo "$SUMMARY" | jq -r '.tokens_in')
TOKENS_OUT=$(echo "$SUMMARY" | jq -r '.tokens_out')
COST_USD=$(echo "$SUMMARY" | jq -r '.cost_usd')
API=$(echo "$SUMMARY" | jq -r '.api')

TS=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

jq -n -c \
  --arg type "session_summary" \
  --arg ts "$TS" \
  --arg api "$API" \
  --arg session_id "$SESSION_ID" \
  --argjson total_calls "$TOTAL_CALLS" \
  --argjson tokens_in "$TOKENS_IN" \
  --argjson tokens_out "$TOKENS_OUT" \
  --argjson cost_usd "$COST_USD" \
  --arg source "hook" \
  '{
    type: $type,
    ts: $ts,
    api: $api,
    session_id: $session_id,
    total_calls: $total_calls,
    tokens_in: $tokens_in,
    tokens_out: $tokens_out,
    cost_usd: ($cost_usd | tonumber),
    source: $source
  }' >> "$SPEND_FILE"
