import { describe, expect, it } from "vitest";
import { DECISION_DOMAINS, type DecisionDomain } from "@/lib/decision-domain";
import { decisionIdentifier, decisionSearchQuery, splitExactResults } from "@/lib/decision-identifier";
import type { DecisionEntry } from "@/lib/decision-search";

const entry = (domain: DecisionDomain, id: string, caseNumber?: string): DecisionEntry => ({ domain, id, title: `t${id}`, ...(caseNumber ? { caseNumber } : {}) });

describe("decision identifiers per domain", () => {
  // Numbers observed in 법제처 responses for each domain.
  const cases: Array<[DecisionDomain, string[], string]> = [
    ["precedent", ["2013다61381", "2013 다61381", "2013다 61381", "2013 다 61381"], "2013다61381"],
    ["constitutional", ["2022헌마1312", "2022 헌마 1312"], "2022헌마1312"],
    ["admin_appeal", ["2013-01262", "2013 - 01262"], "2013-01262"],
    ["interpretation", ["06-0152"], "06-0152"],
    ["tax_tribunal", ["조심2012서3406", "조심 2012서3406"], "조심2012서3406"],
    ["ftc", ["2011카총0367", "2011 카총 0367"], "2011카총0367"],
    ["pipc", ["제2026-109-013호", "2026-109-013"], "2026-109-013"],
  ];

  it.each(cases)("%s: formats of one number search the same canonical form", (domain, inputs, search) => {
    for (const input of inputs) expect(decisionIdentifier(domain, input), input).toEqual({ search, key: search });
  });

  it("leaves keywords and loose numbers to the keyword search", () => {
    for (const [domain, query] of [
      ["precedent", "취업규칙 불이익 변경"], ["precedent", "2013년 손해배상 판례"], ["precedent", "제23조 해고"],
      ["pipc", "2025 개인정보 결정"], ["ftc", "2024 과징금"], ["nlrc", "2026 노동위 결정"], ["admin_appeal", "2013-1262"],
    ] as const) {
      expect(decisionIdentifier(domain, query), query).toBeNull();
      expect(decisionSearchQuery(domain, `  ${query}`)).toBe(query);
    }
  });

  it("offers no identifier where 법제처 gives no stable unique number", () => {
    for (const domain of ["customs", "nts", "nlrc", "acr", "appeal_review", "acr_special"] as const) {
      expect(decisionIdentifier(domain, "2013다61381")).toBeNull();
    }
    expect(DECISION_DOMAINS).toHaveLength(13);
  });

  it("puts only exact numbers first, once each, and keeps every other result", () => {
    const identifier = decisionIdentifier("tax_tribunal", "조심 2018광1070")!;
    const { exact, others } = splitExactResults("tax_tribunal", identifier, [
      entry("tax_tribunal", "1", "조심2018광1071"),
      entry("tax_tribunal", "2", "조심 2018광1070"),
      entry("tax_tribunal", "3"),
      entry("tax_tribunal", "2", "조심 2018광1070"),
      entry("tax_tribunal", "4", "조심2018광1070"),
    ]);
    expect(exact.map((item) => item.id)).toEqual(["2", "4"]);
    expect(others.map((item) => item.id)).toEqual(["1", "3"]);
  });
});
