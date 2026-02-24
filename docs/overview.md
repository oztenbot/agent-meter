# Overview

agent-meter is a usage metering SDK for APIs that serve AI agents. This document covers the architecture, design decisions, and the path forward.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Agent (X-Agent-Id: bot-123)                │
│  ↓  HTTP request                            │
├─────────────────────────────────────────────┤
│  Your API (Express, Fastify, Hono, ...)     │
│                                             │
│  ┌──────────────────────────────────────┐   │
│  │  agent-meter middleware              │   │
│  │                                      │   │
│  │  1. Extract agent identity           │   │
│  │  2. Verify request signature (opt.)  │   │
│  │  3. Run beforeEmit hook (opt.)       │   │
│  │  4. Build UsageRecord                │   │
│  │  5. Non-blocking send to transport   │   │
│  └──────────────┬───────────────────────┘   │
│                 │  UsageRecord              │
└─────────────────┼───────────────────────────┘
                  ↓
     ┌────────────────────────────┐
     │  Transport                 │
     │                            │
     │  MemoryTransport           │ → in-process Vec
     │  SQLiteTransport           │ → local .db file
     │  HttpTransport             │ → billing backend
     │  AttestationTransport      │ → Merkle-attested batches
     │  (custom)                  │ → anything
     └────────────────────────────┘
```

Metering never delays API responses. The middleware wires to the response `finish` event — the record is built and sent after the response is written to the socket.

## Design Decisions

### Zero Runtime Dependencies

agent-meter uses only `node:crypto` (built into Node.js). No npm packages are required for the core SDK. This means:

- `npm install agent-meter` pulls nothing into your dependency graph
- No supply chain risk from transitive deps for the metering code itself
- Works in any Node.js environment without dependency conflicts

The only optional dependency is `better-sqlite3` for `SQLiteTransport`.

### Agent-Native Identity

Traditional APIs identify callers by IP address, OAuth token, or API key. Agents operate differently — a single agent might use many API keys, run on many IPs, and act on behalf of many users. agent-meter treats **agent identity as a first-class concept**:

```typescript
agent: {
  agentId: "bot-123",       // stable agent identity
  name: "WidgetBot",        // human-readable name
  shepherdId: "human-456",  // the human the agent acts for
  tier: "pro",              // pricing tier
}
```

The identity is extracted from request headers by default (`X-Agent-Id`, `X-Agent-Name`) but is fully customizable via the `identifyAgent` config option.

### Pluggable Transports

Where records go is separate from how they're generated. The transport interface is intentionally minimal:

```typescript
interface Transport {
  send(record: UsageRecord): void | Promise<void>;
  flush?(): void | Promise<void>;
}
```

This means you can implement a custom transport in ~5 lines — forward to Kafka, DynamoDB, your existing billing system, or anywhere else. The built-in transports cover the 80% cases: in-memory (dev/test), SQLite (single-server), HTTP (distributed).

### Measure First, Bill Later

agent-meter produces `UsageRecord` objects. It does not price them, invoice them, or charge anyone. This separation keeps the SDK focused and composable — wire it to whatever billing system you already have, or use agent-meter-server as a simple hosted backend.

### Non-Blocking

The `record()` call never `await`s the transport's `send()`. The response is sent immediately. Transports buffer records and flush asynchronously (with retry on failure). This means a slow backend cannot degrade your API's response latency.

## Attestation and Merkle Trees

For higher-assurance scenarios, `AttestationTransport` wraps any other transport and emits cryptographically signed batch attestations.

### How It Works

For each batch of `N` records:

1. Each record is HMAC-SHA256 hashed with the service's signing secret:
   ```
   leaf_i = HMAC-SHA256(secret, JSON.stringify(record_i))
   ```

2. A Merkle tree is built over all leaves:
   ```
   level_1 = [hash(leaf_0 + leaf_1), hash(leaf_2 + leaf_3), ...]
   level_2 = [hash(level_1[0] + level_1[1]), ...]
   root    = final single hash
   ```
   (Odd-count batches duplicate the last leaf.)

3. An attestation is signed over `batchId:timestamp:merkleRoot`:
   ```
   signature = HMAC-SHA256(secret, `${batchId}:${ts}:${merkleRoot}`)
   ```

### What This Proves

- **Completeness:** Given the Merkle root and any record, you can verify the record was in the batch (with proof path).
- **Integrity:** If any record is altered, the Merkle root changes, and the signature fails.
- **Origin:** The signature proves the batch was created by a process holding the signing secret.

### What This Does Not Prove

See [Security Deep Dive](./security.md) for the full trust model, including the oracle problem and attack scenarios.

## Roadmap

### Near-term
- [ ] Fastify adapter (`meter.fastify()`)
- [ ] Hono adapter (`meter.hono()`)
- [ ] Agent-side SDK: sign requests, attach identity, verify receipts

### In progress
- [ ] Rust port (`agent-meter-rs` on crates.io) — core library + axum middleware
- [ ] Hosted billing backend (`agent-meter-server`) — receive batches, generate invoices, enforce rate limits

### Future
- [ ] Python adapter
- [ ] Dashboard UI (read from SQLite or backend API)
- [ ] Webhook support (fire events on billing thresholds)
- [ ] Multi-tenant backend with per-service isolation

---

*See also: [Quickstart](./quickstart.md) | [Security Deep Dive](./security.md)*
