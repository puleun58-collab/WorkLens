import { describe, expect, it } from "vitest";
import { compareOrdinances, parseOrdinanceArticle, parseOrdinanceToc, type OrdinanceSources } from "@/server/ordinance-compare";

// Shapes captured from live search_ordinance / get_ordinance responses (2026-09).
const hit = (id: string, name: string, body: string) => `[${id}] ${name}\n  지자체: ${body}\n  공포일: 20260701\n  시행일: 20260701\n  링크: /DRF/lawService.do?OC=***`;
const head = (name: string, body: string) => `자치법규명: ${name}\n공포일: 20260713\n자치단체: ${body}\n시행일: 20260713\n\n---\n\n`;
const toc = (name: string, body: string, titles: string[]) => `${head(name, body)}목차 (총 ${titles.length}개 조문)\n\n${titles.join("\n")}\n\n특정 조문 조회: get_ordinance(ordinSeq="1", jo="제XX조")`;

/** 인천 has a deleted 제3조 and 제5조의2, so TOC position and article number drift apart. */
const INCHEON_TITLES = ["목적", "적용범위", "주차요금", "주차요금의 감면", "관리위탁", "주차장의 설치기준"];
const INCHEON_NUMBERS: Record<string, string> = { 1: "목적", 2: "적용범위", 4: "주차요금", 5: "주차요금의 감면", 6: "관리위탁", 7: "주차장의 설치기준" };

function sources(): OrdinanceSources & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async search(query) {
      calls.push(`search:${query}`);
      if (query.startsWith("인천광역시")) return `자치법규 검색 결과 (총 3건, 1페이지):\n\n${[
        hit("11", "인천광역시 교통사업 특별회계 설치 조례", "인천광역시"),
        hit("12", "남동구 주차장 설치 및 관리 조례", "인천광역시 남동구"),
        hit("13", "인천광역시 주차장 설치 및 관리 조례", "인천광역시"),
      ].join("\n\n")}`;
      if (query.startsWith("광진구")) return `자치법규 검색 결과 (총 1건, 1페이지):\n\n${hit("21", "서울특별시 광진구 주차장 설치 및 관리 조례", "서울특별시 광진구")}`;
      return "자치법규 검색 결과 (총 0건, 1페이지):";
    },
    async text(id, jo) {
      calls.push(`text:${id}:${jo ?? "toc"}`);
      if (id === "11") return toc("인천광역시 교통사업 특별회계 설치 조례", "인천광역시", ["목적", "특별회계의 설치"]);
      if (id === "12") return toc("남동구 주차장 설치 및 관리 조례", "인천광역시 남동구", ["목적", "주차장의 설치기준"]);
      if (id === "13") {
        if (!jo) return toc("인천광역시 주차장 설치 및 관리 조례", "인천광역시", INCHEON_TITLES);
        const number = /^제(\d+)조$/u.exec(jo)?.[1] ?? "";
        const title = INCHEON_NUMBERS[number];
        return `${head("인천광역시 주차장 설치 및 관리 조례", "인천광역시")}${title ? `${title}\n${jo}(${title}) 인천 본문 ${title}` : `${jo} <삭제 2016-09-26>`}`;
      }
      if (id === "21") {
        // Short ordinances come back as full text with numbered headings instead of a TOC.
        const full = `${head("서울특별시 광진구 주차장 설치 및 관리 조례", "서울특별시 광진구")}목적\n제1조(목적) 목적 본문\n\n주차장의 설치기준\n제3조의2(주차장의 설치기준) 광진 본문 설치기준`;
        return jo ? `${head("서울특별시 광진구 주차장 설치 및 관리 조례", "서울특별시 광진구")}주차장의 설치기준\n제3조의2(주차장의 설치기준) 광진 본문 설치기준` : full;
      }
      return "";
    },
  };
}

describe("ordinance comparison", () => {
  it("picks the region's own on-topic ordinance over an off-topic one of the region or a district's", async () => {
    const result = await compareOrdinances("주차장 설치 기준", ["인천광역시", "광진구"], sources(), "주차장법");
    expect(result.regions.map((region) => region.ordinance?.name)).toEqual(["인천광역시 주차장 설치 및 관리 조례", "서울특별시 광진구 주차장 설치 및 관리 조례"]);
  });

  it("shows only articles whose returned number and title were verified, walking past deleted articles", async () => {
    const result = await compareOrdinances("주차장 설치 기준", ["인천광역시", "광진구"], sources(), "주차장법");
    expect(result.topics).toContain("주차장의 설치기준");
    const [incheon, gwangjin] = result.regions;
    // TOC position 6 → 제6조 is 관리위탁; the walk corrects to 제7조 by where 관리위탁 sits in the TOC.
    expect(incheon.articles).toEqual([{ jo: "제7조", title: "주차장의 설치기준", body: "인천 본문 주차장의 설치기준", topic: "주차장의 설치기준" }]);
    // A full-text reply names 제3조의2 directly; no position guessing.
    expect(gwangjin.articles).toEqual([{ jo: "제3조의2", title: "주차장의 설치기준", body: "광진 본문 설치기준", topic: "주차장의 설치기준" }]);
  });

  it("retains the complete fetched article after 600 characters, including 항 and 호 line breaks", async () => {
    const body = `① 주차요금을 감면한다.\n${"장애인 전용 주차구획의 설치기준은 별표에 따른다. ".repeat(20)}\n② 시설기준은 다음 각 호와 같다.\n1. 출입구에 가깝게 설치한다.`;
    expect(body.length).toBeGreaterThan(600);
    const original = sources();
    const result = await compareOrdinances("주차장 설치 기준", ["인천광역시", "광진구"], {
      ...original,
      async text(id, jo) {
        if (id === "13" && jo === "제7조") return `${head("인천광역시 주차장 설치 및 관리 조례", "인천광역시")}주차장의 설치기준\n제7조(주차장의 설치기준) ${body}`;
        return original.text(id, jo);
      },
    }, "주차장법");
    expect(result.regions[0].articles[0].body).toBe(body);
  });

  it("reports a region with no matching ordinance as none, without inventing one", async () => {
    const result = await compareOrdinances("주차장 설치 기준", ["인천광역시", "가나다시"], sources());
    expect(result.regions[1]).toEqual({ region: "가나다시", status: "none", candidates: 0, articles: [] });
  });

  it("reports a failed lookup as failed, not as absence", async () => {
    const failing = { ...sources(), async search() { throw new Error("down"); } };
    const result = await compareOrdinances("주차장 설치 기준", ["인천광역시", "광진구"], failing);
    expect(result.regions.map((region) => region.status)).toEqual(["failed", "failed"]);
  });
});

describe("ordinance text parsing", () => {
  it("reads numbered headings when there is no table of contents", () => {
    expect(parseOrdinanceToc("목적\n제1조(목적) 본문\n\n복무선서\n제2조(복무선서)① 본문")).toEqual([{ jo: "제1조", title: "목적" }, { jo: "제2조", title: "복무선서" }]);
  });

  it("does not take a deleted article for one with a title", () => {
    expect(parseOrdinanceArticle("---\n\n제17조 <삭제 2016-09-26>")).toBeUndefined();
  });
});
