import { describe, expect, it } from "vitest";
import { LAW_ANALYSIS_CASE_PATTERN, lawAnalysisRequestFor, normalizeCaseNumber, type LawAnalysisDraft } from "@/lib/law-analysis";
import { decisionIdentifier, decisionSearchQuery } from "@/lib/decision-identifier";
import { exactCurrentLaw, parseLawArticleQuery } from "@/lib/law-search";

describe("law search input", () => {
  it("splits a law name and article at the article number, ignoring a 항/호 and a short request", () => {
    expect(parseLawArticleQuery("민법 제750조")).toEqual({ lawName: "민법", jo: "제750조" });
    expect(parseLawArticleQuery("근로기준법 제10조의2")).toEqual({ lawName: "근로기준법", jo: "제10조의2" });
    expect(parseLawArticleQuery("근로기준법 제74조 내용 알려줘")).toEqual({ lawName: "근로기준법", jo: "제74조" });
    expect(parseLawArticleQuery("민법 제750조 보여줘")).toEqual({ lawName: "민법", jo: "제750조" });
    expect(parseLawArticleQuery("근로기준법 제60조 제6항 제3호")).toEqual({ lawName: "근로기준법", jo: "제60조" });
    expect(parseLawArticleQuery("전자상거래 등에서의 소비자보호에 관한 법률 제17조")).toEqual({ lawName: "전자상거래 등에서의 소비자보호에 관한 법률", jo: "제17조" });
  });

  it("leaves keywords and ambiguous inputs to the ordinary search", () => {
    for (const query of ["근로기준법", "산업안전", "해고", "750조 관련 법", "제750조", "민법 제750조와 형법 제10조", "민법 제0조", "민법 제750조 2항 참고"]) {
      expect(parseLawArticleQuery(query), query).toBeNull();
    }
  });

  it("opens only the one current law with exactly the candidate name", () => {
    const laws = [
      { name: "민법 시행령", status: "현행", mst: "100001" },
      { name: "민법", status: "현행", mst: "284415" },
      { name: "난민법", status: "현행", mst: "188376" },
    ];
    expect(exactCurrentLaw(laws, "민법")?.mst).toBe("284415");
    expect(exactCurrentLaw(laws, "민법이랑 형법")).toBeUndefined();
    expect(exactCurrentLaw([...laws, { name: "민법", status: "현행", lawId: "001706" }], "민법")).toBeUndefined();
  });
});

describe("case number input", () => {
  it("removes spaces only inside each case number and keeps separators", () => {
    for (const value of ["2013다61381", "2013 다61381", "2013다 61381", " 2013 다 61381 "]) expect(normalizeCaseNumber(value)).toBe("2013다61381");
    expect(normalizeCaseNumber("2017 다 360, 2017 다 377")).toBe("2017다360, 2017다377");
    expect(normalizeCaseNumber("2017다360·2017다377")).toBe("2017다360·2017다377");
  });

  it("sends the canonical number and still rejects non case numbers", () => {
    const draft = (caseNumber: string): LawAnalysisDraft => ({ text: "", caseNumber, applicable: { lawName: "", date: "", jo: "" }, impact: { lawName: "", jo: "" } });
    expect(lawAnalysisRequestFor("cite_check", draft("2013 다 61381"))).toEqual({ mode: "cite_check", caseNumber: "2013다61381" });
    expect(lawAnalysisRequestFor("cite_check", draft("손해배상"))).toBeNull();
    expect(LAW_ANALYSIS_CASE_PATTERN.test(normalizeCaseNumber("2017 다 360, 2017 다 377"))).toBe(true);
  });

  it("canonicalizes a decision search only when the whole query is one identifier of that domain", () => {
    expect(decisionSearchQuery("precedent", "2013 다 61381")).toBe("2013다61381");
    expect(decisionSearchQuery("precedent", "손해배상 계약 해제")).toBe("손해배상 계약 해제");
    expect(decisionSearchQuery("precedent", "2013 사건 손해배상")).toBe("2013 사건 손해배상");
    // A 판례 number is not an identifier in a domain with another numbering.
    expect(decisionIdentifier("nlrc", "2013다61381")).toBeNull();
  });
});
