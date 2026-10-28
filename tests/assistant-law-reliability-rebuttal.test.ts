/**
 * Lensbot law reliability: rebuttal detection, subject distinction, and the
 * §5 five-turn chain — at the deterministic prompt / intent / evidence level
 * only. Model output behaviour (whether the model actually writes the
 * distinction section or accepts a rebuttal) is NOT verified here; it stays a
 * parent live-verification item. No fixed answer wording is asserted.
 */
import { describe, expect, it } from "vitest";
import { filterEvidenceByIntent, LAW_EVIDENCE_IDS, selectEvidence } from "@/lib/assistant/evidence";
import { buildAssistantMessages, hasLawDistinctionSection } from "@/lib/assistant/prompt";
import {
  classifyEvidenceIntent,
  hasExplicitAxTopic,
  isRebuttalQuestion,
  matchesLawFunctionQuestion,
  resolveFollowUpIntent,
  topicAnchorForRequest,
  updateTopicAnchor,
} from "@/lib/assistant/topics";

const ids = (question: string) => selectEvidence(question).map((entry) => entry.id);
const lawIds = (question: string) =>
  filterEvidenceByIntent([], selectEvidence(question), "law").map((entry) => entry.id);
const hasLaw = (question: string) => lawIds(question).some((id) => LAW_EVIDENCE_IDS.has(id));
const system = () => buildAssistantMessages("법령 질문", [])[0].content;

describe("P1 intent markers: 원문 / 근거 매칭", () => {
  it("classifies a standalone 원문 question as law intent", () => {
    expect(classifyEvidenceIntent("원문도 WorkLens에서 확인 가능하잖아?")).toBe("law");
  });
  it("classifies a standalone 근거 매칭 question as law intent", () => {
    expect(classifyEvidenceIntent("그러니까 그건 근거 매칭 오류 아니야?")).toBe("law");
  });
  it("selects law evidence for the standalone 원문 turn (no anchor needed)", () => {
    const selected = ids("원문도 WorkLens에서 확인 가능하잖아?");
    expect(selected.some((id) => id === "law-mcp-value" || id === "law-evidence-check")).toBe(true);
  });
  it("selects the error-types evidence for the 근거 매칭 turn", () => {
    expect(ids("그러니까 그건 근거 매칭 오류 아니야?")).toContain("law-error-types");
  });
  it("keeps a plain document question out of the law intent", () => {
    expect(classifyEvidenceIntent("문서 검토는 어떻게 해?")).toBe("general");
  });
});

describe("§5 five-turn chain (anchor + intent + evidence)", () => {
  const turns = [
    "법령 MCP를 사용하면 환각이 없는 거 아니야?",
    "그럼 결과가 잘못될 수 있다는 거야?",
    "원문도 WorkLens에서 확인 가능하잖아?",
    "그러니까 그건 근거 매칭 오류 아니야?",
    "그럼 법령 MCP를 연결한 의미가 뭐야?",
  ];
  it("keeps every turn on the law intent through anchor / own markers", () => {
    let anchor: string | null = null;
    let previous: string | undefined;
    for (const turn of turns) {
      const intent = previous
        ? resolveFollowUpIntent(turn, anchor ?? previous)
        : classifyEvidenceIntent(turn);
      expect(intent).toBe("law");
      const selectionQuery = anchor && classifyEvidenceIntent(turn) === "general"
        ? `${anchor} ${turn}`
        : turn;
      expect(hasLaw(selectionQuery)).toBe(true);
      anchor = updateTopicAnchor(turn, anchor);
      previous = turn;
    }
  });
  it("selects the value evidence for the 5th turn", () => {
    expect(ids("그럼 법령 MCP를 연결한 의미가 뭐야?")).toContain("law-mcp-value");
  });
  it("marker-less follow-ups inherit the anchor, and an AX question clears it", () => {
    const anchor = "법령 MCP를 사용하면 환각이 없는 거 아니야?";
    expect(topicAnchorForRequest("그럼 결과가 잘못될 수 있다는 거야?", anchor)).toBe(anchor);
    expect(resolveFollowUpIntent("그럼 결과가 잘못될 수 있다는 거야?", anchor)).toBe("law");
    expect(hasExplicitAxTopic("Level 2는 뭐야?")).toBe(true);
    expect(topicAnchorForRequest("Level 2는 뭐야?", anchor)).toBeNull();
    expect(updateTopicAnchor("Level 2는 뭐야?", anchor)).toBeNull();
  });
});

describe("P0 rebuttal detection (§7 expressions)", () => {
  const rebuttals = [
    "원문 WorkLens 내에서 확인 가능하잖아?",
    "그건 환각이 아니잖아?",
    "근거 매칭 오류 아니야?",
    "그럼 MCP 연결한 의미가 없잖아.",
    "그러니까 원문도 법령 카테고리 내에서 확인할 수 있잖아.",
  ];
  it.each(rebuttals)("flags as rebuttal: %s", (question) => {
    expect(isRebuttalQuestion(question)).toBe(true);
  });
  it("does not flag plain law questions as rebuttals", () => {
    expect(isRebuttalQuestion("법령 검색은 어디서 하나요?")).toBe(false);
    expect(isRebuttalQuestion("법령 MCP 연동의 의미가 뭐야?")).toBe(false);
  });
  it("passes a rebuttal block to the model and widens the previous-answer bound only on rebuttal turns", () => {
    const longPrevious = "직전 설명. ".repeat(300);
    const rebuttal = buildAssistantMessages(
      "그건 환각이 아니잖아?",
      [],
      undefined,
      undefined,
      "법령 MCP를 사용하면 환각이 없는 거 아니야?",
      undefined,
      longPrevious,
      true,
    )[1].content;
    expect(rebuttal).toContain("사용자 반론");
    expect(rebuttal).toContain("반론 대상 표현을 먼저 언급");
    expect(rebuttal).toContain("최대 1000자");
    const normal = buildAssistantMessages(
      "그럼 결과가 잘못될 수 있다는 거야?",
      [],
      undefined,
      undefined,
      "법령 MCP를 사용하면 환각이 없는 거 아니야?",
      undefined,
      longPrevious,
    )[1].content;
    expect(normal).not.toContain("사용자 반론");
    expect(normal).toContain("최대 600자");
  });
});

describe("P0 prompt: priority, distinction format, subject rule, label vs fact", () => {
  it("declares distinction / acknowledgement / rebuttal rules above brevity rules", () => {
    expect(system()).toContain("보다 우선합니다");
  });
  it("defines the fixed distinction-section format", () => {
    expect(system()).toContain("확인된 자료:");
    expect(system()).toContain("미확인·참고 항목:");
  });
  it("states the lensbot / WorkLens subject distinction", () => {
    expect(system()).toContain("불가능하다는 뜻은 아닙니다");
    expect(system()).toContain("구분해서 인정하세요");
  });
  it("distinguishes label correction from fact-conclusion change", () => {
    expect(system()).toContain("분류·라벨 정정");
    expect(system()).toContain("사실 결론 변경");
  });
  it("detects the distinction section format deterministically", () => {
    expect(hasLawDistinctionSection("확인된 자료: 원문 존재 확인\n미확인·참고 항목: 해석 미확인")).toBe(true);
    expect(hasLawDistinctionSection("확인된 자료: 원문 존재 확인")).toBe(false);
    expect(hasLawDistinctionSection("일반 답변입니다.")).toBe(false);
  });
});

describe("P1 law-function fallback marker", () => {
  it("matches law-feature questions and rejects unrelated questions", () => {
    expect(matchesLawFunctionQuestion("법령 카테고리에서 원문을 확인할 수 있어?")).toBe(true);
    expect(matchesLawFunctionQuestion("원문 확인 기능이 있어?")).toBe(true);
    expect(matchesLawFunctionQuestion("업무 자동화 진단은 어디서 해?")).toBe(false);
    expect(matchesLawFunctionQuestion("학습센터 퀴즈 통과 기준이 뭐야?")).toBe(false);
  });
});

describe("§8 CASE 1~3 (deterministic level)", () => {
  it("CASE 1 원문 확인: standalone intent + law evidence + subject rule", () => {
    const question = "원문도 WorkLens에서 확인 가능하잖아?";
    expect(classifyEvidenceIntent(question)).toBe("law");
    expect(hasLaw(question)).toBe(true);
    expect(system()).toContain("불가능하다는 뜻은 아닙니다");
  });
  it("CASE 2 매칭 오류 지적: rebuttal flag + error-types evidence + label rule", () => {
    const question = "그러니까 그건 근거 매칭 오류 아니야?";
    expect(isRebuttalQuestion(question)).toBe(true);
    expect(ids(question)).toContain("law-error-types");
    expect(system()).toContain("분류·라벨 정정");
  });
  it("CASE 3 MCP 가치: value evidence + priority + distinction format", () => {
    const question = "그럼 법령 MCP를 연결한 의미가 뭐야?";
    expect(ids(question)).toContain("law-mcp-value");
    expect(system()).toContain("보다 우선합니다");
    expect(system()).toContain("확인된 자료:");
    expect(system()).toContain("미확인·참고 항목:");
  });
});

describe("additional verification table (deterministic level)", () => {
  it("공식 원문 확인 기능 질문: law intent + law evidence", () => {
    const question = "법령 원문은 어디서 확인하나요?";
    expect(classifyEvidenceIntent(question)).toBe("law");
    expect(hasLaw(question)).toBe(true);
  });
  it("원문 자체 환각 여부: law intent + law evidence", () => {
    const question = "원문 자체가 환각일 수 있어?";
    expect(classifyEvidenceIntent(question)).toBe("law");
    expect(hasLaw(question)).toBe(true);
  });
  it("해석 오류 지적 (anchor chain): rebuttal + inherited law intent", () => {
    const anchor = "법령 MCP를 사용하면 환각이 없는 거 아니야?";
    expect(isRebuttalQuestion("해석 오류 아니야?")).toBe(true);
    expect(resolveFollowUpIntent("해석 오류 아니야?", anchor)).toBe("law");
  });
  it("서비스 신뢰성 질문: law intent + priority rule in prompt", () => {
    expect(classifyEvidenceIntent("WorkLens 법령 기능을 믿을 수 있어?")).toBe("law");
    expect(system()).toContain("보다 우선합니다");
  });
  it("정확도 100% 질문: accuracy-limits evidence + guarantee ban in prompt", () => {
    const question = "법령 정확도 100%야?";
    expect(classifyEvidenceIntent(question)).toBe("law");
    expect(ids(question)).toContain("law-accuracy-limits");
    expect(system()).toContain("확정 보장을 쓰지 마세요");
  });
  it("렌즈봇 실시간 조회 질문: law intent + direct-lookup ban in prompt", () => {
    expect(classifyEvidenceIntent("렌즈봇이 실시간으로 법령을 조회해?")).toBe("law");
    expect(system()).toContain("렌즈봇은 법령 MCP를 직접 조회하지 않습니다");
  });
});
