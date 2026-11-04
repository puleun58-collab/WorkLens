import { describe, expect, it } from "vitest";
import { directConditionsSupported, relationshipSupported, researchEvidenceSources, type ResearchEnrichment } from "@/lib/research-relevance";
import { integratedEvidenceStatus } from "@/lib/research-status";

import scopeCapture from "./fixtures/research-live-scope-adoption.json";
import eightCapture from "./fixtures/research-live-eight-adoption.json";
// Official text captured on 2026-11-02, not an invented law/title blacklist.
const procurement = {
  law: "조달사업에 관한 법률 시행령", jo: "제12조", title: "제3자를 위한 단가계약",
  excerpt: "① 법 제12조제1항에 따른 제3자를 위한 단가계약의 계약상대자가 되려는 자는 경쟁입찰의 참가자격을 갖추어야 한다. ③ 계약조건 등의 위반 사실이 있는 등 대통령령으로 정하는 경우란 계약상대자의 계약 관련 부정행위 등에 대한 조사가 진행 중인 경우를 말한다. ④ 조달청장은 제3자를 위한 단가계약을 체결한 경우 그 내용을 수요기관에 통보해야 한다.",
  matched: ["계약", "위반"], stage: "issue" as const,
};
const loan = {
  law: "민법", jo: "제617조", title: "손해배상, 비용상환청구의 기간",
  excerpt: "계약 또는 목적물의 성질에 위반한 사용, 수익으로 인하여 생긴 손해배상의 청구와 차주가 지출한 비용의 상환청구는 대주가 물건의 반환을 받은 날로부터 6월내에 하여야 한다.",
  matched: ["계약", "위반"], stage: "issue" as const,
};
const labor = "직원이 갑자기 무단퇴사해서 연락이 안 됨";

function adopt(article: typeof procurement, issue: string, originalQuery: string) {
  return researchEvidenceSources("", issue, { supplement: { status: "found", articles: [article] } }, undefined, { originalQuery });
}

describe("source relationship versus the original question", () => {
  it("keeps the captured corporate-member scope even if the model quotes only the opening line", () => {
    const { excerpt } = scopeCapture.records[0].review;
    expect(relationshipSupported(excerpt, labor)).toBe(false);
    expect(relationshipSupported(excerpt, "합명회사 사원의 지분과 퇴사 원인")).toBe(true);
    expect(relationshipSupported(excerpt, "합자회사 출자 사원의 퇴사")).toBe(true);
  });

  it("limits aggravated wage remedies without limiting ordinary wages or general civil damages", () => {
    const wage = scopeCapture.records[1];
    expect(directConditionsSupported(wage.review.excerpt, wage.query)).toBe(false);
    expect(directConditionsSupported(wage.review.excerpt, "고의 체불 임금의 손해배상 요건")).toBe(true);
    expect(directConditionsSupported("임금은 통화로 직접 근로자에게 그 전액을 지급하여야 한다.", wage.query)).toBe(true);
    expect(directConditionsSupported("채무자가 채무의 내용에 좇은 이행을 하지 아니한 때에는 채권자는 손해배상을 청구할 수 있다.", labor)).toBe(true);
  });

  it("keeps retirement-benefit statutes and state wage-relief programmes out of direct evidence unless asked", () => {
    const benefit = "근로자퇴직급여 보장법 제15조(퇴직급여 산정) 퇴직금은 계속근로기간 1년에 대하여 30일분 이상의 평균임금으로 한다.";
    expect(directConditionsSupported(benefit, "직원이 갑자기 무단퇴사해서 연락이 안 됨", "근로계약 해지")).toBe(false);
    expect(directConditionsSupported(benefit, "퇴사했는데 퇴직금을 못 받았어", "퇴직금 지급")).toBe(true);
    const relief = "임금채권보장법 제7조의3(체불 임금등 및 생계비 융자) 고용노동부장관은 근로자에게 체불 임금등에 대한 생계비 융자를 할 수 있다.";
    expect(directConditionsSupported(relief, "회사가 이번 달 월급을 주지 않습니다. 요구할 수 있는 조치를 알고 싶습니다.", "임금 청구")).toBe(false);
    expect(directConditionsSupported(relief, "회사가 월급을 안 줘서 생계비 융자를 받을 수 있는지 알고 싶어", "생계비 융자")).toBe(true);
    // A wage rule that merely cites the retirement-benefit statute is not one.
    expect(directConditionsSupported("근로기준법 제43조의8 임금등(「근로자퇴직급여 보장법」 제2조제5호의 급여는 제외한다)을 지급하여야 한다.",
      "고의 체불 임금의 손해배상 요건")).toBe(true);
  });

  it.each([labor, "거래처가 계약을 위반해서 손해를 입었어", "개인정보 유출로 손해배상을 청구하고 싶어"])(
    "does not turn procurement parties into a general contract rule: %s", (query) => {
      expect(adopt(procurement, "계약 위반", query).articles).toEqual([]);
    },
  );

  it("keeps the same procurement provision for a procurement contract", () => {
    expect(adopt(procurement, "계약 위반", "조달청 제3자 단가계약의 계약조건 위반").articles)
      .toEqual([{ law: procurement.law, jo: procurement.jo }]);
  });

  it("rejects the actual loan provision even when the question names 민법", () => {
    expect(adopt(loan, "계약 위반", `민법상 ${labor}`).articles).toEqual([]);
    expect(adopt(loan, "계약 위반", "빌린 물건을 계약에 위반하여 사용한 차주의 책임").articles)
      .toEqual([{ law: "민법", jo: "제617조" }]);
  });

  it("does not promote an AI-invented procurement law into a user fact", () => {
    expect(researchEvidenceSources("", "조달사업에 관한 법률 시행령 계약 위반", {
      supplement: { status: "found", articles: [procurement] },
    }, ["직원", "조달청", "단가계약"], { originalQuery: labor }).articles).toEqual([]);
  });

  it.each([labor, "거래처가 납품을 안 해서 계약상 손해배상을 청구하려고 해"])(
    "keeps general civil nonperformance liability without demanding an employee or vendor noun: %s", (query) => {
      const obligation = { ...loan, jo: "제390조", title: "채무불이행과 손해배상",
        excerpt: "채무자가 채무의 내용에 좇은 이행을 하지 아니한 때에는 채권자는 손해배상을 청구할 수 있다." };
      expect(adopt(obligation, "손해배상 청구", query).articles).toEqual([{ law: "민법", jo: "제390조" }]);
    },
  );

  it("does not use a shared 청구 to turn general civil damages into administrative cancellation evidence", () => {
    const obligation = { ...loan, jo: "제390조", title: "채무불이행과 손해배상",
      excerpt: "채무자가 채무의 내용에 좇은 이행을 하지 아니한 때에는 채권자는 손해배상을 청구할 수 있다." };
    expect(adopt(obligation, "취소 청구", "행정처분 취소 사유를 알고 싶어").articles).toEqual([]);
  });

  it("keeps civil employment termination and wage payment as cross-law evidence", () => {
    const termination = { ...loan, jo: "제660조", title: "기간의 약정이 없는 고용의 해지통고",
      excerpt: "고용기간의 약정이 없는 때에는 당사자는 언제든지 계약해지의 통고를 할 수 있다." };
    expect(adopt(termination, "계약 해지", labor).articles).toEqual([{ law: "민법", jo: "제660조" }]);
    const wage = { ...loan, law: "근로기준법", jo: "제43조", title: "임금 지급",
      excerpt: "임금은 통화로 직접 근로자에게 그 전액을 지급하여야 한다." };
    expect(adopt(wage, "임금 지급", labor).articles).toEqual([{ law: "근로기준법", jo: "제43조" }]);
  });

  it.each([
    ["식품위생법", "제75조", "영업정지", "식품위생법 무신고 영업정지", "무신고 영업에 대하여 영업정지를 명할 수 있다."],
    ["개인정보 보호법", "제39조", "손해배상책임", "개인정보 유출 손해배상", "개인정보처리자가 개인정보를 유출한 경우 손해배상의 책임을 진다."],
  ])("keeps substantive %s evidence", (law, jo, title, query, excerpt) => {
    const article = { ...loan, law, jo, title, excerpt };
    expect(adopt(article, query, query).articles).toEqual([{ law, jo }]);
  });

  it("rejects the actual executive retirement-tax holding but keeps a worker retirement holding", () => {
    const executive = "(1심과 같음) 이 사건 퇴직금이 대표이사에게 실제로 지급된 것이라 보기 어려울뿐만 아니라 임원의 현실적 퇴직으로 인해 지급된 것으로 볼 수 없음";
    const worker = "근로자가 퇴직한 경우 사용자는 퇴직금을 지급하여야 한다.";
    const enrichment: ResearchEnrichment = {
      precedents: { "351400": { rank: "direct", matched: ["퇴직금", "지급"] }, worker: { rank: "direct", matched: ["퇴직금", "지급"] } },
      precedentExcerpts: { "351400": executive, worker },
    };
    const reviews: NonNullable<ResearchEnrichment["adoptionReviews"]> = [];
    expect(researchEvidenceSources("", "퇴직금 지급", enrichment, undefined,
      { originalQuery: labor, review: (review) => reviews.push(review) }).precedents).toEqual(["worker"]);
    expect(reviews[0].precedents).toContainEqual({ id: "351400", excerpt: executive, adopted: false, reason: "party-or-relationship-mismatch" });
    expect(researchEvidenceSources("", "퇴직금 지급", enrichment, undefined,
      { originalQuery: "대표이사 임원의 현실적 퇴직에 따른 퇴직금 지급 과세" }).precedents).toContain("351400");
  });

  it("does not adopt wage-confirmation procedure for damages merely through 청구 and 근로자", () => {
    // Actual post-change failure captured in research-labor-adoption-after.json:
    // the damages issue was none but became found on this unrelated procedure.
    const wageConfirmation = { ...loan, law: "임금채권보장법", jo: "제12조", title: "체불 임금등의 확인",
      excerpt: "① 임금등을 지급받지 못한 근로자는 다음 각 호의 어느 하나에 해당하는 경우 고용노동부장관에게 체불 임금등ㆍ사업주 확인서의 발급을 신청할 수 있다. 1. 제7조제1항제4호ㆍ제5호 또는 제7조의2제1항에 따른 대지급금의 지급 청구 절차를 진행하기 위하여 필요한 경우 2. 「법률구조법」 제22조에 따른 법률구조의 절차 등에 따라 소송 제기를 위하여 필요한 경우" };
    expect(adopt(wageConfirmation, "손해배상 청구", labor).articles).toEqual([]);
    expect(adopt(wageConfirmation, "임금 체불", labor).articles)
      .toEqual([{ law: "임금채권보장법", jo: "제12조" }]);
    expect(researchEvidenceSources("", "손해배상 청구", {
      precedents: { wage: { rank: "direct", matched: ["청구"] } },
      precedentExcerpts: { wage: wageConfirmation.excerpt },
    }, undefined, { originalQuery: labor }).precedents).toEqual([]);
  });

  it("preserves rejected official text, identity, stage and reason", () => {
    const reviews: NonNullable<ResearchEnrichment["adoptionReviews"]> = [];
    researchEvidenceSources("", "계약 위반", { supplement: { status: "found", articles: [loan] } }, undefined,
      { originalQuery: labor, review: (review) => reviews.push(review) });
    expect(reviews[0].articles).toContainEqual({ law: "민법", jo: "제617조", title: loan.title,
      excerpt: loan.excerpt, stage: "issue", adopted: false, reason: "party-or-relationship-mismatch" });
  });

  it("does not let an employee-status phrase bypass an unrelated contract relationship", () => {
    const source = `${procurement.excerpt} 근로자에 해당하는지 여부를 검토한다.`;
    expect(relationshipSupported(source, "직원의 근로자성 확인")).toBe(false);
    expect(relationshipSupported("대표이사가 근로자에 해당하는지 여부를 판단한다.", "직원의 근로자성 확인")).toBe(true);
  });

  it("keeps national and local contracting systems distinct without rejecting general civil rules", () => {
    const national = "국가를 당사자로 하는 계약에 관한 법률에 따른 계약의 해제";
    const local = "지방자치단체를 당사자로 하는 계약에 관한 법률에 따른 계약의 해제";
    expect(relationshipSupported(national, "지자체 계약 해제 요건")).toBe(false);
    expect(relationshipSupported(local, "국가계약 해제 요건")).toBe(false);
    expect(relationshipSupported(national, "국가계약 해제 요건")).toBe(true);
    expect(relationshipSupported(national, "국가기관과 체결한 공사계약의 금액 조정")).toBe(true);
    expect(relationshipSupported(national, "조달 계약 변경 가능 여부")).toBe(false);
    expect(relationshipSupported(local, "지자체 계약 해제 요건")).toBe(true);
    expect(relationshipSupported("당사자 일방이 채무를 이행하지 아니한 때에는 계약을 해제할 수 있다.", "지자체 계약 해제 요건")).toBe(true);
  });

  it("uses the captured replacement provision as a candidate, never as the direct suspension power", () => {
    const capture = eightCapture.results.find((entry) => entry.category === "식품위생")!;
    const replacement = capture.candidates.find((entry) => entry.kind === "article" && entry.jo === "제82조")!;
    const suspension = capture.candidates.find((entry) => entry.kind === "article" && entry.jo === "제75조")!;
    expect(directConditionsSupported(replacement.text, capture.query, "영업정지 요건")).toBe(false);
    expect(directConditionsSupported(replacement.text, "영업정지 갈음 과징금 요건", "과징금 요건")).toBe(true);
    // General sanctions state conditions; the user need not admit a violation.
    expect(directConditionsSupported(suspension.text, capture.query, "영업정지 요건")).toBe(true);
    expect(directConditionsSupported(`${suspension.text}\n${replacement.text}`, capture.query, "영업정지 요건")).toBe(true);
  });

  it("does not use an invented retirement issue to upgrade settlement into ordinary wage evidence", () => {
    const settlement = "사용자는 근로자가 사망 또는 퇴직한 경우에는 그 지급 사유가 발생한 때부터 14일 이내에 임금, 보상금, 그 밖의 모든 금품을 지급하여야 한다.";
    expect(directConditionsSupported(settlement, "월급 미지급", "임금 지급")).toBe(false);
    expect(directConditionsSupported(settlement, "월급 미지급", "퇴직 후 임금 지급")).toBe(false);
    expect(directConditionsSupported(settlement, "퇴사자 임금 미지급", "임금 지급")).toBe(true);
    expect(directConditionsSupported("임금은 매월 1회 이상 일정한 기일을 정하여 지급하여야 한다.", "월급 미지급", "임금 지급")).toBe(true);
  });

  it("separates definitions and exercise methods from substantive duties and termination grounds", () => {
    const definition = '이 법에서 사용하는 용어의 뜻은 다음과 같다. "사용자"란 사업주를 말한다.';
    expect(directConditionsSupported(definition, "사용자 의무", "사용자 의무")).toBe(false);
    expect(directConditionsSupported(definition, "사용자의 뜻", "사용자 정의")).toBe(true);
    expect(directConditionsSupported(`${definition} 사용자는 임금을 지급하여야 한다.`, "사용자 의무", "임금 지급 의무")).toBe(true);
    const exercise = "계약 또는 법률의 규정에 의하여 당사자의 일방이나 쌍방이 해지 또는 해제의 권리가 있는 때에는 그 해지 또는 해제는 상대방에 대한 의사표시로 한다.";
    expect(directConditionsSupported(exercise, "거래처 계약 불이행", "계약 해제 요건")).toBe(false);
    expect(directConditionsSupported(exercise, "해제권 행사 방법", "계약 해제 방법")).toBe(true);
    expect(directConditionsSupported("당사자 일방이 채무를 이행하지 아니한 때에는 상대방은 상당한 기간을 정하여 그 이행을 최고하고 계약을 해제할 수 있다.", "계약 해제 요건")).toBe(true);
  });

  it("does not turn supporting-only or an empty issue set into matched status", () => {
    expect(integratedEvidenceStatus(0, 1, true)).toBe("unverified");
    expect(integratedEvidenceStatus(0, 0, true)).toBe("unverified");
    expect(integratedEvidenceStatus(1, 2, true)).toBe("partial");
    expect(integratedEvidenceStatus(1, 1, true)).toBe("matched");
  });
});
