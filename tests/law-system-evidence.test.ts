import { describe, expect, it } from "vitest";
import { assessLawSystem } from "@/lib/law-system-evidence";

// Verbatim shape of the live 법체계 확인 chain (2026-10-27 probe): a 3단 비교
// section with detailed-format sub-law articles whose bodies quote the
// parent law's delegation. Only excerpts are used; the module reads MCP text.
const LIVE_SHAPE = `═══ 법체계 확인: 근로기준법 ═══
법령ID: 001872 | MST: 285279 | 구분: 법률

▶ 3단 비교 (법률·시행령·시행규칙)
법령명: 근로기준법

---
제11조 제11조(적용 범위)
---

[시행령] 근로기준법 시행령 제7조 (적용범위)
법 제11조제2항에 따라 상시 4명 이하의 근로자를 사용하는 사업 또는 사업장에 적용하는 법 규정은 별표 1과 같다.

[시행규칙] 근로기준법 시행규칙 제4조 (해고 예고의 예외가 되는 근로자의 귀책사유)
법 제26조제3호에서 "고용노동부령으로 정하는 사유"란 별표 1과 같다.

▶ 핵심 조문
근로기준법
제1조 목적
이 법은 헌법에 따라 근로조건의 기준을 정함으로써 근로자의 기본적 생활을 보장, 향상시키며 균형 있는 국민경제의 발전을 꾀하는 것을 목적으로 한다.
`;

const FAILED_SECTION = `
▶ 조문 조회 [NOT_FOUND / FAILED]
사유: [FAILED] 하위 단계 실패`;

describe("assessLawSystem", () => {
  it("confirms all three tiers when both sub-law bodies quote the parent law's delegation", () => {
    const result = assessLawSystem(LIVE_SHAPE);
    expect(result.status).toBe("matched");
    expect(result.items.map((item) => [item.label, item.status])).toEqual([
      ["법률", "found"], ["시행령", "found"], ["시행규칙", "found"],
    ]);
  });

  it("is partial when only one sub-law tier is delegation-anchored", () => {
    const oneTier = LIVE_SHAPE.replace(/\[시행규칙\][\s\S]*?(?=\n▶ 핵심 조문)/u, "");
    const result = assessLawSystem(oneTier);
    expect(result.status).toBe("partial");
    expect(result.items.find((item) => item.label === "시행규칙")?.status).toBe("none");
  });

  it("does not confirm a tier from an unanchored listing (viewed, not matched)", () => {
    const unanchored = LIVE_SHAPE
      .replace("법 제11조제2항에 따라 ", "")
      .replace('법 제26조제3호에서 "고용노동부령으로 정하는 사유"란', "별표 1과 같다.");
    const result = assessLawSystem(unanchored);
    expect(result.status).toBe("viewed");
    expect(result.items.filter((item) => item.label !== "법률").map((item) => item.status)).toEqual(["viewed", "viewed"]);
  });

  it("does not call a law-only answer a full system confirmation", () => {
    const lawOnly = `═══ 법체계 확인: 근로기준법 ═══\n\n▶ 핵심 조문\n근로기준법\n제1조 목적\n이 법은 근로조건의 기준을 정함을 목적으로 한다.\n`;
    expect(assessLawSystem(lawOnly).status).toBe("viewed");
  });

  it("keeps confirmed tiers but caps matched to partial when a section failed", () => {
    expect(assessLawSystem(`${LIVE_SHAPE}${FAILED_SECTION}`).status).toBe("partial");
  });

  it("reports an empty search as none", () => {
    expect(assessLawSystem("")).toEqual({ status: "none", items: [] });
  });
});
