import { describe, expect, it } from "vitest";
import { groupLawSystemArticles, lawSystemTopSummary } from "@/lib/law-system-display";
import type { TaskEvidenceArticle, TaskEvidenceItem } from "@/lib/task-evidence";

const article = (relation: TaskEvidenceArticle["relation"], jo: string): TaskEvidenceArticle =>
  ({ law: "개인정보 보호법 시행령", jo, title: "위임 조항", relation });
const item = (articles: TaskEvidenceArticle[]): TaskEvidenceItem =>
  ({ label: "시행령", status: "found", articles });

describe("lawSystemTopSummary", () => {
  it("names only directly linked provisions, never a count, and never lists a non-direct provision as linked", () => {
    expect(lawSystemTopSummary(item([article("direct", "제1조")]))).toContain("인용·준용하는 규정 확인");
    expect(lawSystemTopSummary(item([article("direct", "제1조"), article("twoWay", "제5조"), article("unidentified", "제3조")]))).toBe("시행령 제5조\n위임 조항에 관한 사항");
    expect(lawSystemTopSummary(item([article("other", "제2조")]))).toContain("직접 위임관계 미확인");
    expect(lawSystemTopSummary(item([article("related", "제4조")]))).toContain("직접 위임관계 미확인");
    expect(lawSystemTopSummary(item([]))).toContain("직접 위임관계 미확인");
  });

  it("reports the verified parent paragraph and delegated subject without borrowing an unrelated citation", () => {
    const direct = { ...article("twoWay", "제45조"), parentJo: "제38조", parentParagraph: "1", subject: "대리인" };
    expect(lawSystemTopSummary(item([direct, article("citation", "제42조의5")]))).toBe("법 제38조 제1항 → 시행령 제45조\n대리인에 관한 사항");
    expect(lawSystemTopSummary(item([{ ...direct, jo: "제47조", parentParagraph: "3", subject: "수수료·우송료" }]))).toContain("제38조 제3항 → 시행령 제47조\n수수료·우송료에 관한 사항");
    expect(lawSystemTopSummary(item([{ ...direct, subject: "대리인의 범위와 위임장 제출", parentParagraph: "1" }]))).toContain("제45조\n대리인의 범위와 위임장 제출에 관한 사항");
    expect(lawSystemTopSummary(item([{ ...direct, jo: "제47조", parentParagraph: "3", subject: "수수료·우송료" }, direct]))).toMatch(/제1항 → 시행령 제45조[\s\S]*제3항 → 시행령 제47조/u);
  });
});

describe("groupLawSystemArticles", () => {
  it("groups by relation in display order and omits empty groups", () => {
    const groups = groupLawSystemArticles([
      article("related", "제4조"),
      article("other", "제2조"),
      article("direct", "제1조"),
      article("unidentified", "제3조"),
      article("twoWay", "제5조"),
    ]);
    expect(groups.map((group) => group.key)).toEqual(["direct", "citation", "other", "unidentified", "related"]);
    expect(groups[0].articles.map((entry) => entry.jo)).toEqual(["제5조"]);
    expect(groupLawSystemArticles([article("direct", "제1조")]).map((group) => group.key)).toEqual(["citation"]);
    expect(groupLawSystemArticles([])).toEqual([]);
  });
});
