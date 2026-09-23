import { describe, expect, it } from "vitest";
import { POLISH_SEGMENT_MAX_CHARS } from "@/lib/polish/candidates";
import { polishTextResult, reviewProposal } from "@/lib/polish/engine";
import {
  POLISH_TEXT_MAX_CHARS,
  POLISH_TEXT_TOO_LONG_MESSAGE,
  assemblePolishText,
  splitPolishText,
} from "@/lib/polish/text-input";
import type { PolishOutcome, PolishProposal } from "@/domain/polish";

/**
 * Pasted text has no document behind it, so two things carry the contract:
 * the structure the user pasted must come back unchanged, and the same
 * protected-information guard as the file path must still refuse a rewrite
 * that moves a value.
 */
function run(input: string, rewrite: (text: string) => PolishProposal) {
  const segments = splitPolishText(input);
  const outcomes: PolishOutcome[] = segments
    .filter((segment) => segment.polishable)
    .map((segment) => reviewProposal({ id: segment.id, text: segment.text, origin: "pasted" }, rewrite(segment.text)));
  return { segments, outcomes, result: polishTextResult("default", input, segments, outcomes) };
}

const unchanged = (text: string): PolishProposal => ({ changed: false, revisedText: text, reasons: [] });

describe("pasted text segmentation", () => {
  it("keeps blank lines, bullets and numbering out of the model and back in the result", () => {
    const input = [
      "안녕하세요. 3분기 운영 보고 관련하여 검토 부탁드리고자 합니다.",
      "",
      "- 매출은 1,250만원으로 집계되었습니다.",
      "1. 다음 회의는 2026-09-20에 진행될 예정입니다.",
    ].join("\n");
    const { segments, result } = run(input, (text) => ({
      changed: true,
      revisedText: text.replace("관련하여", "관련"),
      reasons: ["번역투 완화"],
    }));
    expect(segments.map((segment) => segment.prefix)).toEqual(["", "", "- ", "1. "]);
    expect(segments.filter((segment) => segment.polishable)).toHaveLength(3);
    const lines = result.revisedText.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe("");
    expect(lines[2].startsWith("- ")).toBe(true);
    expect(lines[3].startsWith("1. ")).toBe(true);
    expect(result.revisedText).toContain("3분기 운영 보고 관련 검토");
  });

  it("never invents a source for pasted text", () => {
    const { result } = run("사업 추진 관련하여 협조를 부탁드리고자 합니다.", (text) => ({
      changed: true,
      revisedText: text.replace("하고자 합니다", "합니다"),
      reasons: [],
    }));
    expect(result.outcomes.every((entry) => entry.source === undefined)).toBe(true);
    expect(result.outcomes.every((entry) => entry.origin === "pasted")).toBe(true);
  });

  it("splits an over-long line at sentence boundaries and rejoins it in order", () => {
    const sentence = "이번 분기 운영 지표는 계획 대비 안정적으로 유지되고 있는 상황으로 파악되고 있습니다. ";
    const input = sentence.repeat(20).trim();
    const { segments, result } = run(input, unchanged);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every((segment) => segment.text.length <= POLISH_SEGMENT_MAX_CHARS)).toBe(true);
    expect(result.revisedText.replace(/\s+/gu, " ")).toBe(input.replace(/\s+/gu, " "));
  });

  it("returns the pasted text unchanged when nothing needed a rewrite", () => {
    const input = "오늘 회의에서 합의한 일정대로 진행하겠습니다.";
    const { result } = run(input, unchanged);
    expect(result.summary.changed).toBe(0);
    expect(result.summary.unchanged).toBe(1);
    expect(result.revisedText).toBe(input);
  });

  it("refuses a rewrite that moves a number, a date, a URL or the strength of a statement", () => {
    const cases = [
      ["매출은 1,250만원으로 집계되었습니다.", "매출은 1,350만원으로 집계되었습니다."],
      ["보고서는 2026-09-20에 제출합니다.", "보고서는 2026-09-21에 제출합니다."],
      ["자세한 내용은 https://intra.example.com/report 에서 확인하세요.", "자세한 내용은 https://intra.example.com/reports 에서 확인하세요."],
      ["일정이 지연될 가능성이 있습니다.", "일정이 지연됩니다."],
    ] as const;
    for (const [original, rewritten] of cases) {
      const { result } = run(original, () => ({ changed: true, revisedText: rewritten, reasons: ["문장 정리"] }));
      expect(result.summary.rejected, original).toBe(1);
      expect(result.revisedText, original).toBe(original);
    }
  });

  it("accepts 9,999 and 10,000 characters but rejects 10,001", () => {
    const sentence = "운영 개선 방안을 함께 검토 부탁드립니다. ";
    for (const length of [9_999, 10_000]) {
      const input = sentence.repeat(Math.ceil(length / sentence.length)).slice(0, length);
      expect(splitPolishText(input).length).toBeGreaterThan(1);
    }
    const tooLong = sentence.repeat(Math.ceil(10_001 / sentence.length)).slice(0, 10_001);
    expect(() => splitPolishText(tooLong)).toThrow(POLISH_TEXT_TOO_LONG_MESSAGE);
    expect(POLISH_TEXT_MAX_CHARS).toBe(10_000);
  });

  it("bounds each near-10k request to 600 characters and restores lists and paragraph breaks", () => {
    expect(POLISH_SEGMENT_MAX_CHARS).toBe(600);
    const opening = "보고 내용을 검토 부탁드립니다.\n\n- ";
    const ending = "\n1. 다음 회의에서 내용을 확인 부탁드립니다.\n\n검토 결과를 공유하겠습니다.";
    const bodyLength = POLISH_TEXT_MAX_CHARS - opening.length - ending.length;
    const sentence = "운영 개선 방안을 함께 검토 부탁드립니다. ";
    const body = sentence.repeat(Math.ceil(bodyLength / sentence.length)).slice(0, bodyLength);
    const input = `${opening}${body}${ending}`;
    const { segments, result } = run(input, unchanged);
    expect(input.length).toBe(10_000);
    expect(segments.filter((segment) => segment.polishable).length).toBeGreaterThan(15);
    expect(segments.every((segment) => segment.text.length <= POLISH_SEGMENT_MAX_CHARS)).toBe(true);
    expect(result.revisedText).toBe(input);
    expect(result.summary.failed).toBe(0);
  });

  it("does not invent spaces when a single sentence exceeds a segment", () => {
    const input = `운영 개선 방안을 ${"검토".repeat(400)} 부탁드립니다.`;
    const segments = splitPolishText(input);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.some((segment) => segment.joiner === "")).toBe(true);
    expect(segments.every((segment) => segment.text.length <= 600)).toBe(true);
    expect(assemblePolishText(segments, new Map())).toBe(input);
  });
});
