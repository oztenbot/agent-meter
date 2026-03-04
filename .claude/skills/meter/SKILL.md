---
name: agent-meter
description: "Track API spend with intent-level attribution. Shows where your tokens go by project and purpose. Invoke with /meter for spend summary."
version: "0.1.0"
user-invocable: true
---

# /meter — API Spend Tracker

When the user invokes `/meter`, show a spend summary from `~/.agent-meter/spend.jsonl`.

## Execution

Run this bash command to produce the summary:

```bash
SPEND_FILE="$HOME/.agent-meter/spend.jsonl"
if [ ! -f "$SPEND_FILE" ]; then
  echo "No spend data yet. Make some API calls first."
  exit 0
fi

echo "=== API Spend Summary ==="
echo ""

# Last 24 hours
CUTOFF=$(date -u -v-24H +"%Y-%m-%dT" 2>/dev/null || date -u -d "24 hours ago" +"%Y-%m-%dT" 2>/dev/null || echo "")

if [ -n "$CUTOFF" ]; then
  echo "## Last 24 Hours"
  grep '"type":"api_call"' "$SPEND_FILE" | grep "\"ts\":\"$CUTOFF" | jq -s '
    if length == 0 then "No calls in last 24h"
    else
      "Calls: \(length)\n" +
      "Tokens: \(map(.tokens_in) | add // 0) in / \(map(.tokens_out) | add // 0) out\n" +
      "Cost: $\(map(.cost_usd) | add // 0 | . * 10000 | round / 10000)\n" +
      "\nBy API:\n" +
      (group_by(.api) | map("  \(.[0].api): \(length) calls, $\(map(.cost_usd) | add // 0 | . * 10000 | round / 10000)") | join("\n")) +
      "\n\nBy Model:\n" +
      (group_by(.model) | map("  \(.[0].model): \(length) calls, \(map(.tokens_in + .tokens_out) | add // 0) tokens") | join("\n"))
    end
  ' -r 2>/dev/null || echo "  (no data)"
  echo ""
fi

echo "## All Time"
grep '"type":"api_call"' "$SPEND_FILE" | jq -s '
  "Total calls: \(length)\n" +
  "Total tokens: \(map(.tokens_in + .tokens_out) | add // 0)\n" +
  "Total cost: $\(map(.cost_usd) | add // 0 | . * 10000 | round / 10000)\n" +
  "\nBy Project:\n" +
  (group_by(.project) | map("  \(.[0].project // "(none)"): \(length) calls, $\(map(.cost_usd) | add // 0 | . * 10000 | round / 10000)") | join("\n")) +
  "\n\nBy Source:\n" +
  (group_by(.source) | map("  \(.[0].source): \(length) records") | join("\n"))
' -r 2>/dev/null || echo "  (no data)"
```

Format the output as a clean markdown table or summary for the user.

If the user passes arguments like `/meter --by model` or `/meter --last 7d`, adjust the jq queries accordingly.

## Quick Setup — Claude Code

1. Copy the hooks to your project:

```bash
mkdir -p .claude/hooks
cp agent-meter/.claude/hooks/meter-capture.sh .claude/hooks/
cp agent-meter/.claude/hooks/meter-session-end.sh .claude/hooks/
chmod +x .claude/hooks/meter-capture.sh .claude/hooks/meter-session-end.sh
```

2. Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/bin/bash .claude/hooks/meter-capture.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/bin/bash .claude/hooks/meter-session-end.sh"
          }
        ]
      }
    ]
  }
}
```

3. Copy this SKILL file to `.claude/skills/meter/SKILL.md` to enable `/meter`.

## Quick Setup — OpenClaw

1. Add to your heartbeat or cron:

```bash
# Every 30 minutes, parse new sessions
*/30 * * * * /path/to/agent-meter/scripts/meter-parse-sessions.sh
```

2. Copy this SKILL file to your agent's skills directory to enable `/meter`.

OpenClaw writes session transcripts with token usage to `~/.openclaw/agents/<agentId>/sessions/*.jsonl`. The parser extracts this data with 100% coverage — no behavioral instruction compliance needed.

## Query Examples

```bash
SPEND="$HOME/.agent-meter/spend.jsonl"

# Spend by project
jq -s 'group_by(.project) | map({project: .[0].project, cost: (map(.cost_usd) | add)})' "$SPEND"

# Spend by purpose
jq -s '[.[] | select(.purpose != null)] | group_by(.purpose) | map({purpose: .[0].purpose, cost: (map(.cost_usd) | add)})' "$SPEND"

# Most expensive models
jq -s 'group_by(.model) | map({model: .[0].model, cost: (map(.cost_usd) | add), calls: length}) | sort_by(-.cost)' "$SPEND"

# Today's spend
jq -s "[.[] | select(.ts | startswith(\"$(date -u +%Y-%m-%d)\"))] | map(.cost_usd) | add" "$SPEND"
```

## Manual Intent Tagging

Add `purpose` and `intent` fields to records manually:

```bash
# Tag all calls in a session with a purpose
jq -c "if .session_id == \"$SESSION\" then . + {purpose: \"research\", intent: [\"competitor-analysis\"]} else . end" "$SPEND" > /tmp/spend-tagged.jsonl && mv /tmp/spend-tagged.jsonl "$SPEND"
```

## Schema

See `docs/spend-schema.md` for the full field reference.

| Field | Required | Description |
|-------|----------|-------------|
| `type` | yes | `api_call` or `session_summary` |
| `ts` | yes | ISO 8601 timestamp |
| `api` | yes | API hostname |
| `model` | yes* | Model identifier |
| `tokens_in` | yes* | Input tokens |
| `tokens_out` | yes* | Output tokens |
| `cost_usd` | yes* | Estimated cost |
| `project` | no | Project name |
| `purpose` | no | Human-readable intent |
| `intent` | no | Machine tags |
| `source` | yes | `hook`, `session_parse`, or `manual` |

*Required for `api_call` type.
