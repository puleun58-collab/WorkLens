import { describe, expect, it } from "vitest";
import {
  clarifyOptions,
  clarifyResponse,
  classifyEvidenceIntent,
  classifyQuestion,
} from "../src/lib/assistant/topics";
import {
  ASSISTANT_EVIDENCE,
  filterEvidenceByIntent,
  LAW_EVIDENCE_IDS,
  selectEvidence,
  stripInternalEvidenceIds,
  type AssistantEvidence,
} from "../src/lib/assistant/evidence";
import { buildAssistantMessages } from "../src/lib/assistant/prompt";

function entry(id: string): AssistantEvidence {
  const found = ASSISTANT_EVIDENCE.find((item) => item.id === id);
  if (!found) throw new Error(`missing evidence ${id}`);
  return found;
}

/** Learn-unit evidence is generated at runtime, so build it directly for tests. */
function learnEntry(id: string): AssistantEvidence {
  return {
    id,
    screen: "학습센터",
    title: "생성형 AI와 대화형 AI",
    text: "생성형 AI는 학습한 패턴을 바탕으로 새로운 문장을 생성합니다.",
    keywords: /환각/iu,
    kind: "policy",
  };
}

describe("assistant evidence intent", () => {
  it("classifies law-function questions as law", () => {
    expect(classifyEvidenceIntent("법령 환각 없어?")).toBe("law");
    expect(classifyEvidenceIntent("법령 MCP 연동인데 환각이 있을 수가 없잖아?")).toBe("law");
    expect(classifyEvidenceIntent("법령 근거는 어디서 확인해?")).toBe("law");
    expect(classifyEvidenceIntent("판례는 실제 자료야?")).toBe("law");
    expect(classifyEvidenceIntent("WorkLens 법령 카테고리에서는 어떻게 방지해?")).toBe("law");
  });
  it("classifies curriculum questions as learn", () => {
    expect(classifyEvidenceIntent("학습센터에서 환각이 무슨 뜻이야?")).toBe("learn");
    expect(classifyEvidenceIntent("생성형 AI 환각이 뭐야?")).toBe("general");
    expect(classifyEvidenceIntent("학습센터 퀴즈는 어떻게 풀어?")).toBe("learn");
  });
  it("keeps unrelated questions general", () => {
    expect(classifyEvidenceIntent("Level은 어떻게 결정되나요?")).toBe("general");
    expect(classifyEvidenceIntent("올인원 지시문은 어디 있어?")).toBe("general");
  });
});

describe("assistant evidence intent filtering", () => {
  it("drops learn evidence for law questions and orders law evidence first", () => {
    const learn = [learnEntry("learn-unit-l1-u2")];
    const stat = selectEvidence("법령 환각 없어?");
    expect(stat.some((item) => LAW_EVIDENCE_IDS.has(item.id))).toBe(true);
    const merged = filterEvidenceByIntent(learn, stat, "law");
    expect(merged.some((item) => item.id.startsWith("learn-"))).toBe(false);
    expect(merged.length).toBeGreaterThan(0);
    expect(LAW_EVIDENCE_IDS.has(merged[0].id)).toBe(true);
  });
  it("drops law evidence for learn questions", () => {
    const learn = [learnEntry("learn-unit-l1-u2")];
    const stat = selectEvidence("학습센터에서 법령 단원을 설명해 줘");
    const merged = filterEvidenceByIntent(learn, stat, "learn");
    expect(merged.some((item) => LAW_EVIDENCE_IDS.has(item.id))).toBe(false);
  });
  it("keeps the previous merge for general questions", () => {
    const learn = [learnEntry("learn-unit-l1-u2")];
    const stat = selectEvidence("생성형 AI 환각이 뭐야?");
    const merged = filterEvidenceByIntent(learn, stat, "general");
    expect(merged[0].id).toBe("learn-unit-l1-u2");
    expect(merged.length).toBeLessThanOrEqual(4);
  });
});

describe("assistant internal id stripping", () => {
  it("removes the exact baseline leak and cleans the leftover parenthesis", () => {
    const answer =
      "법령 자료는 실제 조문을 근거로 확인해야 합니다. (참고: [learn-unit-l1-u2]·[learn-unit-l6-u5])";
    const clean = stripInternalEvidenceIds(answer, [learnEntry("learn-unit-l1-u2"), learnEntry("learn-unit-l6-u5")]);
    expect(clean).toBe("법령 자료는 실제 조문을 근거로 확인해야 합니다.");
    expect(clean).not.toMatch(/learn-unit/);
  });
  it("removes ids not in the provided evidence list", () => {
    const clean = stripInternalEvidenceIds("설명 [learn-unit-l3-u9] 참고", []);
    expect(clean).toBe("설명 참고");
  });
  it("leaves unrelated bracketed text alone", () => {
    expect(stripInternalEvidenceIds("테스트 [주간 정산] 결과", [])).toBe("테스트 [주간 정산] 결과");
  });
});

describe("assistant law evidence entries", () => {
  it("provides grounded law entries with correct kinds", () => {
    for (const id of ["law-mcp-design", "law-lensbot-role", "law-accuracy-limits", "law-evidence-check"]) {
      const found = entry(id);
      expect(found.kind).toBe("policy");
      expect(found.text.length).toBeGreaterThan(0);
    }
    expect(entry("law-research").screen).toBe("법령");
    expect(entry("law-research").title).toBe("종합 리서치");
  });
  it("selects law entries for law questions", () => {
    const stat = selectEvidence("법령 MCP 연동돼?");
    expect(stat.some((item) => item.id === "law-mcp-design")).toBe(true);
    const role = selectEvidence("렌즈봇도 법령 MCP를 직접 조회해?");
    expect(role.some((item) => item.id === "law-lensbot-role")).toBe(true);
    const accuracy = selectEvidence("WorkLens 법령 검색 정확도 100%야?");
    expect(accuracy.some((item) => item.id === "law-accuracy-limits")).toBe(true);
  });
});

describe("assistant dictionary navigation", () => {
  it("points to the review header button, not HELP or the old submenu", () => {
    const found = entry("guide-dictionary");
    expect(found.screen).toBe("검수");
    expect(found.text).toContain("상단");
    expect(found.text).toContain("버튼");
    expect(found.text).not.toContain("하위 메뉴");
    expect(found.text).not.toContain("HELP");
    const stat = selectEvidence("검수 용어 사전은 어디 있어?");
    expect(stat.some((item) => item.id === "guide-dictionary")).toBe(true);
  });
});

describe("assistant bare hallucination clarification", () => {
  it("asks a short clarification for a target-less hallucination-action question", () => {
    expect(classifyQuestion("환각은 어떻게 처리해?")).toBe("clarify");
    expect(clarifyResponse("환각은 어떻게 처리해?")).toBe(
      "일반적인 AI 환각을 말씀하시나요, 아니면 WorkLens 법령 기능의 근거 검증을 말씀하시나요?",
    );
    expect(clarifyOptions("환각은 어떻게 처리해?")).toEqual([
      "일반적인 AI 환각",
      "WorkLens 법령 기능의 근거 검증",
    ]);
  });
  it("does not clarify when the target is stated", () => {
    expect(classifyQuestion("법령 환각은 어떻게 처리해?")).toBe("in-scope");
    expect(classifyQuestion("생성형 AI 환각은 어떻게 방지해?")).toBe("in-scope");
    expect(classifyQuestion("생성형 AI 환각이 뭐야?")).toBe("in-scope");
  });
  it("does not re-clarify after a clarification option is selected", () => {
    // Route builds "<original> (<option>에 대해 질문)" after resolveClarifyFollowUp.
    expect(classifyQuestion("환각은 어떻게 처리해? (일반적인 AI 환각에 대해 질문)")).toBe("in-scope");
    expect(classifyQuestion("환각은 어떻게 처리해? (WorkLens 법령 기능의 근거 검증에 대해 질문)")).toBe("in-scope");
    expect(classifyEvidenceIntent("환각은 어떻게 처리해? (일반적인 AI 환각에 대해 질문)")).toBe("general");
    expect(classifyEvidenceIntent("환각은 어떻게 처리해? (WorkLens 법령 기능의 근거 검증에 대해 질문)")).toBe("law");
  });
});

describe("assistant law system rules", () => {
  it("includes the law evidence, role, guarantee-ban, and no-id rules", () => {
    const messages = buildAssistantMessages("법령 환각 없어?", []);
    const system = messages[0].content;
    expect(system).toContain("법령 근거를 우선 사용하고");
    expect(system).toContain("법령 MCP를 직접 조회하지 않습니다");
    expect(system).toContain("환각이 전혀 없습니다");
    expect(system).toContain("citedIds 배열로만 표시하세요");
  });
});
