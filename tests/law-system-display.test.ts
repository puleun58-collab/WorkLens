import { describe, expect, it } from "vitest";
import { groupLawSystemArticles, lawSystemTopSummary } from "@/lib/law-system-display";
import type { TaskEvidenceArticle, TaskEvidenceItem } from "@/lib/task-evidence";

const article = (relation: TaskEvidenceArticle["relation"], jo: string): TaskEvidenceArticle =>
  ({ law: "개인정보 보호법 시행령", jo, title: "위임 조항", relation });
const item = (articles: TaskEvidenceArticle[]): TaskEvidenceItem =>
  ({ label: "시행령", status: "found", articles });

describe("lawSystemTopSummary", () => {
  it("shows relation phrases only, never a provision count", () => {
    expect(lawSystemTopSummary(item([article("direct", "제1조")]))).toBe("직접 위임 확인됨");
    expect(lawSystemTopSummary(item([article("other", "제2조")]))).toBe("추가 확인 필요");
    expect(lawSystemTopSummary(item([article("direct", "제1조"), article("unidentified", "제3조")]))).toBe("직접 위임 확인됨 · 추가 확인 필요");
    expect(lawSystemTopSummary(item([article("related", "제4조")]))).toBe("추가 확인 필요");
    expect(lawSystemTopSummary(item([]))).toBeUndefined();
    for (const summary of [lawSystemTopSummary(item([article("twoWay", "제1조")]))]) {
      expect(summary).not.toContain("건");
    }
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
    expect(groups.map((group) => group.key)).toEqual(["direct", "other", "unidentified", "related"]);
    expect(groups[0].articles.map((entry) => entry.jo)).toEqual(["제1조", "제5조"]);
    expect(groupLawSystemArticles([article("direct", "제1조")]).map((group) => group.key)).toEqual(["direct"]);
    expect(groupLawSystemArticles([])).toEqual([]);
  });
});
