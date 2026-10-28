/**
 * Orphan-paren cleanup after internal id stripping (live 2026-10-28, PR #348
 * deployed): removing "[law-...]" ids left separator-only parentheses on
 * screen ("내용(,)", "(,,)", "(,)"). The strip must also drop those
 * orphans and trim orphan separators at paren edges, while keeping real
 * parenthetical content and non-id brackets intact. Plain "()" was already
 * removed; the invisible-character case below pins the variant that renders
 * as "()" on screen.
 */
import { describe, expect, it } from "vitest";
import { stripInternalEvidenceIds } from "@/lib/assistant/evidence";

describe("stripInternalEvidenceIds orphan-paren cleanup", () => {
  it("removes separator-only parens left by id removal", () => {
    expect(stripInternalEvidenceIds("내용([law-error-types], [law-mcp-value])", [])).toBe("내용");
    expect(stripInternalEvidenceIds("내용([law-error-types], [law-mcp-value])입니다", [])).toBe("내용입니다");
    expect(stripInternalEvidenceIds("([law-error-types], [law-mcp-value])", [])).toBe("");
    expect(stripInternalEvidenceIds("([law-error-types], [law-mcp-value], [law-accuracy-limits])", [])).toBe("");
  });

  it("trims orphan separators at paren edges around real content", () => {
    expect(stripInternalEvidenceIds("내용([law-error-types], 검증)", [])).toBe("내용(검증)");
    expect(stripInternalEvidenceIds("설명(내용,)", [])).toBe("설명(내용)");
    expect(stripInternalEvidenceIds("설명(, 내용)", [])).toBe("설명(내용)");
  });

  it("removes empty and invisible-only parens", () => {
    expect(stripInternalEvidenceIds("보장할 수 없음()", [])).toBe("보장할 수 없음");
    expect(stripInternalEvidenceIds("보장할 수 없음(\u200b)", [])).toBe("보장할 수 없음");
  });

  it("keeps real parenthetical content and non-id brackets intact", () => {
    expect(stripInternalEvidenceIds("테스트 [주간 정산] 결과", [])).toBe("테스트 [주간 정산] 결과");
    expect(stripInternalEvidenceIds("설명(예: A, B) 참고", [])).toBe("설명(예: A, B) 참고");
    expect(stripInternalEvidenceIds("가격(1,000원) 확인", [])).toBe("가격(1,000원) 확인");
    expect(stripInternalEvidenceIds("내용(검증 4단계) 참고", [])).toBe("내용(검증 4단계) 참고");
  });
});
