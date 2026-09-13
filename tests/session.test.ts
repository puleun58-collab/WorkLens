import { describe, expect, it } from "vitest";
import { createSessionIdentity, principalFromCredential, requireSameOrigin, SessionError } from "@/server/session";

describe("anonymous session identity", () => {
  it("derives a stable principal key from a credential", () => {
    const { credential, principalKey } = createSessionIdentity();
    expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(principalKey).toMatch(/^[a-f0-9]{64}$/);
    expect(principalFromCredential(credential)).toBe(principalKey);
  });

  it("never derives the same principal for different credentials", () => {
    const keys = new Set(Array.from({ length: 50 }, () => createSessionIdentity().principalKey));
    expect(keys.size).toBe(50);
  });

  it("does not expose the credential inside the principal key", () => {
    const { credential, principalKey } = createSessionIdentity();
    expect(principalKey).not.toContain(credential);
  });

  it("rejects forged or malformed credentials", () => {
    for (const forged of ["", "short", "../../etc/passwd", "a".repeat(44), "a".repeat(43) + "!"]) {
      expect(() => principalFromCredential(forged)).toThrow(SessionError);
    }
  });

  it("rejects cross-site mutation requests", () => {
    expect(() => requireSameOrigin(new Request("https://worklens.internal/api/files", {
      method: "POST",
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    }))).toThrow(SessionError);
    expect(() => requireSameOrigin(new Request("https://worklens.internal/api/files", {
      method: "POST",
    }))).toThrow(SessionError);
    expect(() => requireSameOrigin(new Request("https://worklens.internal/api/files", {
      method: "POST",
      headers: { origin: "https://worklens.internal", "sec-fetch-site": "same-origin" },
    }))).not.toThrow();
  });
});
