# agent-meter

Usage metering for the agent economy.

Drop-in metering for APIs that serve AI agents. Track every request, attribute it to an agent, and emit structured usage records — in three lines of code.

```typescript
import { AgentMeter } from "agent-meter";
const meter = new AgentMeter({ serviceId: "my-api" });
app.use(meter.express());
```

## Why

APIs are getting a new class of customer: autonomous agents. Agents call your API thousands of times, on behalf of humans you've never met, with usage patterns nothing like a browser session.

Subscriptions don't work when the buyer is a machine that can meter its own consumption. Usage-based pricing does — but only if you can measure it.

**agent-meter** gives you the measurement layer. Zero dependencies, framework-agnostic, and designed for the standards that are emerging around agent-to-service commerce.

## Install

```bash
npm install agent-meter
```

Zero runtime dependencies. Only uses Node.js built-in `crypto`.

## Quick Start

```typescript
import express from "express";
import { AgentMeter, MemoryTransport } from "agent-meter";

const app = express();
const transport = new MemoryTransport();
const meter = new AgentMeter({ serviceId: "my-api", transport });

app.use(meter.express());

app.get("/api/widgets", (req, res) => {
  res.json({ widgets: ["a", "b", "c"] });
});

app.listen(3000);
```

Agents identify themselves with the `X-Agent-Id` header. Every request from an identified agent produces a `UsageRecord`.

```bash
curl -H "X-Agent-Id: bot-123" http://localhost:3000/api/widgets
```

## Usage Records

Every metered request produces a structured record:

```json
{
  "id": "a1b2c3d4e5f6...",
  "timestamp": "2026-02-15T00:00:00.000Z",
  "serviceId": "my-api",
  "agent": {
    "agentId": "bot-123",
    "name": "WidgetBot"
  },
  "operation": "GET /api/widgets",
  "units": 1,
  "unitType": "request",
  "pricingModel": "per-call",
  "method": "GET",
  "path": "/api/widgets",
  "statusCode": 200,
  "durationMs": 12
}
```

## Configuration

```typescript
const meter = new AgentMeter({
  // Required: identifies your service
  serviceId: "my-api",

  // Where records go (default: MemoryTransport)
  transport: new HttpTransport({ url: "https://billing.example.com/ingest" }),

  // Default pricing model for all routes
  defaultPricing: "per-call",

  // Custom agent identification (default: X-Agent-Id header)
  identifyAgent: (req) => ({
    agentId: req.headers["authorization"],
    tier: req.headers["x-agent-tier"],
  }),

  // HMAC-SHA256 signature verification
  signingSecret: process.env.SIGNING_SECRET,

  // Transform or filter records before they're sent
  beforeEmit: (record) => {
    if (record.path === "/health") return undefined; // drop
    return { ...record, metadata: { region: "us-east-1" } };
  },

  // Whether to meter 4xx/5xx responses (default: false)
  meterErrors: false,
});
```

## Per-Route Options

```typescript
app.post("/api/generate", meter.express({
  operation: "generate-text",
  units: (req) => req.body.tokens,
  unitType: "token",
  pricing: "per-unit",
}));

app.get("/health", meter.express({ skip: true }));
```

## Transports

### MemoryTransport

Stores records in-memory. Useful for testing and development.

```typescript
import { MemoryTransport } from "agent-meter";

const transport = new MemoryTransport();
// After requests...
console.log(transport.records);
transport.flush(); // clear
```

### HttpTransport

Batches and POSTs records to a backend.

```typescript
import { HttpTransport } from "agent-meter";

const transport = new HttpTransport({
  url: "https://billing.example.com/ingest",
  headers: { Authorization: "Bearer sk-..." },
  batchSize: 10,          // flush every N records
  flushIntervalMs: 5000,  // or every 5 seconds
});
```

## Request Signing

Agents can sign requests with HMAC-SHA256 so your service can verify authenticity:

```typescript
// Agent side
import { signPayload } from "agent-meter";
const signature = signPayload(JSON.stringify(body), sharedSecret);
// Send as X-Agent-Signature header

// Service side
const meter = new AgentMeter({
  serviceId: "my-api",
  signingSecret: sharedSecret,
});
// Unsigned or invalid requests are silently dropped
```

## Architecture

```
Agent (X-Agent-Id header)
  │
  ▼
┌─────────────────────────┐
│  Your Express API       │
│  ┌───────────────────┐  │
│  │  agent-meter       │  │
│  │  middleware         │  │
│  └────────┬──────────┘  │
│           │ UsageRecord  │
└───────────┼──────────────┘
            ▼
┌─────────────────────────┐
│  Transport               │
│  (Memory, HTTP, custom)  │
└─────────────────────────┘
```

The SDK is framework-agnostic at its core. `AgentMeter.record()` works with any request/response pair. The `.express()` method is a thin adapter (~10 lines). Adapters for Fastify, Hono, and others are coming.

## Design Principles

- **Zero runtime dependencies.** Only `node:crypto`. Install pulls nothing.
- **Measure first, bill later.** This SDK captures usage. Billing is a separate concern.
- **Agent-native.** Built for machine clients, not browser sessions. Agent identity is a first-class concept.
- **Non-blocking.** Metering never delays your API response.
- **Extensible.** Custom transports, identification, pricing models, and hooks.

## Roadmap

- [ ] Fastify adapter
- [ ] Hono adapter
- [ ] File transport (JSONL append)
- [ ] Rate-limit awareness (meter + enforce)
- [ ] Agent-side SDK (sign requests, attach identity)
- [ ] Dashboard UI
- [ ] Hosted billing backend

## License

MIT
