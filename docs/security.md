# agent-meter Security Deep Dive

This document covers the trust model, threat analysis, and attack scenarios for agent-meter. If you're deploying agent-meter in a production billing context, read this first.

---

## The Core Trust Problem

agent-meter sits in the middle of a three-party relationship:

```
User Y (Agent) ←→ Service X (your API) ←→ Backend (billing/metering)
                         ↑
                    agent-meter SDK
                    (runs in Service X's process)
```

Two distinct trust questions arise:

### Why does Service X trust agent-meter?

The SDK runs **inside Service X's own process**. It is as trusted as the process itself — no more, no less. This means:

**What agent-meter guarantees:**
- Tamper-evident local records via HMAC-SHA256 per usage record
- Merkle attestation for batches: the set of records cannot be silently altered in transit
- Consistent attribution: `serviceId` is bound at meter initialization, not per-request

**What agent-meter cannot guarantee:**
- That metered events represent truthful usage. This is the **oracle problem** — cryptography cannot solve it. If Service X's environment is compromised, or if the operator configures `beforeEmit` to fabricate usage, the SDK will faithfully sign and forward fraudulent records.
- That HMAC signatures are meaningful if the signing secret leaks. Signatures prove origin, not truth.

**Risk:** A compromised or misconfigured SDK in Service X's environment can report arbitrary usage. This is a process-level trust boundary, not a cryptographic one.

**Mitigation:** Deploy agent-meter in a minimal, isolated process. Don't give the metering process write access to your database or config stores. Rotate signing secrets regularly.

---

### Why does User Y (the agent) trust Service X's metering?

An agent calling Service X has no way to verify that Service X is metering honestly. Service X could:
- Not meter some calls (underbilling — rarely a problem for agents)
- Double-meter calls (overbilling)
- Fabricate entire billing periods

**What the agent can verify:**
- Signed event receipts: if Service X provides download access to signed usage records, the agent can verify each record's HMAC signature
- Audit log with Merkle proofs: if the agent receives attestations, it can verify that no records were added or removed from a batch after the fact

**What the agent cannot verify:**
- That Service X configured the SDK correctly and isn't filtering records
- That Service X isn't fabricating records wholesale (the signatures would still be valid — they prove the records came from that service, not that the usage was real)

**Mitigation:** Agents should export their own request logs and periodically reconcile against usage records from Service X. Discrepancies signal either bugs or fraud. This is the same reconciliation model used in financial systems — receipts plus statements.

---

## Threat Model

| Threat | Mitigated? | How |
|--------|-----------|-----|
| In-transit tampering | Yes | HMAC-SHA256 per record; batch integrity checked on receipt |
| Batch manipulation (add/remove records) | Yes | Merkle root covers all records; signature covers Merkle root |
| Replay attacks | Partial | Event IDs are unique (random hex); timestamp included. Full dedup requires backend to track seen event IDs |
| DDoS via fake usage flood | Partial | Backend rate limiting per agent + circuit breakers; SDK does not validate agent identity |
| Confused deputy (wrong customer billed) | Yes | `serviceId` is bound at `AgentMeter` init time, not per-request |
| Oracle problem (fabricated events) | No | Unsolvable cryptographically. Requires out-of-band reconciliation |
| Financial ruin via metering DDoS | Partial | Backend rate limits + financial circuit breakers. Document billing caps explicitly |
| Supply chain compromise of agent-meter SDK | No | Open source + audit trail. Recommend dependency pinning and lockfile verification |
| HMAC secret leakage | Partial | Per-service secrets limit blast radius. Recommend rotation policy and secret scanning in CI |
| Agent forging X-Agent-Id header | No (by design) | agent-meter reads identity headers but does not cryptographically verify agent identity. Identity is asserted, not proved |
| Agent forging X-Agent-Signature | No | HMAC signatures require shared secret. Without the secret, signatures cannot be forged. Secret must be shared out-of-band |

---

## Attack Scenarios

### Attack 1: DDoS on Metering → Bill Amplification

**Scenario:** An adversary (or a runaway agent) sends millions of requests to Service X, each with a valid `X-Agent-Id` header. agent-meter faithfully records each one. The backend generates an invoice for millions of units.

**How it unfolds:**
1. Adversary sends `X-Agent-Id: victim-agent-123` in all requests
2. Service X's API handles or drops the requests
3. agent-meter records all requests that get a non-error response (or all requests if `meterErrors: true`)
4. Backend accumulates records. Invoice = millions of calls.
5. Victim agent receives invoice for usage they didn't authorize.

**Current mitigations:**
- Backend-side rate limiting (see agent-meter-server): per-agent sliding window, 429 on breach
- `HttpTransport` handles 429 via `onError` callback — operator can pause or drop records
- `beforeEmit` hook: operator can implement custom rate limiting before records are emitted

**Open risks:**
- Rate limits must be configured. Default is permissive.
- Financial circuit breakers (hard spend caps) are the operator's responsibility. agent-meter does not implement them.
- Agent identity is asserted via header, not proved. Any process can claim to be `victim-agent-123`.

**Recommendation:** Implement financial circuit breakers. Require agents to authenticate before their usage is recorded (OAuth, API keys, or signed requests). Alert on unusual usage spikes before they become invoices.

---

### Attack 2: Replay of Signed Events Within Timestamp Window

**Scenario:** An agent signs a request body with HMAC-SHA256 and sends it to Service X. An adversary intercepts the request and replays it multiple times.

**How it unfolds:**
1. Agent sends request with `X-Agent-Signature: abc123...`
2. Service X validates the signature — it's valid
3. Adversary captures the HTTP request
4. Adversary replays the same request 1000 times within the timestamp acceptance window
5. Each replay passes signature validation (same payload, same signature)
6. Each replay is metered. Agent is billed 1000x.

**Current state:**
- agent-meter validates that the HMAC signature is correct for the request body
- agent-meter does **not** deduplicate on signature or event ID at the SDK level
- Event IDs in `UsageRecord` are generated at record time, not derived from the request — replays produce distinct event IDs

**Mitigation (requires backend):**
- Backend must track seen `X-Agent-Signature` values within a time window
- Requests should include a `timestamp` or `nonce` in the signed payload — the SDK does not enforce this today
- Short-lived tokens or per-request nonces are the standard solution

**Open risk:** Without backend deduplication, replay attacks within any acceptance window are unbounded.

---

### Attack 3: Compromised SDK Reporting Arbitrary Usage for Service X

**Scenario:** An attacker gains code execution in Service X's deployment environment (e.g., via a supply chain attack on a dependency). The attacker modifies the `beforeEmit` hook or the transport to inject fabricated records.

**How it unfolds:**
1. Malicious package `foo@2.1.0` is installed in Service X's `node_modules`
2. `foo` patches `AgentMeter.prototype.record` at runtime
3. For every legitimate request, `foo` emits 10 fabricated records for agents it wants to frame
4. All records are HMAC-signed with Service X's legitimate signing secret (it's in the same process)
5. Backend receives and accepts all records as valid

**Why this works:** HMAC signatures prove the records were created by a process that holds the signing secret. They do not prove the records represent real requests.

**Mitigations:**
- Dependency pinning + lockfile verification in CI
- Runtime integrity checks (e.g., subresource integrity for modules, in environments that support it)
- Separate metering process with minimal permissions — if metering runs in an isolated sidecar, it's harder to compromise from within the app
- Signed receipts from agents: if agents sign their own requests and Service X forwards those signatures, a reconciling third party can verify that signed requests match metered events

**Open risk:** This is a fundamental limitation. If the signing process is compromised, all cryptographic guarantees are void. Defense-in-depth is the only answer.

---

### Attack 4: Agent Forging X-Agent-Id to Misattribute Usage

**Scenario:** Agent A claims to be Agent B by sending `X-Agent-Id: agent-b-123`. Service X meters the usage under Agent B's account.

**How it unfolds:**
1. Agent A sends requests with `X-Agent-Id: agent-b-123`
2. Service X has no mechanism to verify Agent A's claimed identity
3. All usage is attributed to Agent B
4. Agent B receives an invoice for Agent A's activity

**Current state:**
- agent-meter reads `X-Agent-Id` as an assertion, not a proof
- No identity verification is built into the SDK
- The `signingSecret` feature verifies request body integrity, not agent identity

**Mitigation:**
- Require agents to authenticate at the application layer (API keys, OAuth) before their usage is recorded
- The `identifyAgent` config function can be wired to your auth middleware:
  ```typescript
  identifyAgent: (req) => {
    const agent = req.user; // from your auth middleware
    if (!agent) return undefined;
    return { agentId: agent.id, tier: agent.tier };
  }
  ```
- Agent identity must be established before metering. agent-meter is identity-agnostic by design — plugging in your own identity system is the intended pattern.

**Open risk:** Until identity is verified at the application layer, any agent can impersonate any other agent.

---

## Recommendations Summary

For production billing use:

1. **Verify agent identity at the application layer.** Don't rely on `X-Agent-Id` as a trust anchor. Wire `identifyAgent` to your auth system.

2. **Enable backend deduplication.** Track seen event IDs. Implement timestamp windows with nonce requirements for signed requests.

3. **Configure financial circuit breakers.** Set hard spend caps per agent. Alert before they become invoices.

4. **Rotate signing secrets regularly.** Use per-service secrets. Run secret scanning in CI to prevent accidental exposure.

5. **Pin dependencies and verify lockfiles.** Run `npm audit` or equivalent in CI. Consider a dependency review process for transitive dependencies.

6. **Provide signed receipts to agents.** If agents can download their usage records and verify signatures + Merkle proofs, they can detect overbilling. This aligns incentives.

7. **Implement reconciliation.** Agents should keep their own request logs and reconcile periodically. Treat unexplained discrepancies as security events.

---

## What This Is Not

agent-meter is a **measurement layer**. It produces tamper-evident records of what your metering system observed. It is not:

- A payment processor
- An identity provider
- A fraud detection system
- An audit authority

The cryptographic properties (HMAC signing, Merkle attestation) are tools for **detecting tampering**, not preventing it. The underlying trust model is the same as any receipt system: receipts prove what was recorded, not what actually happened.

---

*See also: [Overview](./overview.md) | [Quickstart](./quickstart.md)*
