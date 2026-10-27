import { describe, expect, it } from "vitest";
import { assessAmendment } from "@/lib/amendment-evidence";

// Verbatim shape of the live 신구대조표 chain (2026-10-27 probe, one article).
const LIVE_SHAPE = `═══ 개정 추적: 근로기준법 ═══

▶ 신구대조표 (최근 개정)
법령명: 근로기준법
개정구분: 일부개정
구법 공포일: 20260317
신법 공포일: 20260407

---
제13조
---

[개정 전]
제13조(보고, 출석의 의무) 사용자 또는 근로자는 고용노동부장관의 요구가 있으면 보고하여야 한다.

[개정 후]
제13조(보고, 출석의 의무) 사용자 또는 근로자는 고용노동부장관 또는 노동감독관의 요구가 있으면 보고하여야 한다.
`;

const FAILED_SECTION = `
▶ 조문 조회 [NOT_FOUND / FAILED]
사유: [FAILED] 하위 단계 실패`;

describe("assessAmendment", () => {
  it("confirms a comparison when both sides and the promulgation dates are stated", () => {
    const result = assessAmendment(LIVE_SHAPE);
    expect(result.status).toBe("matched");
    expect(result.items.map((item) => [item.label, item.status])).toEqual([
      ["개정 전후 조문 비교", "found"], ["시행일·공포일", "found"],
    ]);
  });

  it("is partial when an article has only one side", () => {
    const oneSided = `${LIVE_SHAPE}\n---\n제14조\n---\n\n[개정 전]\n제14조(구 조문) 구 내용이다.\n`;
    expect(assessAmendment(oneSided).status).toBe("partial");
  });

  it("is partial when pairs exist but no dates are stated", () => {
    const noDates = LIVE_SHAPE.replace("구법 공포일: 20260317\n신법 공포일: 20260407\n", "");
    expect(assessAmendment(noDates).status).toBe("partial");
  });

  it("counts a newly created article as a stated change, not a missing side", () => {
    const created = LIVE_SHAPE.replace(
      /\[개정 전\]\n제13조\(보고, 출석의 의무\) 사용자 또는 근로자는 고용노동부장관의 요구가 있으면 보고하여야 한다\./u,
      "[개정 전]\n<P><신  설></P>");
    expect(assessAmendment(created).status).toBe("matched");
  });

  it("reports retrieved material with no complete pair as viewed, not compared", () => {
    const headingOnly = `═══ 개정 추적: 근로기준법 ═══\n\n▶ 신구대조표 (최근 개정)\n법령명: 근로기준법\n`;
    expect(assessAmendment(headingOnly).status).toBe("viewed");
  });

  it("keeps the comparison but caps matched to partial when a section failed", () => {
    expect(assessAmendment(`${LIVE_SHAPE}${FAILED_SECTION}`).status).toBe("partial");
  });

  it("reports an empty search as none", () => {
    expect(assessAmendment("")).toEqual({ status: "none", items: [] });
  });
});
