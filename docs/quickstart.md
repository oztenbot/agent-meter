# Quickstart

Get metering running in under 5 minutes.

## Install

```bash
npm install agent-meter
```

Zero runtime dependencies. Uses only Node.js built-in `crypto`.

## Minimal Setup (3 lines)

```typescript
import { AgentMeter } from "agent-meter";
const meter = new AgentMeter({ serviceId: "my-api" });
app.use(meter.express());
```

That's it. Every request that includes an `X-Agent-Id` header now produces a `UsageRecord`.

## Full Express Example

### ESM (TypeScript / Node 18+)

```typescript
import express from "express";
import { AgentMeter, MemoryTransport } from "agent-meter";

const app = express();
app.use(express.json());

const transport = new MemoryTransport();
const meter = new AgentMeter({
  serviceId: "my-api",
  transport,
});

app.use(meter.express());

app.get("/api/widgets", (req, res) => {
  res.json({ widgets: ["a", "b", "c"] });
});

app.get("/debug/usage", (req, res) => {
  res.json(transport.summary());
});

app.listen(3000, () => {
  console.log("Listening on :3000");
});
```

### CJS (CommonJS)

```javascript
const express = require("express");
const { AgentMeter, MemoryTransport } = require("agent-meter");

const app = express();
app.use(express.json());

const transport = new MemoryTransport();
const meter = new AgentMeter({
  serviceId: "my-api",
  transport,
});

app.use(meter.express());

app.get("/api/widgets", (req, res) => {
  res.json({ widgets: ["a", "b", "c"] });
});

app.listen(3000);
```

## Verify It Works

Send a request from an agent:

```bash
curl -H "X-Agent-Id: bot-123" -H "X-Agent-Name: TestBot" \
  http://localhost:3000/api/widgets
```

Check the usage summary:

```bash
curl http://localhost:3000/debug/usage
```

You should see:

```json
{
  "totalRecords": 1,
  "totalUnits": 1,
  "uniqueAgents": 1,
  "byOperation": {
    "GET /api/widgets": { "count": 1, "units": 1 }
  },
  "byAgent": {
    "bot-123": { "count": 1, "units": 1 }
  }
}
```

## Next Steps

- **Persist records:** Switch to [SQLiteTransport](../README.md#sqlitetransport) for records that survive restarts
- **Send to a backend:** Use [HttpTransport](../README.md#httptransport) to forward records to your billing system
- **Per-route metering:** Track token counts, custom units, or skip health checks:
  ```typescript
  app.post("/api/generate", meter.express({
    operation: "generate-text",
    units: (req) => req.body.tokens,
    unitType: "token",
    pricing: "per-unit",
  }));

  app.get("/health", meter.express({ skip: true }));
  ```
- **Sign requests:** Add HMAC verification to prove request authenticity — see [Security Deep Dive](./security.md)

## Full API Reference

See [README.md](../README.md) for the complete configuration reference, transport options, and architecture overview.
