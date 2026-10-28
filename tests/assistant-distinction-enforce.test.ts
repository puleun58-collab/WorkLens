/**
 * Distinction-section enforcement (retry, not replacement) + internal id
 * stripping for the whole evidence bank, not just the turn's selection.
 *
 * Live 2026-10-28 (PR #344 deployed): the fixed distinction section
 * ("확인된 자료:" / "미확인·참고 항목:") appeared in 0/14 answers, and one
 * answer exposed "[law-error-types]" verbatim. The route now retries once
 * (revision, same model/budget) when an in-scope law answer lacks the section,
 * keeps the checked original on any retry failure, and never substitutes a
 * no-evidence reply for a missing format section. Route wiring itself is
 * verified by typecheck/build/E2E + post-deploy parent live verification
 * (no Groq key on the VM); these tests pin the deterministic pieces.
 */
import { describe, expect, it } from "vitest";
import { stripInternalEvidenceIds } from "@/lib/assistant/evidence";
import { buildAssistantMessages, hasLawDistinctionSection } from "@/lib/assistant/prompt";
import { matchesLawReliabilityValueQuestion } from "@/lib/assistant/topics";

describe("stripInternalEvidenceIds covers the whole bank", () => {
  it("strips a bank id that this turn did not select", () => {
    // The live leak: law-error-types survived a turn whose selection did not
    // include it (selection is top-3 scored; the model can also echo an id
    // from a previous answer sent back as context).
    const answer = "근거 매칭 오류는 실제 존재하는 자료를 잘못 연결한 경우입니다 [law-error-types].";
    expect(stripInternalEvidenceIds(answer, [])).not.toContain("law-error-types");
    expect(stripInternalEvidenceIds(answer, [])).toContain("근거 매칭 오류는");
  });

  it("strips a selected bank id and keeps non-id brackets intact", () => {
    // Selection no longer matters: the whole bank is stripped either way.
    expect(stripInternalEvidenceIds("설명 [law-mcp-value] 참고", [])).not.toContain("law-mcp-value");
    expect(stripInternalEvidenceIds("테스트 [주간 정산] 결과", [])).toBe("테스트 [주간 정산] 결과");
  });
});

describe("matchesLawReliabilityValueQuestion scope", () => {
  it("matches reliability/value questions", () => {
    expect(matchesLawReliabilityValueQuestion("법령 MCP를 사용하면 환각이 없는 거 아니야?")).toBe(true);
    expect(matchesLawReliabilityValueQuestion("그럼 법령 MCP를 연결한 의미가 뭐야?")).toBe(true);
    expect(matchesLawReliabilityValueQuestion("법령 정확도 100%야?")).toBe(true);
    expect(matchesLawReliabilityValueQuestion("그건 환각이 아니잖아?")).toBe(true);
    expect(matchesLawReliabilityValueQuestion("근거 매칭 오류 아니야?")).toBe(true);
  });

  it("does not match law-function guidance questions", () => {
    // These keep the intended "관련 안내" form; no forced section.
    expect(matchesLawReliabilityValueQuestion("원문 확인 기능이 있어?")).toBe(false);
    expect(matchesLawReliabilityValueQuestion("법령 검색은 어디서 해?")).toBe(false);
    expect(matchesLawReliabilityValueQuestion("원문도 WorkLens에서 확인 가능하잖아?")).toBe(false);
  });
});

describe("distinction retry message construction", () => {
  it("adds the fixed-label revision instruction with the first answer", () => {
    const messages = buildAssistantMessages("법령 MCP를 연결한 의미가 뭐야?", [], undefined, undefined, undefined, undefined, undefined, undefined, "첫 답변 본문");
    const userContent = messages[1].content;
    expect(userContent).toContain("확인된 자료:");
    expect(userContent).toContain("미확인·참고 항목:");
    expect(userContent).toContain("이전 답변: 첫 답변 본문");
    expect(userContent).toContain("새로운 사실·수치를 만들지 말고");
  });

  it("adds no revision block without a retry answer", () => {
    const messages = buildAssistantMessages("법령 MCP를 연결한 의미가 뭐야?", []);
    expect(messages[1].content).not.toContain("형식 보완 요청");
  });

  it("detects the fixed section only when both labels are present", () => {
    expect(hasLawDistinctionSection("확인된 자료: 원문 존재 확인\n미확인·참고 항목: 해석 미확인")).toBe(true);
    expect(hasLawDistinctionSection("확인된 자료: 원문 존재 확인")).toBe(false);
    expect(hasLawDistinctionSection("일반 답변입니다.")).toBe(false);
  });
});
