import { describe, expect, it } from "vitest";
import { articleDisplayKey, hasQuestionTermInTitle, needsConfirmationView, taskSourceRole, taskSources, type TaskSource } from "../src/components/research/research-result-display";
import { assessLawSystem } from "../src/lib/law-system-evidence";
import { detailArticles } from "../src/lib/task-evidence";
import { lawSourceUrl } from "../src/lib/research-scope";
import privacy from "./fixtures/law-system-privacy-38.json";

describe("needs_confirmation issue view", () => {
  it("lists distinct unconfirmed requirements and asks only for them", () => {
    expect(needsConfirmationView({ status: "needs_confirmation", unconfirmed: [" 퇴직 여부 ", "퇴직 여부", ""] }))
      .toEqual({ items: ["퇴직 여부"], followUp: "다음 적용 요건에 해당하는 사실을 알려주면 다시 확인할 수 있습니다: 퇴직 여부." });
    expect(needsConfirmationView({ status: "needs_confirmation", followUp: "근무 기간을 알려주세요." }))
      .toEqual({ items: [], followUp: "근무 기간을 알려주세요." });
    expect(needsConfirmationView({ status: "needs_confirmation" })?.followUp).toBe("적용 요건에 해당하는 사실을 질문에 더하면 다시 확인할 수 있습니다.");
  });
  it.each(["found", "none", "failed", "timeout"] as const)("is absent for %s", (status) => {
    expect(needsConfirmationView({ status, unconfirmed: ["x"] })).toBeUndefined();
  });
});

describe("research source presentation", () => {
  const article = { law: "근로기준법", jo: "제23조", excerpt: "① 원문", effective: "2025.01.01" };
  it("links only the same law, article, version and excerpt", () => {
    const key = articleDisplayKey(article);
    expect(articleDisplayKey({ ...article })).toBe(key);
    for (const different of [
      { law: "다른 법률" }, { jo: "제24조" }, { effective: "2026.01.01" },
      { effective: undefined }, { excerpt: "① 다른 발췌" },
    ]) expect(articleDisplayKey({ ...article, ...different })).not.toBe(key);
  });
  it("does not infer title matches from body matches or explicit references", () => {
    const supplement = { law: article.law, jo: article.jo, excerpt: article.excerpt, title: "해고 등의 제한", matched: ["해고"] };
    const before = structuredClone(supplement);
    expect(hasQuestionTermInTitle(supplement)).toBe(true);
    expect(hasQuestionTermInTitle({ ...supplement, matched: ["임금"] })).toBe(false);
    expect(hasQuestionTermInTitle({ ...supplement, matched: [] })).toBe(false);
    expect(hasQuestionTermInTitle({ ...supplement, matched: [""] })).toBe(false);
    expect(hasQuestionTermInTitle({ ...supplement, explicit: true })).toBe(false);
    expect(supplement).toEqual(before);
  });

  it("shares one original across independently assessed basis and conditions without losing either status", () => {
    const source = { law: "식품위생법", jo: "제75조", title: "허가취소 등", excerpt: "① 영업자가 법을 위반한 경우 영업정지를 명할 수 있다.", effective: "20261008",
      source: "https://www.law.go.kr/법령/%EC%8B%9D%ED%92%88%EC%9C%84%EC%83%9D%EB%B2%95/%EC%A0%9C75%EC%A1%B0" };
    const rows = taskSources([
      { label: "처분·허가 근거", status: "found", basisRefs: [{ law: source.law, jo: source.jo, title: source.title, excerpt: source.excerpt }] },
      { label: "적용 요건", status: "viewed", requirementRefs: [{ law: source.law, jo: source.jo, title: source.title, excerpt: source.excerpt }] },
    ], [source, source]);
    expect(rows).toHaveLength(1);
    expect(rows[0].links.map(({ label, status }) => [label, status])).toEqual([["처분·허가 근거", "found"], ["적용 요건", "viewed"]]);
  });

  it("keeps different laws, provisions, versions and sources distinct while combining excerpt ranges", () => {
    const original = { law: "식품위생법", jo: "제75조", excerpt: "① 영업정지", effective: "20261008",
      source: "https://www.law.go.kr/법령/식품위생법/제75조" };
    const rows = taskSources([], [original, { ...original }, { ...original, law: "다른 법" },
      { ...original, jo: "제76조" }, { ...original, effective: "20270901" },
      { ...original, source: "https://other.example/" }, { ...original, excerpt: "② 영업 폐쇄" }]);
    expect(rows).toHaveLength(5);
    expect(rows[0].excerpt).toContain("① 영업정지\n…\n② 영업 폐쇄");
  });

  it("does not mistake a list-only source or a failed read for a confirmed link", () => {
    const rows = taskSources([{ label: "세부 기준(별표)", status: "none" }], [
      { law: "식품위생법 시행규칙", jo: "제89조", excerpt: "별표 23과 같다." },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].links).toEqual([]);
  });

  it("keeps original privacy delegation and citation roles distinct without promoting unrelated retrieved rows", () => {
    const evidence = assessLawSystem(privacy.text, privacy.query);
    const originals = detailArticles(privacy.text).map((article) => ({
      law: article.law, jo: article.jo, title: article.title, excerpt: article.body, source: lawSourceUrl(article.law, article.jo),
    }));
    const rows = taskSources(evidence.items, originals);
    const before = structuredClone(rows);
    const role = (jo: string) => taskSourceRole(rows.find((row) => row.law === "개인정보 보호법 시행령" && row.jo === jo)!,
      [{ law: "개인정보 보호법", jo: "제38조" }], "law_system", privacy.query);
    expect(role("제45조")).toBe("직접 관련 근거");
    expect(role("제47조")).toBe("직접 관련 근거");
    expect(role("제42조의5")).toBe("보충 근거");
    expect(role("제42조의8")).toBe("보충 근거");
    for (const jo of ["제2조", "제3조", "제4조의2", "제9조의3", "제12조", "제13조"]) expect(role(jo)).toBe("추가 조회 자료");
    expect(rows).toEqual(before);
  });

  it("requires an actual asked-parent citation and the matched expression in the displayed original", () => {
    const row: TaskSource = { law: "예시법 시행령", jo: "제9조", excerpt: "법 제8조에 따라 수수료를 정한다.",
      links: [{ label: "시행령", status: "found", role: "직접 위임관계", expression: "법 제8조에 따라" }] };
    const asked = [{ law: "예시법", jo: "제8조" }];
    expect(taskSourceRole(row, asked, "law_system", "")).toBe("직접 관련 근거");
    expect(taskSourceRole({ ...row, excerpt: "수수료를 정한다." }, asked, "law_system", "")).toBe("추가 조회 자료");
    expect(taskSourceRole({ ...row, law: "다른법 시행령" }, asked, "law_system", "")).toBe("추가 조회 자료");
    expect(taskSourceRole({ ...row, links: [{ ...row.links[0], role: "단순 인용·준용" }] }, [], "law_system", "예시법 제8조와 시행령 관계")).toBe("보충 근거");
    for (const role of ["다른 조항 참조", "위임 대상 미확인", "간접 관련"]) {
      expect(taskSourceRole({ ...row, links: [{ ...row.links[0], role }] }, asked, "law_system", "")).toBe("추가 조회 자료");
    }
    expect(taskSourceRole({ ...row, law: "예시법", jo: "제8조", links: [] }, asked, "law_system", "")).toBe("직접 관련 근거");
    expect(taskSourceRole({ ...row, law: "다른법", jo: "제8조", links: [] },
      [...asked, { law: "다른법", jo: "제8조" }], "law_system", "예시법 제8조와 시행령 관계")).toBe("추가 조회 자료");
    expect(taskSourceRole({ ...row, law: "예시법", jo: "제8조", excerpt: "", links: [] },
      asked, "law_system", "예시법 제8조와 시행령 관계")).toBe("추가 조회 자료");
  });

  it("preserves independently confirmed action-basis roles and supporting material", () => {
    const row: TaskSource = { law: "식품위생법", jo: "제75조", excerpt: "영업정지를 명할 수 있다.",
      links: [{ label: "처분 근거", status: "found", role: "법적 근거" }] };
    expect(taskSourceRole(row, [], "action_basis", "")).toBe("직접 관련 근거");
    expect(taskSourceRole({ ...row, links: [{ ...row.links[0], status: "viewed" }] }, [], "action_basis", "")).toBe("보충 근거");
    expect(taskSourceRole({ ...row, links: [] }, [], "action_basis", "")).toBe("추가 조회 자료");
  });
});
