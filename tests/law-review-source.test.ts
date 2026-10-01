import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parseDocument } from "@/lib/parsers";
import { reviewFileFor, type ReviewFile } from "@/lib/law-review-source";
import { LAW_REVIEW_FILE_MAX_CHARS } from "@/lib/law-research";
import { reviewContract, type ReviewSources } from "@/server/contract-review";
import { createDocxParagraphs, createDocxWithOmissions, createPptxSlides, createUnicodePdf, createXlsx } from "./fixtures";
import { B2B_SERVICE_CONTRACT, CONSUMER_TERMS, EMPLOYMENT_CONTRACT } from "./fixtures/contracts";

// Lookups answer nothing: these tests are about which clauses and where, not which statutes.
const sources: ReviewSources = {
  async findLaw() { return undefined; },
  async article() { return undefined; },
  async searchPrecedents() { return []; },
  async holding() { return undefined; },
} as unknown as ReviewSources;

async function parse(fileName: string, bytes: Uint8Array) {
  return parseDocument({ fileId: `file-${fileName}`, fileName, bytes });
}

function docx(body: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
  });
}
const p = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const table = (rows: string[][]) => `<w:tbl>${rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc>${p(cell)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;

/** Each issue with where the review says it came from. */
async function locatedIssues(file: ReviewFile) {
  const review = await reviewContract(file.document.segments.map((segment) => segment.text), sources);
  return {
    review,
    issues: review.clauses.flatMap((clause) => clause.issues.map((issue) => ({
      clause: clause.number ?? clause.title ?? "",
      id: issue.id,
      at: (issue.segments ?? []).map((index) => file.document.segments[index].location),
      clauseAt: (clause.segments ?? []).map((index) => file.document.segments[index].location),
    }))),
  };
}

describe("문서 검토 from a workspace file", () => {
  it("reviews a DOCX contract like the same text pasted, and names each issue's article", async () => {
    const file = reviewFileFor(await parse("근로계약서.docx", createDocxParagraphs(EMPLOYMENT_CONTRACT.split("\n"))), "근로계약서.docx");
    const pasted = await reviewContract(EMPLOYMENT_CONTRACT, sources);
    const { review, issues } = await locatedIssues(file);
    expect(review.document.type).toBe("employment");
    // Same engine, same findings: only positions are added.
    const findings = (value: typeof review) => value.clauses.map((clause) => [clause.number, clause.issues.map((issue) => [issue.id, issue.fact])]);
    expect(findings(review)).toEqual(findings(pasted));
    expect(issues.find((issue) => issue.id === "dismissal")?.at).toEqual(["제4조 해고"]);
    expect(file.coverage).toMatchObject({ status: "complete", unit: "문단", reviewed: file.coverage.total, unreviewed: 0 });
    expect(file.imagesUnread).toBe(false);
    expect(file.document.version).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("keeps every paragraph of an article that spans several blocks, and a condition kept in a table", async () => {
    const bytes = docx([
      p("용역계약서"),
      p("주식회사 갑과 주식회사 을은 다음과 같이 용역계약을 체결한다."),
      p("제5조(손해배상)"),
      p("을은 계약 위반으로 갑에게 발생한 손해를 배상한다."),
      p("을의 손해배상 책임은 위약금과 별도로 제한 없이 부담한다."),
      table([["항목", "조건"], ["계약 해지", "갑은 최고 없이 즉시 계약을 해지할 수 있다."]]),
    ].join(""));
    const file = reviewFileFor(await parse("용역계약서.docx", bytes), "용역계약서.docx");
    const { issues } = await locatedIssues(file);
    const article = issues.filter((issue) => issue.clause === "제5조");
    expect(article.length).toBeGreaterThan(0);
    // Heading, both paragraphs and the table after them belong to 제5조 (as when pasted);
    // each issue points at the block its sentence is in.
    expect(new Set(article.flatMap((issue) => issue.clauseAt))).toEqual(new Set(["제5조 손해배상", "제5조 손해배상 · 표 1행", "제5조 손해배상 · 표 2행"]));
    expect(article.find((issue) => issue.id === "unilateral_termination")?.at).toContain("제5조 손해배상 · 표 2행");
    expect(file.document.segments.filter((segment) => segment.location === "제5조 손해배상")).toHaveLength(3);
    expect(file.document.segments.at(-1)).toEqual({ text: "계약 해지 갑은 최고 없이 즉시 계약을 해지할 수 있다.", location: "제5조 손해배상 · 표 2행" });
    // No page is invented for a DOCX.
    expect(file.document.segments.some((segment) => /페이지/u.test(segment.location))).toBe(false);
  });

  it("labels unnumbered paragraphs by position and says images are unread only when the file places one", async () => {
    const plain = reviewFileFor(await parse("약관.docx", createDocxParagraphs(CONSUMER_TERMS.split("\n").map((line) => line.replace(/^제\d+조\([^)]*\)\s*/u, "")))), "약관.docx");
    expect(plain.document.segments[1].location).toBe("2번째 문단");
    expect(plain.imagesUnread).toBe(false);
    const withImage = reviewFileFor(await parse("이미지.docx", createDocxWithOmissions()), "이미지.docx");
    expect(withImage.imagesUnread).toBe(true);
  });

  it("names PDF pages, keeps an article that continues on the next page, and reports a textless PDF as not reviewed", async () => {
    const lines = B2B_SERVICE_CONTRACT.split("\n");
    const pdf = await createUnicodePdf([lines.slice(0, 6).map((text) => ({ text })), lines.slice(6).map((text) => ({ text }))]);
    const file = reviewFileFor(await parse("계약.pdf", pdf), "계약.pdf");
    expect(file.coverage).toMatchObject({ unit: "페이지", total: 2, reviewed: 2, status: "complete" });
    const { issues } = await locatedIssues(file);
    expect(issues.length).toBeGreaterThan(0);
    expect(new Set(issues.flatMap((issue) => issue.at))).toEqual(new Set(["1페이지", "2페이지"].filter((page) => issues.some((issue) => issue.at.includes(page)))));
    expect(issues.every((issue) => issue.at.every((place) => /^\d페이지$/u.test(place)))).toBe(true);

    const scanned = reviewFileFor(await parse("스캔.pdf", await createUnicodePdf([[], []])), "스캔.pdf");
    expect(scanned.coverage.status).toBe("excluded");
    expect(scanned.coverage.note).toContain("스캔하거나 이미지로 된 PDF");
    expect(scanned.document.segments).toHaveLength(0);
  });

  it("names PPTX slides", async () => {
    const file = reviewFileFor(await parse("약관.pptx", createPptxSlides([["서비스 이용약관"], CONSUMER_TERMS.split("\n").slice(1)])), "약관.pptx");
    expect(new Set(file.document.segments.map((segment) => segment.location))).toEqual(new Set(["1P", "2P"]));
    expect(file.coverage).toMatchObject({ unit: "슬라이드", total: 2, reviewed: 2 });
  });

  it("reviews sentence rows of a sheet with their range and sets raw data rows aside", async () => {
    const terms = await createXlsx({
      계약조건: [["조항", "내용"], ["제8조 자동 갱신", "별도의 해지 의사표시가 없으면 계약은 1년 단위로 자동 연장된다."], ["제9조 해지", "회사는 언제든지 계약을 해지할 수 있다."]],
      매출: [["월", "매출", "비용"], ["1월", 1200, 800], ["2월", 1300, 900]],
    });
    const file = reviewFileFor(await parse("계약조건.xlsx", terms), "계약조건.xlsx");
    expect(file.document.segments).toEqual([
      { text: "제8조 자동 갱신 별도의 해지 의사표시가 없으면 계약은 1년 단위로 자동 연장된다.", location: "계약조건 / A2:B2" },
      { text: "제9조 해지 회사는 언제든지 계약을 해지할 수 있다.", location: "계약조건 / A3:B3" },
    ]);
    expect(file.coverage).toMatchObject({ status: "complete", unit: "행", reviewed: 2, excluded: 4 });

    const raw = reviewFileFor(await parse("매출.csv", strToU8("월,매출,비용,담당\n1월,1200,800,김철수\n2월,1300,900,이영희\n")), "매출.csv");
    expect(raw.coverage.status).toBe("excluded");
    expect(raw.coverage.note).toContain("계약·규정 성격의 문장을 찾지 못했습니다");
  });

  it("stops at the bound in document order and counts what was left, never sending a silent cut", async () => {
    const paragraphs = Array.from({ length: 1400 }, (_, index) => `제${index + 1}조(조항) 회사는 이 조항에 따라 상대방에게 서비스를 제공하며 상대방은 이에 따른 대가를 지급하여야 한다. 세부 사항은 별도 합의로 정한다.`);
    const file = reviewFileFor(await parse("긴계약.docx", createDocxParagraphs(paragraphs)), "긴계약.docx");
    const sent = file.document.segments.reduce((sum, segment) => sum + segment.text.length, 0);
    expect(sent).toBeLessThanOrEqual(LAW_REVIEW_FILE_MAX_CHARS);
    expect(file.coverage.status).toBe("partial");
    expect(file.coverage.reviewed + file.coverage.unreviewed).toBe(1400);
    expect(file.coverage.unreviewed).toBeGreaterThan(0);
    expect(file.coverage.reasons[0]).toContain(`처리 한도`);
    expect(file.coverage.reasons[0]).toContain(`${file.coverage.unreviewed.toLocaleString("ko-KR")}개 문단`);
    // What was sent is the start of the document, in order.
    expect(file.document.segments[0].location).toBe("제1조 조항");
    expect(file.document.segments.at(-1)!.location).toBe(`제${file.coverage.reviewed}조 조항`);
  });

  it("sends only identity and text segments: no bytes, styles, media or locators", async () => {
    const terms = await createXlsx({ 계약조건: [["제8조 자동 갱신", "별도의 해지 의사표시가 없으면 계약은 1년 단위로 자동 연장된다."]] });
    for (const file of [
      reviewFileFor(await parse("계약조건.xlsx", terms), "계약조건.xlsx"),
      reviewFileFor(await parse("이미지.docx", createDocxWithOmissions()), "이미지.docx"),
    ]) {
      expect(Object.keys(file.document).sort()).toEqual(["id", "kind", "name", "segments", "version"]);
      for (const segment of file.document.segments) expect(Object.keys(segment).sort()).toEqual(["location", "text"]);
      expect(JSON.stringify(file.document)).not.toMatch(/"(?:style|template|data|media|bytes|nodeId|quote|spans)"/u);
    }
  });
});
