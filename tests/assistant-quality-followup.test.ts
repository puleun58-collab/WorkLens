import { describe, expect, it } from "vitest";
import {
  matchesLawArticleCitation,
  resolveFollowUpIntent,
} from "../src/lib/assistant/topics";
import {
  ASSISTANT_EVIDENCE,
  filterEvidenceByIntent,
  LAW_EVIDENCE_IDS,
  selectEvidence,
  splitCitedByKind,
  type AssistantEvidence,
} from "../src/lib/assistant/evidence";
import { buildAssistantMessages } from "../src/lib/assistant/prompt";

function entry(id: string): AssistantEvidence {
  const found = ASSISTANT_EVIDENCE.find((item) => item.id === id);
  if (!found) throw new Error(`missing evidence ${id}`);
  return found;
}

describe("assistant follow-up intent inheritance", () => {
  it("keeps a long marker-less law follow-up on the law topic (live D3 drift case)", () => {
    expect(
      resolveFollowUpIntent(
        "그럼 WorkLens는 무엇을 검증하는데?",
        "법령 MCP에서 가져오면 환각이 없는 것 아니야?",
      ),
    ).toBe("law");
  });
  it("keeps a long marker-less learn follow-up on the learn topic", () => {
    expect(
      resolveFollowUpIntent("그럼 통과 기준은?", "학습센터에서 퀴즈는 어떻게 풀어?"),
    ).toBe("learn");
  });
  it("lets the current question's own markers win over the previous topic", () => {
    expect(
      resolveFollowUpIntent("법령 근거는 어디서 확인해?", "학습센터에서 환각을 설명해 줘"),
    ).toBe("law");
    expect(
      resolveFollowUpIntent("학습센터에서 환각이 무슨 뜻이야?", "법령 MCP 연동돼?"),
    ).toBe("learn");
  });
  it("stays general without a previous question", () => {
    expect(resolveFollowUpIntent("그럼 무엇을 검증하는데?")).toBe("general");
  });
  it("feeds law evidence (not learn evidence) for the long law follow-up", () => {
    const previous = "법령 MCP에서 가져오면 환각이 없는 것 아니야?";
    const question = "그럼 WorkLens는 무엇을 검증하는데?";
    const merged = filterEvidenceByIntent(
      [{
        id: "learn-unit-l6-u5",
        screen: "학습센터",
        title: "결과물 확인과 검증",
        text: "학습 내용",
        keywords: /검증/iu,
        kind: "policy",
      }],
      // Route selects with the concatenated query for marker-less follow-ups.
      selectEvidence(`${previous} ${question}`),
      resolveFollowUpIntent(question, previous),
    );
    expect(merged.some((item) => item.id.startsWith("learn-"))).toBe(false);
    expect(merged.some((item) => item.id === "law-mcp-design")).toBe(true);
  });
});

describe("assistant law article citation pattern", () => {
  it("matches a statute name plus article number", () => {
    expect(matchesLawArticleCitation("민법 제750조의 내용은 뭐야?")).toBe(true);
    expect(matchesLawArticleCitation("근로기준법 제76조의3을 알려줘")).toBe(true);
  });
  it("does not match generic law-function questions", () => {
    expect(matchesLawArticleCitation("법령 MCP 연동돼?")).toBe(false);
    expect(matchesLawArticleCitation("내용 불일치는 무엇을 의미하는가?")).toBe(false);
    expect(matchesLawArticleCitation("법령 근거는 어디서 확인해?")).toBe(false);
  });
});

describe("assistant citation-mismatch and document-review evidence", () => {
  it("selects law evidence for citation-mismatch questions", () => {
    const stat = selectEvidence("내용 불일치는 무엇을 의미하는가?");
    expect(stat.some((item) => item.id === "law-evidence-check")).toBe(true);
    const mismatch = selectEvidence("인용 검증에서 내용 불일치가 나왔는데 왜 그런 거야?");
    expect(mismatch.some((item) => LAW_EVIDENCE_IDS.has(item.id))).toBe(true);
    expect(entry("law-evidence-check").text).toContain("조문 존재 여부와 내용 적합성은 구분합니다");
  });
  it("selects both document-review and document-check evidence for the comparison question", () => {
    const stat = selectEvidence("문서 검토와 검수는 뭐가 달라?");
    expect(stat.some((item) => item.id === "doc-review")).toBe(true);
    expect(stat.some((item) => item.id === "doc-check")).toBe(true);
    expect(entry("doc-review").screen).toBe("법령 > 문서 검토");
    expect(LAW_EVIDENCE_IDS.has("doc-review")).toBe(true);
  });
});

describe("assistant cited-evidence display split", () => {
  it("renders only diagnosis entries as verified evidence", () => {
    const diagnosis: AssistantEvidence = {
      id: "diag-1", screen: "업무 자동화 진단", title: "진단 결과",
      text: "실제 진단 데이터", keywords: /진단/iu, kind: "diagnosis",
    };
    const split = splitCitedByKind([entry("law-mcp-design"), entry("law-research"), diagnosis]);
    expect(split.confirmed.map((item) => item.id)).toEqual(["diag-1"]);
    expect(split.relatedInfo.map((item) => item.id)).toEqual(["law-mcp-design"]);
    expect(split.relatedScreens.map((item) => item.id)).toEqual(["law-research"]);
  });
  it("hides guide entries from every display section", () => {
    const split = splitCitedByKind([entry("ax-flow")]);
    expect(split.confirmed).toEqual([]);
    expect(split.relatedInfo).toEqual([]);
    expect(split.relatedScreens).toEqual([]);
  });
});

describe("assistant previous-answer context", () => {
  it("includes a bounded previous-answer block only when provided", () => {
    const withPrevious = buildAssistantMessages("그럼 WorkLens는 무엇을 검증하는데?", [], undefined, undefined, "법령 MCP에서 가져오면 환각이 없는 것 아니야?", undefined, "법령 MCP를 사용해도 환각이 완전히 없어지지는 않습니다. ".repeat(100));
    const userContent = withPrevious[1].content;
    expect(userContent).toContain("직전 답변 요지");
    const summary = userContent.split("직전 답변 요지")[1];
    expect(summary.length).toBeLessThanOrEqual(700);
    const withoutPrevious = buildAssistantMessages("법령 환각 없어?", []);
    expect(withoutPrevious[1].content).not.toContain("직전 답변 요지");
  });
  it("keeps the new answer-structure and follow-up rules in the system prompt", () => {
    const system = buildAssistantMessages("법령 환각 없어?", [])[0].content;
    expect(system).toContain("결론 → 핵심 이유");
    expect(system).toContain("직전 답변을 반복하지 마세요");
    expect(system).toContain("확인한 근거\"라는 표현은 실제 조회 자료가 있을 때만");
  });
});
