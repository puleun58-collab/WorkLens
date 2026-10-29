import { describe, expect, it } from "vitest";
import { assessLawSystem } from "@/lib/law-system-evidence";
import { researchEvidenceSources, splitActionMatches, type SupplementArticle } from "@/lib/research-relevance";
import { retrieveAnnexes, type AnnexReader } from "@/server/research-annex";
import type { EnrichmentSources } from "@/server/research-enrichment";
import { retrieveResearchFollowup } from "@/server/research-followup";

/**
 * Round 2 (PR #347 gates A/D + PART B/C): smallest general fixes, no
 * article, annex or tier hard-coded. Every positive case has a negative
 * case beside it. Fixture excerpts are captured texts or minimal
 * synthetic texts in the same shape, never inventions about the law.
 */

// Captured D-1 supplement first sentence, verbatim: the qualifier in
// parentheses carries its own period before the operative grant.
const ARTICLE_75_PAREN =
  "① 식품의약품안전처장 또는 특별자치시장ㆍ특별자치도지사ㆍ시장ㆍ군수ㆍ구청장은 영업자가 다음 각 호의 어느 하나에 해당하는 경우에는 " +
  "대통령령으로 정하는 바에 따라 영업허가 또는 등록을 취소하거나 6개월 이내의 기간을 정하여 그 영업의 전부 또는 일부를 정지하거나 " +
  "영업소 폐쇄(제37조제4항에 따라 신고한 영업만 해당한다. 이하 이 조에서 같다)를 명할 수 있다.";

const art = (overrides: Partial<SupplementArticle> = {}): SupplementArticle => ({
  law: "식품위생법", jo: "제75조", title: "허가취소 등", excerpt: ARTICLE_75_PAREN, matched: [], ...overrides,
});

function baseSources(overrides: Partial<EnrichmentSources> = {}): EnrichmentSources {
  return {
    async summary() { return undefined; },
    async laws() { return []; },
    async toc() { return []; },
    async article() { return undefined; },
    async interpretations() { return []; },
    async precedents() { return []; },
    ...overrides,
  };
}

describe("round 2 §A: parenthesis-aware sentence boundaries", () => {
  it("adopts the real parenthesised 제75조 sentence for 영업정지 요건", () => {
    expect(splitActionMatches("영업정지", ARTICLE_75_PAREN)).toBe(true);
    const adopted = researchEvidenceSources("", "영업정지 요건", {
      supplement: { status: "found", articles: [art()] },
    }, ["식품위생법"]);
    expect(adopted.articles).toEqual([{ law: "식품위생법", jo: "제75조" }]);
  });

  it("still adopts a split act with no parentheses (baseline unchanged)", () => {
    const excerpt = "그 영업의 전부 또는 일부를 정지하거나 영업소 폐쇄를 명할 수 있다.";
    expect(splitActionMatches("영업정지", excerpt)).toBe(true);
  });

  it("rejects authority wording that lives only inside parentheses", () => {
    const excerpt = "그 영업의 전부 또는 일부를 정지하거나 영업소 폐쇄(명할 수 있다. 이하 생략)를 검토한다.";
    expect(splitActionMatches("영업정지", excerpt)).toBe(false);
  });

  it("still rejects halves scattered across sentences", () => {
    const excerpt = "영업자는 신고를 할 수 있다. 위반 시 정지를 명할 수 있다.";
    expect(splitActionMatches("영업정지", excerpt)).toBe(false);
  });
});

describe("round 2 §B: situation-word stems in adoption", () => {
  const pay = (overrides: Partial<SupplementArticle> = {}): SupplementArticle => ({
    law: "근로자퇴직급여 보장법", jo: "제9조", title: "퇴직금의 지급 등",
    excerpt: "사용자는 근로자가 퇴직한 경우에는 그 지급사유가 발생한 날부터 14일 이내에 퇴직금을 지급하여야 한다.",
    matched: [], ...overrides,
  });
  const severance = (query: string, articles: SupplementArticle[]) =>
    researchEvidenceSources("", query, { supplement: { status: "found", articles } });

  it("adopts payment provisions for a non-payment issue through the stem", () => {
    expect(severance("퇴직금 미지급", [pay()]).articles).toEqual([{ law: "근로자퇴직급여 보장법", jo: "제9조" }]);
  });

  it("rejects a severance excerpt with no payment wording for the same issue", () => {
    const setup = pay({ title: "퇴직금제도의 설정",
      excerpt: "사용자는 퇴직금제도를 설정하여야 한다. 퇴직금제도의 설정에 관한 사항은 다음과 같다." });
    expect(severance("퇴직금 미지급", [setup]).articles).toEqual([]);
  });

  it("rejects a payment excerpt with no severance subject for the same issue", () => {
    const wages = pay({ law: "근로기준법", jo: "제43조", title: "임금의 지급",
      excerpt: "사용자는 근로자에게 임금을 매월 1회 이상 지급하여야 한다." });
    expect(severance("퇴직금 미지급", [wages]).articles).toEqual([]);
  });

  it("rejects a bare situation word with no full subject match", () => {
    expect(severance("미지급", [pay()]).articles).toEqual([]);
  });
});

describe("round 2 §A: annex original preservation", () => {
  const candidate = { law: "식품위생법 시행규칙", jo: "제89조", title: "행정처분의 기준",
    excerpt: "법 제74조부터 법 제76조까지의 규정에 따른 행정처분의 기준은 별표 23과 같다.",
    matched: [], body: "법 제74조부터 법 제76조까지의 규정에 따른 행정처분의 기준은 별표 23과 같다." };
  const readWith = (text: string): AnnexReader => async () => ({ isError: false, text });

  it("verifies a complete 43,981-character table instead of cutting it", async () => {
    const head = "식품위생법 시행규칙 - 행정처분 기준(제89조 관련)\n[별표 23]\n파일 형식: HWP\n";
    const text = head + "x".repeat(43_981 - head.length);
    const result = await retrieveAnnexes("식품위생법 영업정지 요건", [candidate], readWith(text));
    expect(result[0].status).toBe("verified");
    expect(result[0].text?.length).toBe(43_981);
    expect(result[0].truncated).toBeUndefined();
  });

  it("keeps an omission-marked response identified even under the new cap", async () => {
    const text = "식품위생법 시행규칙 - 행정처분 기준(제89조 관련)\n[별표 23]\n파일 형식: HWP\n일부만 표시된 표\n";
    const result = await retrieveAnnexes("식품위생법 영업정지 요건", [candidate], readWith(text));
    expect(result[0].status).toBe("identified");
    expect(result[0].truncated).toBe(true);
  });

  it("keeps an over-cap response identified, never verified on a partial text", async () => {
    const head = "식품위생법 시행규칙 - 행정처분 기준(제89조 관련)\n[별표 23]\n파일 형식: HWP\n";
    const text = head + "x".repeat(200_001 - head.length);
    const result = await retrieveAnnexes("식품위생법 영업정지 요건", [candidate], readWith(text));
    expect(result[0].status).toBe("identified");
    expect(result[0].text?.length).toBe(200_000);
  });
});

describe("round 2 §B: law-system counts, wording and membership", () => {
  const systemText = (core: string, blocks: string) => `═══ 법체계 확인: 개인정보 보호법 ═══\n법령명: 개인정보 보호법\n\n▶ 3단 비교 (법률·시행령·시행규칙)\n${blocks}\n▶ 핵심 조문\n개인정보 보호법\n${core}\n`;
  const decree = (jo: string, title: string, body: string) => `[시행령] 개인정보 보호법 시행령 ${jo} (${title})\n${body}\n`;
  const question = "개인정보보호법 제38조와 시행령의 관계";
  const coreTwoWay = "제38조 권리행사의 방법 및 절차\n개인정보처리자는 대통령령으로 정하는 바에 따라 수수료를 청구할 수 있다.";
  const blocks = decree("제45조", "대리인의 범위 등", "법 제38조에 따라 대리인의 범위를 정한다.")
    + decree("제13조", "자료제출 요구 등의 범위와 방법", "법 제11조에 따라 자료제출을 요구할 수 있다.")
    + decree("제2조", "공공기관의 범위", "대통령령으로 정하는 기관이란 다음 각 호의 기관을 말한다.")
    + decree("제12조", "시행계획의 수립절차 등", "보호위원회는 매년 6월 30일까지 시행계획을 마련한다.");

  it("counts unique provisions, names subsets as subsets, and lists membership", () => {
    const result = assessLawSystem(systemText(coreTwoWay, blocks), question);
    const item = result.items.find((entry) => entry.label === "시행령")!;
    expect(item.status).toBe("found");
    expect(item.detail).toBe(
      "시행령 4건 · 그 중 법률에서 위임한 사항 확인 1건 · 그 중 위임 관련 표현 발견 1건(질문한 조항과 참조 조항이 다름) · 그 중 위임 대상 조항 확인 필요 1건");
    expect(item.detail).not.toContain("상세 형식 헤더 기준");
    expect(item.detail).not.toContain("위임 문구 포함");
    expect(item.detail).not.toContain("직접 위임 아님");
    expect(item.detail).not.toContain("접두사 없는 위임 문언");
    expect(item.articles?.map((a) => `${a.jo}:${a.relation}`)).toEqual(
      ["제45조:twoWay", "제13조:other", "제2조:unidentified", "제12조:related"]);
    expect(item.articles?.[0].expression).toContain("법 제38조에 따라");
    expect(result.status).toBe("partial");
  });

  it("counts a duplicated detail header once", () => {
    const doubled = blocks + decree("제45조", "대리인의 범위 등", "법 제38조에 따라 대리인의 범위를 정한다.");
    const result = assessLawSystem(systemText(coreTwoWay, doubled), question);
    const item = result.items.find((entry) => entry.label === "시행령")!;
    expect(item.detail).toContain("시행령 4건");
    expect(item.articles).toHaveLength(4);
  });

  it("distinguishes citation-only direct links from two-way-confirmed ones", () => {
    const coreCitationOnly = "제38조 권리행사의 방법 및 절차\n정보주체는 대리인에게 하게 할 수 있다.";
    const result = assessLawSystem(systemText(coreCitationOnly, blocks), question);
    const item = result.items.find((entry) => entry.label === "시행령")!;
    expect(item.detail).toContain("그 중 질문한 조항 인용 확인 1건");
    expect(item.detail).not.toContain("법률에서 위임한 사항 확인");
    expect(item.articles?.[0].relation).toBe("direct");
  });

  it("states the unconfirmed relation instead of asserting absence", () => {
    const noDirect = blocks.replace(
      decree("제45조", "대리인의 범위 등", "법 제38조에 따라 대리인의 범위를 정한다."), "");
    const result = assessLawSystem(systemText(coreTwoWay, noDirect), question);
    const item = result.items.find((entry) => entry.label === "시행령")!;
    expect(item.status).toBe("viewed");
    expect(item.detail).toContain("위임 관계 확인 필요");
    expect(item.detail).toContain("그 중 위임 관련 표현 발견 1건");
  });

  it("does not count a truncation marker line as an unprefixed delegation phrase", () => {
    const markerOnly = decree("제45조", "대리인의 범위 등", "(위임 내용 120자 중 일부만 표시)");
    const result = assessLawSystem(systemText(coreTwoWay, markerOnly), question);
    const item = result.items.find((entry) => entry.label === "시행령")!;
    expect(item.detail).toContain("시행령 1건");
    expect(item.detail).not.toContain("위임 대상 조항 확인 필요");
    expect(item.articles?.[0].relation).toBe("related");
  });
});

describe("round 2 §A: law-system second-pass tier reads", () => {
  const parentBody = "제38조(권리행사의 방법 및 절차)\n① 정보주체는 열람, 정정, 삭제, 처리정지, 수집에 관한 권리를 방법ㆍ절차에 따라 대리인에게 하게 할 수 있다. ③ 개인정보처리자는 대통령령으로 정하는 바에 따라 수수료와 우송료를 청구할 수 있다.";
  const tocTitles: Array<{ jo: string; title: string }> = [
    { jo: "제60조", title: "처리정지의 방법" },
    { jo: "제61조", title: "처리정지의 수수료" },
    { jo: "제62조", title: "수집의 삭제" },
    { jo: "제63조", title: "처리정지의 우송료" },
    { jo: "제64조", title: "수집의 정정" },
    { jo: "제65조", title: "삭제의 정정" },
    { jo: "제45조", title: "대리인의 범위 등" },
    { jo: "제46조", title: "대리인의 확인" },
  ];
  const decreeBody = (jo: string, cites38: boolean) =>
    `${jo}(제목)\n${cites38 ? "법 제38조에 따라 대리인의 범위를 정한다." : "법 제35조에 따라 확인 방법을 정한다."}`;
  function sources() {
    let articleCalls = 0;
    const s = baseSources({
      async laws(query) {
        if (query === "개인정보보호법") return [{ name: "개인정보 보호법", mst: "P" }];
        if (query === "개인정보 보호법 시행령") return [{ name: "개인정보 보호법 시행령", mst: "D" }];
        return [];
      },
      async toc(mst) { return mst === "D" ? tocTitles : []; },
      async article(mst, jo) {
        articleCalls++;
        if (mst === "P" && jo === "제38조") return { text: parentBody };
        if (mst === "D") {
          const found = tocTitles.find((entry) => entry.jo === jo);
          if (found) return { text: decreeBody(jo, jo === "제45조") };
        }
        return undefined;
      },
    });
    return { sources: s, calls: () => articleCalls };
  }
  const query = "개인정보보호법 제38조와 시행령의 관계";

  it("finds a seventh-ranked citing article through the second pass", async () => {
    const { sources: s, calls } = sources();
    const followup = await retrieveResearchFollowup("law_system", query, "", undefined, s);
    expect(followup.articles.map((a) => `${a.law} ${a.jo}`)).toContain("개인정보 보호법 시행령 제45조");
    expect(followup.articles.map((a) => `${a.law} ${a.jo}`)).not.toContain("개인정보 보호법 시행령 제46조");
    expect(followup.report.limited).toBe(false);
    expect(calls()).toBe(9);
  });

  it("keeps the first pass only for other modes (scope of the second pass)", async () => {
    const { sources: s } = sources();
    const followup = await retrieveResearchFollowup("action_basis", query, "", undefined, s);
    expect(followup.articles.map((a) => `${a.law} ${a.jo}`)).not.toContain("개인정보 보호법 시행령 제45조");
  });
});
