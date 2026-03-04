# Spend JSONL Schema

The universal contract for agent API spend data. All capture methods — hooks, session parsers, manual entry — produce the same format. Crabacus and `/meter` consume it.

**File location:** `~/.agent-meter/spend.jsonl` (one JSON object per line)

## Record Types

### `api_call` — Individual API request

```json
{
  "type": "api_call",
  "ts": "2026-03-04T18:30:00.000Z",
  "api": "api.anthropic.com",
  "model": "claude-sonnet-4-20250514",
  "tokens_in": 1200,
  "tokens_out": 450,
  "cost_usd": 0.0087,
  "project": "oztenbot",
  "purpose": "heartbeat-analysis",
  "intent": ["moltbook-engagement", "feed-analysis"],
  "key_alias": "oztenbot-main",
  "session_id": "abc123",
  "agent_id": "oztenbot",
  "operation": "messages.create",
  "status": 200,
  "duration_ms": 3200,
  "source": "hook",
  "meta": {}
}
```

### `session_summary` — Aggregated session totals

```json
{
  "type": "session_summary",
  "ts": "2026-03-04T19:00:00.000Z",
  "api": "api.anthropic.com",
  "session_id": "abc123",
  "agent_id": "oztenbot",
  "total_calls": 12,
  "tokens_in": 45000,
  "tokens_out": 8500,
  "cost_usd": 0.285,
  "duration_ms": 180000,
  "source": "hook"
}
```

## Field Reference

### Required fields (all records)

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"api_call"` \| `"session_summary"` | Record type |
| `ts` | ISO 8601 string | When the event occurred |
| `api` | string | API hostname (e.g., `api.anthropic.com`, `api.openai.com`) |
| `source` | `"hook"` \| `"session_parse"` \| `"manual"` | How this record was created |

### Required for `api_call`

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Model used (e.g., `claude-sonnet-4-20250514`) |
| `tokens_in` | number | Input/prompt tokens |
| `tokens_out` | number | Output/completion tokens |
| `cost_usd` | number | Estimated cost in USD |

### Optional fields

| Field | Type | Description |
|-------|------|-------------|
| `project` | string | Project or repo name |
| `purpose` | string | Why this call was made (human-readable) |
| `intent` | string[] | Machine tags for categorization |
| `key_alias` | string | Which API key was used (alias, not the key) |
| `session_id` | string | Session/conversation identifier |
| `agent_id` | string | Agent making the call |
| `operation` | string | API operation (e.g., `messages.create`, `chat.completions`) |
| `status` | number | HTTP status code |
| `duration_ms` | number | Request duration in milliseconds |
| `meta` | object | Arbitrary metadata |

## Mapping to UsageRecord (SDK)

| spend.jsonl | UsageRecord (SDK) | Notes |
|-------------|-------------------|-------|
| `api` | `serviceId` | hostname → service identifier |
| `tokens_in + tokens_out` | `units` | sum for total units |
| — | `unitType` | always `"token"` for LLM calls |
| `operation` | `operation` | direct mapping |
| `status` | `statusCode` | direct mapping |
| `duration_ms` | `durationMs` | direct mapping |
| `meta` | `metadata` | direct mapping |

## Design Decisions

**Why JSONL, not SQLite?** Append-only writes are safe from any process (hooks, cron, manual). No locking. Any tool can read it (`jq`, `grep`, `awk`). SQLite is the query layer (crabacus), not the capture layer.

**Why `~/.agent-meter/`?** User-level, not project-level. Spend spans projects. One agent, one spend log.

**Why `cost_usd` at capture time?** Pricing changes. The cost at time-of-call is the cost that matters for budgeting. Recalculation from tokens uses stale rates.
