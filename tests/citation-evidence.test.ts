import { describe, expect, it } from "vitest";
import {
  articleEvidence, articleLines, citedHo, currentLawEntry, lawCitationTarget, versionMatchesVerification,
} from "@/lib/citation-evidence";

const ARTICLE_60 = [
  "법령명: 근로기준법",
  "공포일: 20260219",
  "시행일: 20260820",
  "ℹ️ 조회기준일 20260929 — 위 시행일 버전 본문.",
  "",
  "제60조 연차 유급휴가",
  "제60조(연차 유급휴가)",
  "① 사용자는 1년간 80퍼센트 이상 출근한 근로자에게 15일의 유급휴가를 주어야 한다. <개정 2012.2.1>",
  "② 사용자는 계속하여 근로한 기간이 1년 미만인 근로자에게 1개월 개근 시 1일의 유급휴가를 주어야 한다.",
  "⑥ 제1항 및 제2항을 적용하는 경우 다음 각 호의 어느 하나에 해당하는 기간은 출근한 것으로 본다.",
  "1. 근로자가 업무상의 부상 또는 질병으로 휴업한 기간",
  "2. 임신 중의 여성이 제74조제1항부터 제3항까지의 규정에 따른 휴가로 휴업한 기간",
  "3. 「남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률」 제19조에 따른 육아휴직으로 휴업한 기간",
  "⑦ 제1항ㆍ제2항 및 제4항에 따른 휴가는 1년간 행사하지 아니하면 소멸된다.",
  "",
].join("\n");

describe("citation evidence", () => {
  it("keeps only official article lines and drops the endpoint's header and repeated heading", () => {
    const lines = articleLines(ARTICLE_60);
    expect(lines[0]).toBe("제60조(연차 유급휴가)");
    expect(lines.join("\n")).not.toMatch(/법령명:|시행일:|조회기준일/u);
    expect(articleLines("법령명: 민법\n\n제750조 불법행위의 내용\n고의 또는 과실로 인한 위법행위로 타인에게 손해를 가한 자는 그 손해를 배상할 책임이 있다.\n"))
      .toEqual(["제750조 불법행위의 내용", "고의 또는 과실로 인한 위법행위로 타인에게 손해를 가한 자는 그 손해를 배상할 책임이 있다."]);
  });

  it("selects exactly the cited 항 or 호 as whole, unmodified lines", () => {
    const lines = articleLines(ARTICLE_60);
    expect(articleEvidence(lines)).toEqual({ kind: "found", scope: "article", lines });
    expect(articleEvidence(lines, 2)).toEqual({ kind: "found", scope: "hang", lines: [lines[2]] });
    expect(articleEvidence(lines, 6)).toMatchObject({ kind: "found", scope: "hang", lines: lines.slice(3, 7) });
    // A 호 keeps its 항's lead-in line so it is not read out of context.
    expect(articleEvidence(lines, 6, 3)).toEqual({ kind: "found", scope: "ho", lines: [lines[3], lines[6]] });
    expect(articleEvidence(lines, 6, 9)).toMatchObject({ kind: "part-missing", part: "호" });
    expect(articleEvidence(lines, 9)).toMatchObject({ kind: "part-missing", part: "항" });
  });

  it("recovers the 호 the verifier dropped, in input order and without reusing an exact repeat", () => {
    const labels = ["근로기준법 제60조(연차 유급휴가) 제6항", "민법 제750조(불법행위의 내용)", "근로기준법 제60조(연차 유급휴가) 제6항"].map(lawCitationTarget);
    const input = "근로기준법 제60조 제6항 제3호, 같은 조 제6항 제3호와 민법 제750조, 근로기준법 제60조 제6항 제9호";
    expect(citedHo(input, labels)).toEqual([3, undefined, 9]);
    expect(lawCitationTarget("근로기준법 제60조(연차 유급휴가) 제6항")).toEqual({ lawName: "근로기준법", jo: "제60조", title: "연차 유급휴가", hang: 6 });
  });

  it("uses only the one current entry with the exact law name", () => {
    const laws = [
      { name: "민법", status: "현행", mst: "284415" },
      { name: "난민법", status: "현행", mst: "188376" },
      { name: "민법", status: "연혁", mst: "111111" },
    ];
    expect(currentLawEntry(laws, "민법")?.mst).toBe("284415");
    expect(currentLawEntry(laws, "민사소송법")).toBeUndefined();
  });

  it("rejects a version that took effect after the verification day", () => {
    expect(versionMatchesVerification("20260317", "20260929")).toBe(true);
    expect(versionMatchesVerification("20260929", "20260929")).toBe(true);
    expect(versionMatchesVerification("20261001", "20260929")).toBe(false);
  });
});
