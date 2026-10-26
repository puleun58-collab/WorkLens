import { describe, expect, it } from "vitest";
import { decisionNumberAcceptableForVerification, decisionNumberMatchesDomain } from "@/lib/decision-identifier";
import { parseDecisionEntries, verifyDecisionEntry } from "@/server/decision-mcp";

/**
 * Follow-up trace (2026-10-26): production admin_appeal search for
 * "영업정지" returned found:true with totalCount 1227 but entries [] and
 * excludedCount 20 on pages 1 and 2 — every real record was judged
 * mismatched. Two over-strict rules caused it:
 *  (a) the institution check required 중앙행정심판위원회, while real
 *      records are decided by regional commissions and 국민권익위원회;
 *  (b) the identifier pattern (central zero-padded form only) rejected
 *      real regional number shapes.
 * Both are fixed without touching identifier-query semantics: a loose
 * number is still a keyword search, never an identifier lookup.
 */
const LABELS = new Set(["사건번호", "의결일", "재결청"]);

describe("admin_appeal verification accepts real deciding bodies and number shapes", () => {
  it.each([
    ["2023-01987", "중앙행정심판위원회"],
    ["2013-01262", "경기도행정심판위원회"],
    ["2019-01305", "경기도행정심판위원회"],
    ["2019-00200", "경기도행정심판위원회"],
    ["2017-00585", "서울특별시행정심판위원회"],
    ["2020-00132", "대전광역시행정심판위원회"],
    ["2015-1092", "서울특별시행정심판위원회"],
    ["2014경행심447", "경기도행정심판위원회"],
    ["2015경기행심555", "경기도행정심판위원회"],
    ["2016경기행심158", "경기도행정심판위원회"],
    ["2017경기행심1198", "경기도행정심판위원회"],
    ["2016경기행심339", "경기도행정심판위원회"],
    ["2013경행심1221", "경기도행정심판위원회"],
    ["경행심2013-1221", "국민권익위원회"],
    ["행심 제2012-116호", "국민권익위원회"],
    ["제특행심2012-23", "국민권익위원회"],
    ["제특행심2012-43", "국민권익위원회"],
    ["제특행심2012-07", "제주특별자치도행정심판위원회"],
  ])("keeps %s decided by %s", (caseNumber, institution) => {
    expect(verifyDecisionEntry("admin_appeal",
      { domain: "admin_appeal", id: "1", caseNumber, institution }, LABELS)).not.toBe("mismatched");
  });

  it("still excludes genuinely foreign records", () => {
    // Another domain's observed institution.
    expect(verifyDecisionEntry("admin_appeal",
      { domain: "admin_appeal", id: "1", caseNumber: "2013-01262", institution: "법제처" }, LABELS)).toBe("mismatched");
    expect(verifyDecisionEntry("admin_appeal",
      { domain: "admin_appeal", id: "1", caseNumber: "2013-01262", institution: "공정거래위원회" }, LABELS)).toBe("mismatched");
    // A pipc-shaped number is not an admin_appeal number.
    expect(verifyDecisionEntry("admin_appeal",
      { domain: "admin_appeal", id: "1", caseNumber: "2026-109-013", institution: "경기도행정심판위원회" }, LABELS)).toBe("mismatched");
    // A too-short serial is still not an admin_appeal number.
    expect(verifyDecisionEntry("admin_appeal",
      { domain: "admin_appeal", id: "1", caseNumber: "2024-55", institution: "경기도행정심판위원회" }, LABELS)).toBe("mismatched");
    // A precedent-style label set still excludes.
    expect(verifyDecisionEntry("admin_appeal",
      { domain: "admin_appeal", id: "1", caseNumber: "2024두12345" }, new Set(["사건번호", "선고일"]))).toBe("mismatched");
  });

  it("keeps the central fixture matched", () => {
    expect(verifyDecisionEntry("admin_appeal",
      { domain: "admin_appeal", id: "1", caseNumber: "2023-01987", institution: "중앙행정심판위원회" }, LABELS)).toBe("matched");
  });

  it("keeps a record without a decision date as not_provided, not excluded", () => {
    expect(verifyDecisionEntry("admin_appeal",
      { domain: "admin_appeal", id: "1", caseNumber: "2020-00132", institution: "대전광역시행정심판위원회" },
      new Set(["사건번호", "재결청"]))).toBe("not_provided");
  });
});

describe("decisionNumberAcceptableForVerification", () => {
  it("accepts admin_appeal shapes the identifier pattern does not", () => {
    expect(decisionNumberAcceptableForVerification("admin_appeal", "2015-1092")).toBe(true);
    expect(decisionNumberAcceptableForVerification("admin_appeal", "2014경행심447")).toBe(true);
    expect(decisionNumberAcceptableForVerification("admin_appeal", "경행심2013-1221")).toBe(true);
    expect(decisionNumberAcceptableForVerification("admin_appeal", "행심 제2012-116호")).toBe(true);
    expect(decisionNumberAcceptableForVerification("admin_appeal", "제특행심2012-23")).toBe(true);
    expect(decisionNumberAcceptableForVerification("admin_appeal", "2024-55")).toBe(false);
    expect(decisionNumberAcceptableForVerification("admin_appeal", "2026-109-013")).toBe(false);
  });

  it("does not change identifier-query semantics", () => {
    // A loose number is still a keyword search, never an identifier lookup.
    expect(decisionNumberMatchesDomain("admin_appeal", "2013-1262")).toBe(false);
    expect(decisionNumberMatchesDomain("admin_appeal", "2013-01262")).toBe(true);
    // Other domains delegate unchanged.
    expect(decisionNumberAcceptableForVerification("precedent", "2023두12345")).toBe(true);
    expect(decisionNumberAcceptableForVerification("precedent", "2022헌마1312")).toBe(true);
  });
});

describe("admin_appeal live page reproduction", () => {
  it("keeps every record of the reproduced 영업정지 first page", () => {
    const text = [
      "행정심판례 검색 결과 (총 1227건, 1페이지):",
      "",
      "[269159] 2013-1262 공중위생관리법위반 영업정지처분 취소청구",
      "  사건번호: 2013-01262",
      "  의결일: 2014.01.22",
      "  재결청: 경기도행정심판위원회",
      "",
      "[260135] 2019경기행심○○○ 식품위생법위반 영업정지처분 취소청구",
      "  사건번호: 2019-00200",
      "  의결일: 2019.04.22",
      "  재결청: 경기도행정심판위원회",
      "",
      "[267677] 건강기능식품법위반 영업정지처분 취소청구",
      "  사건번호: 2014경행심447",
      "  의결일: 2014.07.02",
      "  재결청: 경기도행정심판위원회",
      "",
      "[187770] 건강기능식품법 위반 영업정지처분 취소청구",
      "  사건번호: 경행심2013-1221",
      "  의결일: 2014.01.22",
      "  재결청: 국민권익위원회",
      "",
      "[155063] 건강기능식품일반판매업영업정지처분 취소청구",
      "  사건번호: 행심 제2012-116호",
      "  의결일: 2012.05.15",
      "  재결청: 국민권익위원회",
      "",
      "[270649] 건강기능식품일반판매업영업정지처분 취소청구",
      "  사건번호: 2015-1092",
      "  의결일: 2015.11.23",
      "  재결청: 서울특별시행정심판위원회",
      "",
      "[154922] 건설산업기본법 위반업체 영업정지 3월 처분 취소청구",
      "  사건번호: 제특행심2012-23",
      "  의결일: 2012.07.31",
      "  재결청: 국민권익위원회",
    ].join("\n");
    const entries = parseDecisionEntries(text, "admin_appeal");
    expect(entries).toHaveLength(7);
    expect(entries.filter((entry) => entry.typeVerification !== "mismatched")).toHaveLength(7);
  });
});
