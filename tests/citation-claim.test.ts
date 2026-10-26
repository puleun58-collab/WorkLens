import { describe, expect, it } from "vitest";
import { assessClaimSupport, extractClaimTerms } from "@/lib/citation-claim";
import { citationCounts } from "@/lib/law-analysis-parse";
import { questionSubjectTerms, questionTerms, researchEvidenceSources } from "@/lib/research-relevance";

/**
 * Claim support is judged from the article text actually fetched, never from
 * the verifier's existence marker: 민법 제75조 exists, but it does not
 * support a damages claim, and no case-specific conclusion follows from an
 * article alone. These are general rules, not per-article exceptions — the
 * same verdicts must hold for any other article/claim pair of the same shape.
 */
const ART_75 = "제75조(총회의 결의방법) ① 총회의 결의는 법령 또는 정관에 다른 정함이 없으면 출석한 사원의 과반수로써 한다.";
const ART_750 = "제750조(불법행위의 내용) 고의 또는 과실로 인한 위법행위로 타인에게 손해를 가한 자는 그 손해를 배상할 책임이 있다.";
const ART_311 = "제311조(모욕) 공연히 사람을 모욕한 자는 1년 이하의 징역이나 금고 또는 200만원 이하의 벌금에 처한다.";

describe("extractClaimTerms", () => {
  it("keeps the legal assertion and drops the citation and scaffolding", () => {
    expect(extractClaimTerms("민법 제75조에 따라 손해배상을 청구할 수 있다.", "민법")).toEqual(["손해배상", "청구"]);
    expect(extractClaimTerms("형법 제311조에 따라 절도를 하면 처벌된다.", "형법")).toEqual(["절도", "처벌"]);
  });
});

describe("assessClaimSupport", () => {
  it("CASE B: an existing article that does not support the claim is a mismatch, not a confirmation", () => {
    expect(assessClaimSupport(
      "민법 제75조에 따라 손해배상을 청구할 수 있다.", "민법", "총회의 결의방법", ART_75,
    )).toEqual({
      verdict: "mismatch",
      reason: "조문은 존재하지만, 입력한 법적 주장과 조문 내용(총회의 결의방법)이 맞지 않습니다.",
    });
  });
  it("CASE A: the correct article for the stated proposition stays supported, including split compounds", () => {
    expect(assessClaimSupport(
      "민법 제750조에 따라 고의 또는 과실로 인한 위법행위로 타인에게 손해를 가한 자는 손해배상책임이 있다.",
      "민법", "불법행위의 내용", ART_750,
    ).verdict).toBe("supported");
    // The article states the proposition with the compound split (손해를 … 배상할):
    // "손해배상을 청구할 수 있다" is still supported by 제750조.
    expect(assessClaimSupport(
      "민법 제750조에 따라 손해배상을 청구할 수 있다.", "민법", "불법행위의 내용", ART_750,
    ).verdict).toBe("supported");
  });
  it("CASE D: the right article with an effect it does not provide is a mismatch", () => {
    expect(assessClaimSupport(
      "민법 제750조에 따라 계약을 해제할 수 있다.", "민법", "불법행위의 내용", ART_750,
    ).verdict).toBe("mismatch");
  });
  it("general rule: the same shape holds for other articles, not only 민법 제75조", () => {
    expect(assessClaimSupport(
      "형법 제311조에 따라 공연히 사람을 모욕하면 처벌된다.", "형법", "모욕", ART_311,
    ).verdict).toBe("supported");
    expect(assessClaimSupport(
      "형법 제311조에 따라 절도를 하면 처벌된다.", "형법", "모욕", ART_311,
    ).verdict).toBe("mismatch");
  });
  it("CASE F: a conclusion about a specific case is capped at unverified, never supported by the article alone", () => {
    expect(assessClaimSupport(
      "이 사건에서 피고는 민법 제750조에 따라 손해배상책임이 있다.", "민법", "불법행위의 내용", ART_750,
    )).toEqual({
      verdict: "unverified",
      reason: "구체적인 사실관계가 필요한 결론은 조문만으로 확인되지 않습니다.",
    });
  });
  it("a title overlap without anchored support is unverified, not a mismatch", () => {
    expect(assessClaimSupport(
      "민법 제750조에 따라 불법행위자의 주소를 확인한다.", "민법", "불법행위의 내용", ART_750,
    )).toEqual({
      verdict: "unverified",
      reason: "입력한 주장과 조문 내용의 직접 관련성을 확인하지 못했습니다.",
    });
  });
  it("no extractable claim is unverified, not supported", () => {
    expect(assessClaimSupport("민법 제750조", "민법", "불법행위의 내용", ART_750).verdict).toBe("unverified");
  });
});

describe("citationCounts with the claim-support label", () => {
  it("counts 직접 근거 미확인 after 내용 불일치 without disturbing existing labels", () => {
    expect(citationCounts([
      { label: "확인됨" }, { label: "내용 불일치" }, { label: "직접 근거 미확인" }, { label: "찾을 수 없음" },
    ])).toEqual(["확인 1건", "찾을 수 없음 1건", "내용 불일치 1건", "직접 근거 미확인 1건"]);
  });
});

const CASE3_QUESTION = "근로기준법 제76조의3에 따른 직장 내 괴롭힘 발생 시 사용자의 조사 의무, 피해자 보호 조치, 행위자 조치 의무를 각각 확인해 줘.";
const CASE3_CHAIN = [
  "═══ 종합 리서치: 조사 의무 ═══", "",
  "▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 10건):", "",
  "10·29이태원참사 진상규명과 재발방지를 위한 특별법",
  "   제0028조 (조사의 방법)",
  "   제28조(조사의 방법)",
  " ① 위원회는 제1항에 따른 조사를 실시할 수 있다.",
  "   시행: 2024.01.01 | 국무조정실", "",
  "근로기준법",
  "   제0076조의3 (직장 내 괴롭힘 발생 시 조치)",
  "   제76조의3(직장 내 괴롭힘 발생 시 조치)",
  " ② 사용자는 제1항에 따른 신고를 접수하거나 직장 내 괴롭힘 발생 사실을 인지한 경우에는 지체 없이 당사자 등을 대상으로 그 사실 확인을 위하여 객관적으로 조사를 실시하여야 한다.",
  "   시행: 2026.10.08 | 고용노동부", "",
].join("\n");

describe("rule (B) subject hygiene for subject-less issues", () => {
  it("sentence scaffolding (따른·각각·확인해) is not a request subject", () => {
    const subjects = questionSubjectTerms(CASE3_QUESTION);
    expect(subjects).not.toContain("따른");
    expect(subjects).not.toContain("각각");
    expect(subjects).not.toContain("확인해");
    expect(subjects).toContain("직장");
    expect(subjects).toContain("괴롭힘");
    expect(questionTerms(CASE3_QUESTION)).toContain("따른");
  });
  it("CASE 3: a subject-less issue no longer adopts an unrelated regime's provision via 따른", () => {
    const requestTerms = questionTerms(CASE3_QUESTION);
    const adopted = researchEvidenceSources(CASE3_CHAIN, "조사 의무", undefined, requestTerms).articles;
    expect(adopted).toEqual([{ law: "근로기준법", jo: "제76조의3" }]);
  });
});
