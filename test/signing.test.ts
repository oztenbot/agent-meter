import { describe, it, expect } from "vitest";
import { signPayload, verifySignature } from "../src/signing.js";

describe("signing", () => {
  const secret = "test-secret-key";

  it("signs a payload deterministically", () => {
    const sig1 = signPayload("hello", secret);
    const sig2 = signPayload("hello", secret);
    expect(sig1).toBe(sig2);
    expect(sig1).toHaveLength(64); // SHA-256 hex
  });

  it("produces different signatures for different payloads", () => {
    const sig1 = signPayload("hello", secret);
    const sig2 = signPayload("world", secret);
    expect(sig1).not.toBe(sig2);
  });

  it("produces different signatures for different secrets", () => {
    const sig1 = signPayload("hello", "secret-a");
    const sig2 = signPayload("hello", "secret-b");
    expect(sig1).not.toBe(sig2);
  });

  it("verifies a valid signature", () => {
    const sig = signPayload("hello", secret);
    expect(verifySignature("hello", sig, secret)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const sig = signPayload("hello", secret);
    expect(verifySignature("tampered", sig, secret)).toBe(false);
  });

  it("rejects a wrong-length signature", () => {
    expect(verifySignature("hello", "tooshort", secret)).toBe(false);
  });
});
