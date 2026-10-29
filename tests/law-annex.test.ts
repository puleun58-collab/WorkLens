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
});
