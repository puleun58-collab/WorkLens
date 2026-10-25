import { describe, expect, it } from "vitest";
import { rereadShownArticles, type EnrichmentSources } from "@/server/research-enrichment";

/**
 * Full text of 근로기준법 제76조의3 as the official lookup returns it: the
 * victim-protection clause lives in ③, past the MCP preview's `③...` cut.
 */
const ARTICLE_76_3 = [
  "제76조의3 직장 내 괴롭힘 발생 시 조치",
  "제76조의3(직장 내 괴롭힘 발생 시 조치)",
  "① 누구든지 직장 내 괴롭힘 발생 사실을 알게 된 경우 그 사실을 사용자에게 신고할 수 있다.",
  "② 사용자는 제1항에 따른 신고를 접수하거나 직장 내 괴롭힘 발생 사실을 인지한 경우에는 지체 없이 당사자 등을 대상으로 그 사실 확인을 위하여 객관적으로 조사를 실시하여야 한다. <개정 2021.4.13>",
  "③ 사용자는 제2항에 따른 조사 기간 동안 직장 내 괴롭힘과 관련하여 피해를 입은 근로자 또는 피해를 입었다고 주장하는 근로자(이하 \"피해근로자등\"이라 한다)를 보호하기 위하여 필요한 경우 해당 피해근로자등에 대하여 근무장소의 변경, 유급휴가 명령 등 적절한 조치를 하여야 한다. 이 경우 사용자는 피해근로자등의 의사에 반하는 조치를 하여서는 아니 된다.",
  "④ 사용자는 제2항에 따른 조사 결과 직장 내 괴롭힘 발생 사실이 확인된 때에는 피해근로자가 요청하면 근무장소의 변경, 배치전환, 유급휴가 명령 등 적절한 조치를 하여야 한다.",
].join("\n");

function stubSources(): EnrichmentSources & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async summary() { return undefined; },
    async laws(query) {
      calls.push(`laws:${query}`);
      return query === "근로기준법" ? [{ name: "근로기준법", mst: "285279" }] : [];
    },
    async toc() { return []; },
    async article(mst, jo) {
      calls.push(`article:${mst}:${jo}`);
      return mst === "285279" && jo === "제76조의3"
        ? { text: ARTICLE_76_3, name: "근로기준법", effectiveDate: "20261008" } : undefined;
    },
    async interpretations() { return []; },
    async precedents() { return []; },
  };
}

const SHOWN = [
  { law: "근로기준법", jo: "제76조의3", title: "직장 내 괴롭힘 발생 시 조치" },
  { law: "근로기준법", jo: "제76조", title: "안전과 보건" },
];

describe("rereadShownArticles", () => {
  it("re-reads only the title-matched shown article and returns its full-text excerpt", async () => {
    const sources = stubSources();
    const articles = await rereadShownArticles(SHOWN, ["직장", "괴롭힘", "피해자", "보호", "조사", "조치"], sources, () => false);
    expect(articles).toHaveLength(1);
    expect(articles[0].law).toBe("근로기준법");
    expect(articles[0].jo).toBe("제76조의3");
    // The excerpt reaches past the preview cut: the protection clause is in it.
    expect(articles[0].excerpt).toContain("보호하기 위하여");
    expect(articles[0].matched).toEqual(expect.arrayContaining(["직장", "괴롭힘", "조치"]));
    expect(sources.calls).toEqual(["laws:근로기준법", "article:285279:제76조의3"]);
  });

  it("skips titles with no issue term, unknown laws and missing articles", async () => {
    const sources = stubSources();
    expect(await rereadShownArticles(
      [{ law: "없는법", jo: "제1조", title: "직장 내 괴롭힘 발생 시 조치" }],
      ["직장", "괴롭힘"], sources, () => false)).toEqual([]);
    expect(await rereadShownArticles(
      [{ law: "근로기준법", jo: "제76조", title: "안전과 보건" }],
      ["직장", "괴롭힘"], sources, () => false)).toEqual([]);
  });

  it("stops at the shared budget and caps the re-read at two articles", async () => {
    const sources = stubSources();
    expect(await rereadShownArticles(SHOWN, ["직장", "괴롭힘"], sources, () => true)).toEqual([]);
    const three = [
      { law: "근로기준법", jo: "제76조의3", title: "직장 내 괴롭힘 발생 시 조치" },
      { law: "근로기준법", jo: "제76조의2", title: "직장 내 괴롭힘의 금지" },
      { law: "근로기준법", jo: "제76조의4", title: "직장 내 괴롭힘 예방 교육" },
    ];
    const callsBefore = sources.calls.length;
    await rereadShownArticles(three, ["직장", "괴롭힘"], sources, () => false);
    expect(sources.calls.slice(callsBefore).filter((call) => call.startsWith("article:"))).toHaveLength(2);
  });
});
