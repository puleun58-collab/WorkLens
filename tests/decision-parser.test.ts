import { describe, expect, it } from "vitest";
import { parseDecisionEntries, parseDecisionText } from "@/server/decision-mcp";

const results = [
  {
    domain: "precedent" as const,
    text: "판례 검색 결과 (총 32건, 1페이지):\n\n[0609561] 부당해고구제재심판정취소\n  사건번호: 2024두12345\n  법원: 대법원\n  선고일: 20250109\n  판결유형: 판결\n\n💡 다음: get_precedent_text(id=\"0609561\")",
    entry: { domain: "precedent", id: "0609561", title: "부당해고구제재심판정취소", caseNumber: "2024두12345", court: "대법원", date: "20250109" },
  },
  {
    domain: "constitutional" as const,
    text: "헌재결정례 검색 결과 (총 2건, 1페이지):\n\n[521703] 근로기준법 제○조 위헌소원\n  사건번호: 2020헌바123\n  종국일: 20240627\n  링크: https://www.law.go.kr/...",
    entry: { domain: "constitutional", id: "521703", title: "근로기준법 제○조 위헌소원", caseNumber: "2020헌바123", date: "20240627" },
  },
  {
    domain: "admin_appeal" as const,
    text: "행정심판례 검색 결과 (총 5건, 1페이지):\n\n[237753] 부당한 처분 취소청구\n  사건번호: 2023-01987\n  의결일: 20240311\n  재결청: 중앙행정심판위원회\n  재결구분: 인용",
    entry: { domain: "admin_appeal", id: "237753", title: "부당한 처분 취소청구", caseNumber: "2023-01987", institution: "중앙행정심판위원회", date: "20240311" },
  },
  {
    domain: "interpretation" as const,
    text: "해석례 검색 결과 (총 11건, 1페이지):\n\n[338575] 근로기준법에 따른 연차휴가 관련 질의\n  해석례번호: 23-0984\n  회신일자: 20240209\n  해석기관: 법제처\n  링크: https://www.law.go.kr/...",
    entry: { domain: "interpretation", id: "338575", title: "근로기준법에 따른 연차휴가 관련 질의", caseNumber: "23-0984", institution: "법제처", date: "20240209" },
  },
];

describe("decision tool text parsing", () => {
  it.each(results)("reads actual bracketed $domain records while omitting unsupported metadata", ({ domain, text, entry }) => {
    expect(parseDecisionEntries(text, domain)).toEqual([entry]);
  });

  it("keeps zero-padded IDs, ignores invalid records and never promotes notes to a result", () => {
    const text = "[000123] (제목 없음)\n  사건번호: N/A\n  법원: 서울고등법원\n\n[NOT_FOUND] a note, not a record\n[undefined] malformed\n[12/34] unsafe\n다음: [99] quoted in a note";
    expect(parseDecisionEntries(text, "precedent")).toEqual([{ domain: "precedent", id: "000123", court: "서울고등법원" }]);
  });

  it("parses shared committee and special-appeal fields without fabricating absent fields", () => {
    expect(parseDecisionEntries("공정거래위원회 결정문 검색 결과 (총 1건, 1페이지):\n\n[921] 부당 공동행위\n  사건번호: 2024심사17\n  결정일: 20250708\n  재결청: 공정거래위원회", "ftc"))
      .toEqual([{ domain: "ftc", id: "921", title: "부당 공동행위", caseNumber: "2024심사17", date: "20250708", institution: "공정거래위원회" }]);
    expect(parseDecisionEntries("[511] 소청심사\n  청구번호: 2023-05\n  의결일: 20240512", "appeal_review"))
      .toEqual([{ domain: "appeal_review", id: "511", title: "소청심사", caseNumber: "2023-05", date: "20240512" }]);
  });
  it("ignores prose embedded between result metadata without inventing new records", () => {
    expect(parseDecisionEntries("[512] 재결 제목\n  사건번호: 2024-55\n원문 제공 여부는 기관에 확인하세요.\n  의결일: 20240512", "admin_appeal"))
      .toEqual([{ domain: "admin_appeal", id: "512", title: "재결 제목", caseNumber: "2024-55", date: "20240512" }]);
  });

  it("extracts known headings but leaves the source text byte-for-byte intact", () => {
    const text = "=== 휴업수당 관련 사건 ===\n\n기본 정보:\n  사건번호: 2024두12345\n\n판결요지:\n요지는 그대로.\n\n전문:\n첫 문단.\n둘째 문단.\n\n⋯ 중략 2,120자 (full=true로 전문 조회) ⋯\n\n끝 문단.\n";
    const parsed = parseDecisionText(text);
    expect(parsed.text).toBe(text);
    expect(parsed.title).toBe("휴업수당 관련 사건");
    expect(parsed.expandable).toBe(true);
    expect(parsed.sections).toEqual([
      { heading: "판결요지", text: "요지는 그대로." },
      { heading: "전문", text: "첫 문단.\n둘째 문단.\n\n⋯ 중략 2,120자 (full=true로 전문 조회) ⋯\n\n끝 문단." },
    ]);
    expect(parseDecisionText("서식 없는 본문\n본문 자체가 원본")).toEqual({ text: "서식 없는 본문\n본문 자체가 원본", expandable: false });
  });
});
