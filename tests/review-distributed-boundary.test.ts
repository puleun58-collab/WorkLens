import { describe, expect, it } from "vitest";
import { reviewFileFor, reviewRequestFor, type ReviewFile } from "@/lib/law-review-source";
import { LAW_RESEARCH_BODY_MAX_BYTES, LAW_REVIEW_FILE_MAX_CHARS, LAW_REVIEW_FILE_MAX_SEGMENTS, LAW_REVIEW_SEGMENT_MAX_CHARS } from "@/lib/law-research";
import { paragraphCase } from "./eval/document-review-cases";

const filler = (size: number) => "당사자는 업무 사항을 기록한다. ".repeat(Math.ceil(size / 17)).slice(0, size);
function check(file: ReviewFile) {
  expect(file.document.segments.reduce((sum, segment) => sum + segment.text.length, file.document.classificationContext?.length ?? 0)).toBeLessThanOrEqual(LAW_REVIEW_FILE_MAX_CHARS);
  expect(file.document.segments.length + (file.document.classificationContext ? 1 : 0)).toBeLessThanOrEqual(LAW_REVIEW_FILE_MAX_SEGMENTS);
  expect(new TextEncoder().encode(JSON.stringify(reviewRequestFor(file.document))).byteLength).toBeLessThanOrEqual(LAW_RESEARCH_BODY_MAX_BYTES);
  for (const segment of file.document.segments) expect(segment.text.length).toBeLessThanOrEqual(LAW_REVIEW_SEGMENT_MAX_CHARS);
  expect(file.sources).toHaveLength(file.document.segments.length);
  expect(file.coverage.reviewed + file.coverage.unreviewed + file.coverage.excluded).toBe(file.coverage.total);
  expect(file.coverage.reviewed).toBe(new Set(file.sources.map((source) => source.nodeId)).size);
}

describe("distributed fallback boundaries A-F", () => {
  it("A: skips oversized band heads and selects later small units through the tail", () => {
    const lines = Array.from({ length: 100 }, (_, index) => index % 5 === 0 ? filler(7000) : `작은 문단 ${index}: ${filler(150)}`);
    const file = reviewFileFor(paragraphCase("oversized", "docx", lines, []).document, "문서.docx", { selection: "distributed" });
    for (let band = 0; band < 20; band++) expect(file.document.segments.some((segment) => segment.text === lines[band * 5 + 1])).toBe(true);
    expect(file.document.segments.at(-1)?.text).toBe(lines.at(-1));
    check(file);
  });

  it.each([130, 700, 2300])("B/F: zero candidates with varying unit sizes (%i) stays spread and accurately partial", (size) => {
    const id = `zero-${size}`;
    const lines = Array.from({ length: Math.ceil(160000 / size) }, () => filler(size));
    const file = reviewFileFor(paragraphCase(id, "docx", lines, []).document, "문서.docx");
    expect(file.scan.candidates).toBe(0);
    expect(file.coverage.status).toBe("partial");
    expect(file.coverage.reasons.join(" ")).toContain("위험 항목이 없다는 뜻은 아닙니다");
    const sent = new Set(file.sources.map((source) => source.nodeId));
    for (const band of [0, 9, 19]) {
      const from = Math.floor(band * lines.length / 20);
      const to = Math.floor((band + 1) * lines.length / 20);
      expect(lines.slice(from, to).some((_, offset) => sent.has(`${id}-${from + offset}`))).toBe(true);
    }
    check(file);
  });

  it("C/D: near-share candidates still leave fallback and preserve the last tenth", () => {
    const lines = Array.from({ length: 1000 }, (_, index) => `문단 ${index} ${filler(180)}`);
    lines[980] = "제981조(위약금) 위반자는 위약금 500만원을 지급한다.";
    const file = reviewFileFor(paragraphCase("share", "docx", lines, []).document, "문서.docx", {
      candidates: (found) => [...found, { units: Array.from({ length: 350 }, (_, index) => index), anchor: 0, issueHint: "custom", severityHint: "high", factKey: "custom" }],
    });
    expect(file.document.segments.some((segment) => segment.text === lines[980])).toBe(true);
    expect(file.sources.some((source) => source.nodeId === "share-600")).toBe(true);
    expect(file.document.segments.at(-1)?.text).toBe(lines.at(-1)?.trim());
    check(file);
  });

  it("E: repeated boilerplate plus long units preserve representatives, other issues and final candidate", () => {
    const lines = Array.from({ length: 1000 }, (_, index) => index % 3 === 0
      ? "위반자는 위약금 500만원을 지급한다." : filler(index % 11 === 0 ? 6500 : 180));
    lines[500] = "회사는 어떠한 경우에도 책임을 지지 않는다.";
    lines[999] = "통지가 없으면 계약은 자동 갱신된다.";
    const file = reviewFileFor(paragraphCase("repeats", "docx", lines, []).document, "문서.docx");
    expect(file.scan.repeated).toBeGreaterThan(300);
    expect(file.document.segments.some((segment) => segment.text === lines[500])).toBe(true);
    expect(file.document.segments.at(-1)?.text).toBe(lines[999]);
    for (const band of [0, 4, 9]) expect(file.scan.positions[band]).toBeGreaterThan(0);
    check(file);
  });
});

// Independent gold is used only by the regression, never by the selector.
describe("distributed development gaps", () => {
  it.each(["dev-20-multi-issue", "dev-22-repeated-boilerplate"])("selects every gold location in %s", async (id) => {
    const { DEVELOPMENT_CASES } = await import("./eval/document-review-cases");
    const { evaluateCase } = await import("./eval/document-review-harness");
    const test = DEVELOPMENT_CASES.find((entry) => entry.id === id)!;
    expect(await evaluateCase(test, undefined, { selection: "distributed" })).toMatchObject({ selectorFn: 0, fn: 0, fp: 0 });
  });
});
