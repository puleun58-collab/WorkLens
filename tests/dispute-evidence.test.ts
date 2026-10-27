import { describe, expect, it } from "vitest";
import { assessDispute } from "@/lib/dispute-evidence";

const QUERY = "부당해고 구제신청과 행정소송 판례";
const SEARCH = `▶ 대법원 판례
판례 검색 결과 (총 1건):

[1] 부당해고구제재심판정취소
  사건번호: 2019두12345
  법원: 대법원
  선고일: 20240101
`;
const DETAIL = `▶ 대법원 판례 상세
자동 상세조회: search_precedents -> get_precedent_text (상위 1건, full=false)

[1] 부당해고구제재심판정취소
사건번호: 2019두12345
법원: 대법원
선고일: 20240101

판시사항:
부당해고 구제신청에 대한 재심판정이 적법한지 여부

판결요지:
부당해고 구제신청은 해고의 정당성을 다투는 절차이다.
`;
const OFF_TOPIC_DETAIL = DETAIL.replace(/부당해고 구제신청에 대한 재심판정이 적법한지 여부/u, "단체교섭의무를 부담하는 사용자에 관한 종전 법리")
  .replace(/부당해고 구제신청은 해고의 정당성을 다투는 절차이다\./u, "단체교섭의무에 관한 법리이다.");

describe("assessDispute", () => {
  it("confirms a decision only when its substance was fetched and names a question subject", () => {
    const result = assessDispute(QUERY, `${SEARCH}\n${DETAIL}`);
    expect(result.status).toBe("matched");
    expect(result.items).toEqual([{ label: "판례·결정례·재결례", status: "found", detail: "검색 1건 · 상세 확인 1건" }]);
  });

  it("does not adopt a title-only search hit", () => {
    expect(assessDispute(QUERY, SEARCH).status).toBe("viewed");
  });

  it("does not adopt fetched substance about another case", () => {
    expect(assessDispute(QUERY, `${SEARCH}\n${OFF_TOPIC_DETAIL}`).status).toBe("viewed");
  });

  it("is partial when only the statute kind is verified for a question asking both", () => {
    const text = `▶ AI 법령검색 결과
지능형 법령검색 결과 (법령조문, 1건):

근로기준법
    제30조 (해고 등의 제한)
    사용자는 근로자를 부당하게 해고하지 못한다.
    시행: 2024.01.01 | 고용노동부

${SEARCH}`;
    const result = assessDispute("해고 법령과 판례", text);
    expect(result.status).toBe("partial");
    expect(result.items.map((item) => [item.label, item.status])).toEqual([
      ["관련 법령", "found"], ["판례·결정례·재결례", "viewed"],
    ]);
  });

  it("reports an empty search as none", () => {
    expect(assessDispute(QUERY, "")).toEqual({ status: "none", items: [] });
  });
});
