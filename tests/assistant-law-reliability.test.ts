import { describe, expect, it } from "vitest";
import {
  classifyEvidenceIntent,
  resolveFollowUpIntent,
  topicAnchorForRequest,
  updateTopicAnchor,
} from "../src/lib/assistant/topics";
import {
  ASSISTANT_EVIDENCE,
  filterEvidenceByIntent,
  LAW_EVIDENCE_IDS,
  selectEvidence,
  type AssistantEvidence,
} from "../src/lib/assistant/evidence";
import { buildAssistantMessages } from "../src/lib/assistant/prompt";

function entry(id: string): AssistantEvidence {
  const found = ASSISTANT_EVIDENCE.find((item) => item.id === id);
  if (!found) throw new Error(`missing evidence ${id}`);
  return found;
}

/** Route-level merge for a marker-less follow-up given a topic anchor. */
function mergedForFollowUp(anchor: string, question: string): AssistantEvidence[] {
  const intent = resolveFollowUpIntent(question, anchor);
  return filterEvidenceByIntent(
    [],
    selectEvidence(`${anchor} ${question}`),
    intent,
  );
}

describe("assistant law topic anchor (multi-turn CASE 1)", () => {
  const t1 = "법령 MCP 연동이면 환각이 없는 거 아니야?";
  const t2 = "그럼 왜 잘못된 결과가 나와?";
  const t3 = "그럼 사용하는 의미가 없잖아.";
  const t4 = "일반 AI랑 뭐가 다른데?";

  it("keeps the law anchor across marker-less turns 2-4", () => {
    let anchor: string | null = null;
    expect(topicAnchorForRequest(t1, anchor)).toBeNull();
    anchor = updateTopicAnchor(t1, anchor);
    expect(anchor).toBe(t1);
    for (const turn of [t2, t3, t4]) {
      expect(topicAnchorForRequest(turn, anchor)).toBe(t1);
      expect(resolveFollowUpIntent(turn, t1)).toBe("law");
      anchor = updateTopicAnchor(turn, anchor);
      expect(anchor).toBe(t1);
    }
  });

  it("keeps law evidence (no learn, no coding-agent) at turns 3 and 4", () => {
    for (const turn of [t3, t4]) {
      const merged = mergedForFollowUp(t1, turn);
      expect(merged.some((item) => LAW_EVIDENCE_IDS.has(item.id))).toBe(true);
      expect(merged.some((item) => item.id.startsWith("learn-"))).toBe(false);
      expect(merged.map((item) => item.id)).not.toContain("ax-prompt");
      expect(merged.map((item) => item.id)).not.toContain("ax-mvp");
    }
    // Turn 4 is answered from the law value entry, not a generic AI lesson.
    expect(mergedForFollowUp(t1, t4).some((item) => item.id === "law-mcp-value")).toBe(true);
  });
});

describe("assistant law topic switching (CASE 2 and CASE 3)", () => {
  it("switches law -> learn and keeps learn for the marker-less follow-up (CASE 2)", () => {
    const lawQ = "법령 MCP는 어떻게 검증해?";
    const learnQ = "학습센터 퀴즈는 어떻게 풀어?";
    const follow = "그럼 통과 기준은?";
    let anchor: string | null = updateTopicAnchor(lawQ, null);
    expect(anchor).toBe(lawQ);
    expect(topicAnchorForRequest(learnQ, anchor)).toBeNull();
    anchor = updateTopicAnchor(learnQ, anchor);
    expect(anchor).toBe(learnQ);
    expect(topicAnchorForRequest(follow, anchor)).toBe(learnQ);
    expect(resolveFollowUpIntent(follow, learnQ)).toBe("learn");
    const merged = filterEvidenceByIntent(
      [],
      selectEvidence(`${learnQ} ${follow}`),
      resolveFollowUpIntent(follow, learnQ),
    );
    expect(merged.some((item) => LAW_EVIDENCE_IDS.has(item.id))).toBe(false);
  });

  it("switches learn -> law and keeps law for the matching-error follow-up (CASE 3)", () => {
    const learnQ = "학습센터에서 환각이 뭐야?";
    const lawQ = "법령 카테고리는 환각을 어떻게 방지해?";
    const follow = "그럼 근거 매칭 오류는?";
    let anchor: string | null = updateTopicAnchor(learnQ, null);
    expect(anchor).toBe(learnQ);
    anchor = updateTopicAnchor(lawQ, anchor);
    expect(anchor).toBe(lawQ);
    expect(topicAnchorForRequest(follow, anchor)).toBe(lawQ);
    expect(resolveFollowUpIntent(follow, lawQ)).toBe("law");
    const merged = mergedForFollowUp(lawQ, follow);
    expect(merged.some((item) => item.id === "law-error-types")).toBe(true);
    expect(merged.some((item) => item.id.startsWith("learn-"))).toBe(false);
  });

  it("clears the anchor on an explicit AX-topic question and on reset (CASE 4)", () => {
    const lawQ = "법령 MCP 연동이면 환각이 없는 거 아니야?";
    const anchor = updateTopicAnchor(lawQ, null);
    expect(topicAnchorForRequest("그럼 Level 2는?", anchor)).toBeNull();
    expect(updateTopicAnchor("그럼 Level 2는?", anchor)).toBeNull();
    // After a reset there is no anchor, so a marker-less question stays general.
    expect(topicAnchorForRequest("그럼 사용하는 의미가 없잖아.", null)).toBeNull();
    expect(resolveFollowUpIntent("그럼 사용하는 의미가 없잖아.")).toBe("general");
  });
});

describe("assistant law reliability questions (task A)", () => {
  it("selects the error-type entry for hallucination and matching-error questions", () => {
    expect(selectEvidence("법령 MCP 붙였는데 환각이 생겨?").some((e) => e.id === "law-error-types")).toBe(true);
    expect(selectEvidence("실제 법령인데 왜 틀릴 수 있어?").some((e) => e.id === "law-error-types")).toBe(true);
    expect(selectEvidence("근거 매칭 오류와 법령 환각은 다른 거 아니야?").some((e) => e.id === "law-error-types")).toBe(true);
  });

  it("selects the value entry for meaning, trust, and difference questions", () => {
    expect(selectEvidence("MCP 연결한 의미가 뭐야?").some((e) => e.id === "law-mcp-value")).toBe(true);
    expect(selectEvidence("WorkLens 법령 기능을 믿고 사용해도 돼?").some((e) => e.id === "law-mcp-value")).toBe(true);
    expect(selectEvidence("일반 AI랑 뭐가 다른데?").some((e) => e.id === "law-mcp-value")).toBe(true);
  });

  it("keeps the existing role and accuracy entries for boundary questions", () => {
    expect(selectEvidence("렌즈봇도 MCP 직접 조회해?").some((e) => e.id === "law-lensbot-role")).toBe(true);
    expect(selectEvidence("법령 정확도 100%야?").some((e) => e.id === "law-accuracy-limits")).toBe(true);
  });

  it("distinguishes absence, insufficiency, and lookup failure in the taxonomy text", () => {
    const text = entry("law-error-types").text;
    for (const fragment of [
      "생성 환각", "근거 매칭 오류", "해석 오류", "적용 시점 오류", "근거 누락", "원문 조회 실패",
      "원문이 실제 존재하는지", "질문·쟁점과 관련 있는지", "원문을 정확하게 해석했는지", "실제 사건에 적용할 수 있는지",
      "법령 자체가 없다는 뜻이 아니며", "자료가 없다는 뜻이 아닙니다",
    ]) expect(text).toContain(fragment);
    expect(LAW_EVIDENCE_IDS.has("law-error-types")).toBe(true);
    expect(LAW_EVIDENCE_IDS.has("law-mcp-value")).toBe(true);
  });

  it("states the MCP value in the grounded order without invented metrics", () => {
    const text = entry("law-mcp-value").text;
    expect(text).toContain("공식 자료 기반 조회");
    expect(text).toContain("쟁점별");
    expect(text).toContain("직접 조회하지 않습니다");
    expect(text).toContain("보장하지 않습니다");
    expect(text).toContain("검증된 정확도·오류 감소 수치는 근거에 없습니다");
    expect(text).not.toMatch(/\d+\s*%/);
  });
});

describe("assistant law evidence filtering", () => {
  it("drops learn and coding-agent entries for law intent", () => {
    const learn: AssistantEvidence = {
      id: "learn-unit-l1-u2", screen: "학습센터", title: "생성형 AI",
      text: "학습 내용", keywords: /환각/iu, kind: "policy",
    };
    const merged = filterEvidenceByIntent(
      [learn],
      [entry("ax-prompt"), entry("ax-mvp"), entry("law-mcp-design")],
      "law",
    );
    expect(merged.map((e) => e.id)).toEqual(["law-mcp-design"]);
  });

  it("keeps the new prompt rules: error-type distinction and value-answer order", () => {
    const system = buildAssistantMessages("법령 환각 없어?", [])[0].content;
    expect(system).toContain("근거 매칭 오류");
    expect(system).toContain("공식 자료 조회가 제공하는 차이");
    expect(system).toContain("확인된 자료와 미확인 자료의 구분");
    expect(system).toContain("해당 주제로 답을 옮기지 마세요");
    expect(classifyEvidenceIntent("법령 MCP 붙였는데 환각이 생겨?")).toBe("law");
  });
});
