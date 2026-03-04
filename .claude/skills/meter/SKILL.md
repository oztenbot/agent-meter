---
name: agent-meter
description: "Track API spend with intent-level attribution. Shows where your tokens go by project and purpose. Invoke with /meter for spend summary."
version: "0.1.0"
user-invocable: true
---

# /meter — API Spend Tracker

When the user invokes `/meter`, first check if hooks are installed. If not, install them automatically. Then show a spend summary.

## First-Run Setup

Before showing data, check if the capture hooks are installed. Run this bash command:

```bash
SKILL_DIR=""
# Find the skill directory (where this SKILL.md and scripts live)
for d in "$HOME/.claude/skills/agent-meter" "$HOME/.claude/skills/meter" ".claude/skills/meter" ".claude/skills/agent-meter"; do
  if [ -f "$d/meter-capture.sh" ]; then
    SKILL_DIR="$d"
    break
  fi
done

HOOKS_INSTALLED=true
if [ ! -f ".claude/hooks/meter-capture.sh" ] || [ ! -f ".claude/hooks/meter-session-end.sh" ]; then
  HOOKS_INSTALLED=false
fi

if [ "$HOOKS_INSTALLED" = "false" ] && [ -n "$SKILL_DIR" ]; then
  echo "NEEDS_SETUP|$SKILL_DIR"
elif [ "$HOOKS_INSTALLED" = "false" ]; then
  echo "NEEDS_SETUP_NO_SCRIPTS"
else
  echo "HOOKS_OK"
fi
```

If the output is `NEEDS_SETUP|<path>`:
1. Copy the hooks from the skill directory into `.claude/hooks/`:
   ```bash
   mkdir -p .claude/hooks
   cp <path>/meter-capture.sh .claude/hooks/
   cp <path>/meter-session-end.sh .claude/hooks/
   chmod +x .claude/hooks/meter-capture.sh .claude/hooks/meter-session-end.sh
   ```
2. Read the current `.claude/settings.json` (if it exists) and merge in the hook configuration. Do NOT overwrite existing hooks — add to the existing arrays:
   - Add to `PostToolUse`: `{"matcher": "Bash", "hooks": [{"type": "command", "command": "/bin/bash .claude/hooks/meter-capture.sh"}]}`
   - Add to `Stop`: `{"hooks": [{"type": "command", "command": "/bin/bash .claude/hooks/meter-session-end.sh"}]}`
3. Tell the user: "Installed agent-meter hooks. API spend will be captured starting next session. Run `/meter` again after making some API calls."

If the output is `NEEDS_SETUP_NO_SCRIPTS`, tell the user the hook scripts weren't found and suggest `clawhub install agent-meter` or cloning from https://github.com/oztenbot/agent-meter.

If the output is `HOOKS_OK`, proceed to show the spend summary below.

## Execution

Run this bash command to produce the summary:

```bash
SPEND_FILE="$HOME/.agent-meter/spend.jsonl"
if [ ! -f "$SPEND_FILE" ]; then
  echo "No spend data yet. Hooks are installed — spend will be captured starting next session."
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

All scripts are bundled in this skill package. After installing via `clawhub install agent-meter`, the scripts are at `.claude/skills/meter/`.

1. Copy the bundled hooks to your project's hooks directory:

```bash
mkdir -p .claude/hooks
cp .claude/skills/meter/meter-capture.sh .claude/hooks/
cp .claude/skills/meter/meter-session-end.sh .claude/hooks/
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

### What the hooks do

- **meter-capture.sh** (PostToolUse, Bash only): Reads the hook's stdin JSON. Fast-exits for non-API commands. When a Bash command targets a known LLM API (Anthropic, OpenAI, etc.), parses the response for token usage and appends a JSONL record to `~/.agent-meter/spend.jsonl`. No network calls, no secrets access, jq dependency only.
- **meter-session-end.sh** (Stop): Aggregates all `api_call` records for the current session into a single `session_summary` record. Appends to the same spend.jsonl.

## Quick Setup — OpenClaw

The bundled `meter-parse-sessions.sh` script parses OpenClaw session transcripts for token/cost data.

1. Copy the parser and make it executable:

```bash
cp .claude/skills/meter/meter-parse-sessions.sh ~/.local/bin/meter-parse-sessions.sh
chmod +x ~/.local/bin/meter-parse-sessions.sh
```

2. Add to your heartbeat or cron:

```bash
# Every 30 minutes, parse new sessions
*/30 * * * * ~/.local/bin/meter-parse-sessions.sh
```

### What the parser does

Scans `~/.openclaw/agents/*/sessions/*.jsonl` for session transcripts. Extracts `message.usage.input_tokens`, `message.usage.output_tokens`, and `message.usage.cost.total`. Deduplicates against existing records by session ID. Appends new records with `"source": "session_parse"` to `~/.agent-meter/spend.jsonl`. No network calls, no secrets access, jq dependency only.

## Source Code

All scripts are included in this package and also available at: https://github.com/oztenbot/agent-meter

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
