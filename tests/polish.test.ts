import { describe, expect, it } from "vitest";
import { collectPolishCandidates, isProse } from "@/lib/polish/candidates";
import { polishClipboardText, reviewProposal, summarizePolish } from "@/lib/polish/engine";
import { verifyPolish } from "@/lib/polish/protect";
import { parsePolishResponse } from "@/lib/ai/polish-prompt";
import type { NormalizedDocument, SourceRef } from "@/domain/document";
import type { PolishCandidate } from "@/domain/polish";

/**
 * Polish is the one AI feature that rewrites the user's own words, so the
 * deterministic guard is the contract under test: what it lets through, and —
 * more importantly — what it refuses no matter how fluent the rewrite is.
 */
const source: SourceRef = { fileId: "file-1", nodeId: "p1", label: "Paragraph 1" };
const candidate = (text: string): PolishCandidate => ({ id: "p1", text, source, origin: "paragraph" });

function document(lines: readonly string[], role?: "heading"): NormalizedDocument {
  return {
    id: "document:file-1",
    fileId: "file-1",
    kind: "docx",
    metadata: { fileName: "보고서.docx" },
    blocks: lines.map((text, index) => ({
      type: "paragraph" as const,
      id: `p${index}`,
      text,
      role,
      source: { fileId: "file-1", nodeId: `p${index}`, label: `Paragraph ${index + 1}` },
    })),
    warnings: [],
  };
}

describe("polish prose selection", () => {
  it("takes sentences and leaves values, codes and labels alone", () => {
    expect(isProse("사업 추진 관련하여 검토 부탁드리고자 합니다.")).toBe(true);
    expect(isProse("1,250,000")).toBe(false);
    expect(isProse("WL-2026")).toBe(false);
    expect(isProse("https://intra.example.com/report")).toBe(false);
    expect(isProse("매출")).toBe(false);
    expect(isProse("2026-08-31")).toBe(false);
  });

  it("keeps headings out of the candidate set", () => {
    expect(collectPolishCandidates(document(["3분기 운영 보고서 개요 정리"], "heading"))).toEqual([]);
    expect(collectPolishCandidates(document(["3분기 운영 보고서 개요 정리"]))).toHaveLength(1);
  });

  it("carries the canonical source of every candidate", () => {
    const [entry] = collectPolishCandidates(document(["운영 효율을 개선하기 위한 조치를 검토했습니다."]));
    expect(entry.source?.nodeId).toBe("p0");
    expect(entry.origin).toBe("paragraph");
  });
});

describe("polish protection", () => {
  it("accepts a rewrite that only changes wording", () => {
    const verdict = verifyPolish(
      "사업 추진 관련하여 검토를 부탁드리고자 합니다.",
      "사업 추진 관련 검토를 부탁드립니다.",
    );
    expect(verdict.ok).toBe(true);
  });

  for (const [name, original, revised] of [
    ["numbers", "매출은 1,250만원입니다.", "매출은 1,350만원입니다."],
    ["dates", "기준일은 2026-08-31입니다.", "기준일은 2026-09-31입니다."],
    ["times", "회의는 14:30에 시작합니다.", "회의는 15:30에 시작합니다."],
    ["percent", "달성률은 87.0%입니다.", "달성률은 88.0%입니다."],
    ["units", "총 120건을 처리했습니다.", "총 130건을 처리했습니다."],
    ["email", "문의는 ops@example.com으로 보내세요.", "문의는 help@example.com으로 보내세요."],
    ["url", "자료는 https://intra.example.com/a 에 있습니다.", "자료는 https://intra.example.com/b 에 있습니다."],
    ["code", "SOP-Q3 절차를 따릅니다.", "SOP-Q4 절차를 따릅니다."],
  ] as const) {
    it(`rejects a rewrite that changes ${name}`, () => {
      const verdict = verifyPolish(original, revised);
      expect(verdict.ok).toBe(false);
      expect(verdict.rejection).toBe("protected-token");
    });
  }

  it("rejects a rewrite that adds a number the original never had", () => {
    const verdict = verifyPolish("매출이 증가했습니다.", "매출이 12% 증가했습니다.");
    expect(verdict.ok).toBe(false);
    expect(verdict.rejection).toBe("protected-token");
  });

  it("keeps a direct quotation verbatim", () => {
    const verdict = verifyPolish(
      '보고서는 "운임 인상은 불가피하다"고 적었습니다.',
      '보고서는 "운임 인상이 불가피하다"고 적었습니다.',
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.rejection).toBe("quote");
  });

  for (const [name, original, revised] of [
    ["possibility to certainty", "지연될 가능성이 있습니다.", "지연됩니다."],
    ["recommendation to obligation", "검토를 권고합니다.", "검토해야 합니다."],
    ["request to order", "확인을 부탁드립니다.", "확인하십시오."],
    ["plan to fact", "9월에 적용 예정입니다.", "9월에 적용했습니다."],
    ["negation dropped", "아직 반영되지 않았습니다.", "이미 반영했습니다."],
  ] as const) {
    it(`rejects a rewrite that changes ${name}`, () => {
      const verdict = verifyPolish(original, revised);
      expect(verdict.ok).toBe(false);
      expect(verdict.rejection).toBe("modality");
    });
  }

  it("rejects a rewrite that keeps little of the original", () => {
    const verdict = verifyPolish(
      "운영 프로세스 개선을 통해 처리 지연을 줄이는 방안을 검토했습니다.",
      "효율을 높이려고 여러 대안을 살펴봤습니다.",
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.rejection).toBe("over-edit");
  });
});

describe("polish engine", () => {
  it("reports an unchanged sentence as a normal outcome", () => {
    const entry = candidate("9월 운임은 전월 대비 상승했습니다.");
    const outcome = reviewProposal(entry, { changed: false, revisedText: entry.text, reasons: [] });
    expect(outcome.status).toBe("unchanged");
    expect(outcome.revisedText).toBe(entry.text);
  });

  it("treats a rewrite identical to the original as unchanged", () => {
    const entry = candidate("운영 모델은 9월부터 적용됩니다.");
    const outcome = reviewProposal(entry, { changed: true, revisedText: entry.text, reasons: ["문장 간결화"] });
    expect(outcome.status).toBe("unchanged");
  });

  it("accepts a verified rewrite with its reasons and source", () => {
    const entry = candidate("AI 기술을 통해 효율을 높일 수 있습니다.");
    const outcome = reviewProposal(entry, {
      changed: true,
      revisedText: "AI로 효율을 높일 수 있습니다.",
      reasons: ["번역투 완화", "중복 표현 축소", "불필요한 접속사 제거", "네 번째 사유"],
    });
    expect(outcome.status).toBe("changed");
    expect(outcome.revisedText).toBe("AI로 효율을 높일 수 있습니다.");
    expect(outcome.reasons).toHaveLength(3);
    expect(outcome.source?.nodeId).toBe("p1");
  });

  it("keeps the original when the guard refuses the rewrite", () => {
    const entry = candidate("매출은 2026년 8월 기준 1,250만원입니다.");
    const outcome = reviewProposal(entry, {
      changed: true,
      revisedText: "매출은 2026년 8월 기준 1,350만원입니다.",
      reasons: ["문장 간결화"],
    });
    expect(outcome.status).toBe("rejected");
    expect(outcome.rejection).toBe("protected-token");
    expect(outcome.revisedText).toBe(entry.text);
  });

  it("summarises a run and copies only the rewrites", () => {
    const outcomes = [
      reviewProposal(candidate("AI 기술을 통해 효율을 높일 수 있습니다."), { changed: true, revisedText: "AI로 효율을 높일 수 있습니다.", reasons: [] }),
      reviewProposal(candidate("9월 운임은 전월 대비 상승했습니다."), { changed: false, revisedText: "", reasons: [] }),
      reviewProposal(candidate("매출은 1,250만원입니다."), { changed: true, revisedText: "매출은 1,350만원입니다.", reasons: [] }),
    ];
    expect(summarizePolish(outcomes)).toEqual({ candidates: 3, changed: 1, unchanged: 1, rejected: 1 });
    expect(polishClipboardText(outcomes)).toBe("AI로 효율을 높일 수 있습니다.");
  });
});

describe("polish response parsing", () => {
  it("reads the contract shape", () => {
    expect(parsePolishResponse('{"changed":true,"revisedText":"다듬은 문장","reasons":["중복 표현 축소"]}', "원문"))
      .toEqual({ changed: true, revisedText: "다듬은 문장", reasons: ["중복 표현 축소"] });
  });

  it("falls back to the original when the answer is malformed or empty", () => {
    expect(parsePolishResponse("설명만 돌려준 응답", "원문")).toEqual({ changed: false, revisedText: "원문", reasons: [] });
    expect(parsePolishResponse('{"changed":true,"revisedText":"  "}', "원문")).toEqual({ changed: false, revisedText: "원문", reasons: [] });
    expect(parsePolishResponse('{"changed":false,"revisedText":"원문"}', "원문")).toEqual({ changed: false, revisedText: "원문", reasons: [] });
  });

  it("accepts an answer wrapped in a code fence", () => {
    expect(parsePolishResponse('```json\n{"changed":true,"revisedText":"다듬은 문장","reasons":[]}\n```', "원문").changed).toBe(true);
  });
});
