import { describe, expect, it } from "vitest";
import { lawAnnexUrl } from "@/lib/research-scope";
import { retrieveAnnexes, type AnnexReader } from "@/server/research-annex";
import type { FollowupArticle } from "@/server/research-followup";

describe("lawAnnexUrl", () => {
  it("builds the official annex/form route with a compacted law name", () => {
    expect(lawAnnexUrl("식품위생법", "별표", "23")).toBe(
      `https://www.law.go.kr/법령별표서식/(${encodeURIComponent("식품위생법")},${encodeURIComponent("별표23")})`);
    expect(lawAnnexUrl("개인정보 보호법", "서식", "30")).toBe(
      `https://www.law.go.kr/법령별표서식/(${encodeURIComponent("개인정보보호법")},${encodeURIComponent("서식30")})`);
  });

  it("yields no link for a malformed number or an empty law", () => {
    expect(lawAnnexUrl("식품위생법", "별표", "23호")).toBeUndefined();
    expect(lawAnnexUrl("식품위생법", "별표", "")).toBeUndefined();
    expect(lawAnnexUrl("  ", "별표", "23")).toBeUndefined();
  });
});

const article = (body: string): FollowupArticle => ({
  law: "식품위생법", jo: "제75조", title: "영업정지", excerpt: body, matched: [], body,
});

describe("retrieveAnnexes", () => {
  it("verifies an annex whose response identity matches and links the shared annex route", async () => {
    const read: AnnexReader = async () => ({
      isError: false,
      text: "식품위생법 - 영업정지 기준표\n[별표23] 영업정지 기준\n파일 형식: 표\n1. 위반 시 영업정지 7일\n",
    });
    const result = await retrieveAnnexes("식품위생법 영업정지 요건", [article("영업정지 처분은 별표 23에 따른다.")], read);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("verified");
    expect(result[0].label).toBe("별표 23");
    expect(result[0].url).toBe(lawAnnexUrl("식품위생법", "별표", "23"));
  });

  it("keeps a mismatched identity as identified, without a link", async () => {
    const read: AnnexReader = async () => ({
      isError: false,
      text: "다른법 - 영업정지 기준표\n[별표23] 영업정지 기준\n파일 형식: 표\n",
    });
    const result = await retrieveAnnexes("식품위생법 영업정지 요건", [article("영업정지 처분은 별표 23에 따른다.")], read);
    expect(result[0].status).toBe("identified");
    expect(result[0].url).toBeUndefined();
  });

  it("reports not-found and failed distinctly", async () => {
    const notFound: AnnexReader = async () => ({ isError: false, text: "[NOT_FOUND] 없음" });
    expect((await retrieveAnnexes("식품위생법 영업정지 요건", [article("영업정지 처분은 별표 23에 따른다.")], notFound))[0].status).toBe("not-found");
    const failed: AnnexReader = async () => { throw new Error("down"); };
    expect((await retrieveAnnexes("식품위생법 영업정지 요건", [article("영업정지 처분은 별표 23에 따른다.")], failed))[0].status).toBe("failed");
  });

  it("retains a partial original separately from a genuinely absent original", async () => {
    const text = "식품위생법 - 영업정지 기준표\n[별표23] 영업정지 기준\n파일 형식: 표\n1. 위반 시 영업정지 7일\n일부만 표시";
    const partial = await retrieveAnnexes("식품위생법 영업정지 요건", [article("영업정지 처분은 별표 23에 따른다.")],
      async () => ({ isError: false, text }));
    expect(partial[0]).toMatchObject({ status: "identified", text, truncated: true });
    expect(partial[0].url).toBe(lawAnnexUrl("식품위생법", "별표", "23"));
    const missing = await retrieveAnnexes("식품위생법 영업정지 요건", [article("영업정지 처분은 별표 23에 따른다.")],
      async () => ({ isError: false, text: "[NOT_FOUND] 원문 없음" }));
    expect(missing[0].status).toBe("not-found");
    expect(missing[0].text).toBeUndefined();
  });

  it.each(["[별표2]", "[별표999]", "별표 번호 없음"])("does not verify a response with missing or mismatched identity: %s", async (label) => {
    const result = await retrieveAnnexes("식품위생법 영업정지 요건", [article("영업정지 처분은 별표 23에 따른다.")],
      async () => ({ isError: false, text: `식품위생법 - 영업정지 기준표\n${label}\n파일 형식: 표\n영업정지 7일` }));
    expect(result[0].status).toBe("identified");
    expect(result[0].text).toBeUndefined();
    expect(result[0].url).toBeUndefined();
  });

  it("does not verify a response containing only matching identity and metadata", async () => {
    const result = await retrieveAnnexes("식품위생법 영업정지 요건", [article("영업정지 처분은 별표 23에 따른다.")],
      async () => ({ isError: false, text: "식품위생법 - 영업정지 기준표\n[별표23] 영업정지 기준\n파일 형식: HWP\n" }));
    expect(result[0].status).toBe("identified");
    expect(result[0].text).toBeUndefined();
  });

  it("keeps the real disposition table as related when an explicitly requested number differs", async () => {
    const reads: string[] = [];
    const result = await retrieveAnnexes("식품위생법 영업정지 별표 999 기준", [article("행정처분의 기준은 별표 23과 같다.")],
      async (_law, number) => {
        reads.push(number);
        return { isError: false, text: "식품위생법 - 영업정지 기준표\n[별표23] 영업정지 기준\n파일 형식: HWP\n영업정지 7일" };
      }, "action_basis");
    expect(reads).toEqual(["23"]);
    expect(result[0]).toMatchObject({ label: "별표 23", status: "verified", relevance: "related" });
  });

  it("does not prefix-match a requested annex number", async () => {
    const result = await retrieveAnnexes("식품위생법 영업정지 별표 2 기준", [article("행정처분의 기준은 별표 23과 같다.")],
      async () => ({ isError: false, text: "식품위생법 - 영업정지 기준표\n[별표23] 영업정지 기준\n파일 형식: HWP\n영업정지 7일" }), "action_basis");
    expect(result[0].relevance).toBe("related");
  });

  it("keeps a named permit annex direct without fetching unrelated disposition tables", async () => {
    const reads: string[] = [];
    const result = await retrieveAnnexes("건축법 건축허가 별표 1 기준", [{
      law: "건축법 시행규칙", jo: "제6조", title: "건축허가", matched: [],
      excerpt: "건축허가 기준은 별표 1과 같다.", body: "건축허가 기준은 별표 1과 같다.",
    }], async (law, number) => {
      reads.push(`${law} ${number}`);
      return { isError: false, text: `${law} - 허가 기준\n[별표1]\n파일 형식: HWP\n허가 요건을 충족하여야 한다.` };
    }, "action_basis");
    expect(reads).toEqual(["건축법 시행규칙 1"]);
    expect(result[0]).toMatchObject({ law: "건축법 시행규칙", status: "verified", relevance: "direct" });
  });
});
