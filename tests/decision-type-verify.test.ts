import { describe, expect, it } from "vitest";
import { parseDecisionEntries, verifyDecisionEntry } from "@/server/decision-mcp";

/**
 * D-1 (law-accuracy-v3): a court-prefixed case number such as
 * "대법원-2023-다-302036" names its court family, so the digit-led domain
 * pattern — which a prefixed number can never satisfy — must not screen it
 * out before the prefix rule is reached.
 */
describe("verifyDecisionEntry court-prefix numbers", () => {
  it("keeps a 대법원-prefixed record in a precedent search", () => {
    expect(verifyDecisionEntry("precedent",
      { domain: "precedent", id: "1", caseNumber: "대법원-2023-다-302036" },
      new Set(["사건번호", "선고일"]))).toBe("matched");
  });

  it("parses a 대법원-prefixed record (법원: N/A) as matched", () => {
    const entries = parseDecisionEntries(
      "[0609561] 임금 지급 청구\n  사건번호: 대법원-2023-다-302036\n  법원: N/A\n  선고일: 20240208\n",
      "precedent");
    expect(entries).toHaveLength(1);
    expect(entries[0].court).toBe("대법원");
    expect(entries[0].typeVerification).toBe("matched");
  });

  it("rejects a 헌법재판소-prefixed record in a precedent search", () => {
    expect(verifyDecisionEntry("precedent",
      { domain: "precedent", id: "1", caseNumber: "헌법재판소-2023-헌마-123" },
      new Set(["사건번호", "선고일"]))).toBe("mismatched");
  });

  it("keeps a 헌법재판소-prefixed record in a constitutional search", () => {
    expect(verifyDecisionEntry("constitutional",
      { domain: "constitutional", id: "1", caseNumber: "헌법재판소-2023-헌마-123" },
      new Set(["사건번호", "종국일"]))).toBe("matched");
  });

  it("rejects a 대법원-prefixed record in a constitutional search", () => {
    expect(verifyDecisionEntry("constitutional",
      { domain: "constitutional", id: "1", caseNumber: "대법원-2023-다-302036" },
      new Set(["사건번호", "종국일"]))).toBe("mismatched");
  });

  it("still rejects a prefixed record in an unrelated domain", () => {
    expect(verifyDecisionEntry("ftc",
      { domain: "ftc", id: "1", caseNumber: "대법원-2023-다-302036" },
      new Set(["사건번호", "결정일"]))).toBe("mismatched");
  });

  it("leaves bare-number behaviour unchanged", () => {
    expect(verifyDecisionEntry("precedent",
      { domain: "precedent", id: "1", caseNumber: "2023다302036" },
      new Set(["사건번호", "선고일"]))).toBe("matched");
    expect(verifyDecisionEntry("precedent",
      { domain: "precedent", id: "1", caseNumber: "2023두12345" },
      new Set(["사건번호", "선고일"]))).toBe("matched");
  });
});
