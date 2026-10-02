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
  const review = await reviewContract(file.document.segments, sources, Date.now, undefined, file.document.profile);
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
    expect(file.document.segments.at(-1)).toEqual({ text: "계약 해지 갑은 최고 없이 즉시 계약을 해지할 수 있다.", location: "제5조 손해배상 · 표 2행", batch: 0 });
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
      { text: "제8조 자동 갱신 별도의 해지 의사표시가 없으면 계약은 1년 단위로 자동 연장된다.", location: "계약조건 / A2:B2", batch: 0 },
      { text: "제9조 해지 회사는 언제든지 계약을 해지할 수 있다.", location: "계약조건 / A3:B3", batch: 0 },
    ]);
    expect(file.coverage).toMatchObject({ status: "complete", unit: "행", reviewed: 2, excluded: 4 });

    const raw = reviewFileFor(await parse("매출.csv", strToU8("월,매출,비용,담당\n1월,1200,800,김철수\n2월,1300,900,이영희\n")), "매출.csv");
    expect(raw.coverage.status).toBe("excluded");
    expect(raw.coverage.note).toContain("계약·규정 성격의 문장을 찾지 못했습니다");
  });

  it("reviews short legal sheet and CSV rows with their header context but not raw-data lookalikes", async () => {
    const workbook = await createXlsx({
      계약조건: [["항목", "내용"], ["자동연장", "1년"], ["위약금", "30%"]],
      매출: [["항목", "내용"], ["자동연장", "1년"]],
    });
    const file = reviewFileFor(await parse("표.xlsx", workbook), "표.xlsx");
    expect(file.coverage).toMatchObject({ status: "complete", reviewed: 2, excluded: 3 });
    expect(file.document.segments.map((segment) => segment.location)).toEqual(["계약조건 / A2:B2", "계약조건 / A3:B3"]);
    const { issues } = await locatedIssues(file);
    expect(issues.find((issue) => issue.id === "auto_renewal")?.at).toEqual(["계약조건 / A2:B2"]);
    expect(issues.find((issue) => issue.id === "penalty")?.at).toEqual(["계약조건 / A3:B3"]);
    const csv = reviewFileFor(await parse("계약조건.csv", strToU8("항목,기간\n자동연장,1년\n위약금,30%\n")), "계약조건.csv");
    expect(csv.coverage).toMatchObject({ status: "complete", reviewed: 2, excluded: 1 });
    expect(new Set((await locatedIssues(csv)).issues.map((issue) => issue.id))).toEqual(new Set(["auto_renewal", "penalty"]));
    const raw = reviewFileFor(await parse("매출.csv", strToU8("항목,기간\n자동연장,1년\n")), "매출.csv");
    expect(raw.coverage.status).toBe("excluded");
  });

  it.each([
    ["계약조건", ["책임한도", "월 이용료 1개월분"], "보험통계", ["책임한도", "100"]],
    ["계약조건", ["배상한도", "계약금액의 10%"], "매출", ["배상한도", "10%"]],
    ["계약조건", ["계약기간", "2026.01.01 ~ 2026.12.31"], "재고현황", ["계약기간", "1년"]],
    ["개인정보 처리조건", ["보유기간", "계약 종료 후 3년"], "재고현황", ["보유기간", "3년"]],
    ["계약조건", ["개인정보 보관", "5년"], "로그", ["개인정보 보관", "5년"]],
    ["계약조건", ["해지통보", "30일 전"], "일정", ["해지통보", "30일 전"]],
    ["계약조건", ["관할법원", "서울중앙지방법원"], "주소록", ["관할법원", "서울중앙지방법원"]],
    ["계약조건", ["관할법원", "서울중앙지방법원"], "계약조건", ["관할법원", "미정"]],
  ])("reads the condition row under %s %j, but not under %s %j, and never makes it an issue by itself", async (sheet, row, otherSheet, otherRow) => {
    const positive = reviewFileFor(await parse("조건.xlsx", await createXlsx({ [sheet]: [["항목", "내용"], row] })), "조건.xlsx");
    expect(positive.document.segments.map((segment) => segment.location)).toEqual([`${sheet} / A2:B2`]);
    expect((await locatedIssues(positive)).issues).toEqual([]);
    const negative = reviewFileFor(await parse("값.xlsx", await createXlsx({ [otherSheet]: [["항목", "값"], otherRow] })), "값.xlsx");
    expect(negative.coverage.status).toBe("excluded");
  });

  it("keeps every issue type when one issue repeats hundreds of times, and spreads the repeats front to back", async () => {
    const filler = (n: number) => `제${n}조(업무 협의) 당사자는 업무 일정과 산출물의 범위를 매월 협의하여 정하고, 협의 결과는 서면으로 기록하여 각자 보관한다. 일정이 바뀌는 경우 담당자는 변경 사유와 새 일정을 함께 알린다.`;
    const paragraphs = Array.from({ length: 1500 }, (_, index) => index % 7 === 3 ? `제${index + 1}조(위약금) 위반자는 위약금 ${index + 1}만원을 지급한다.` : filler(index + 1));
    paragraphs[701] = "제702조(면책) 회사는 일체의 책임을 지지 않는다.";
    paragraphs[1388] = "제1389조(갱신) 통지가 없으면 계약은 자동 갱신된다.";
    paragraphs[1496] = "제1497조(정보) 회사는 개인정보를 제3자에게 제공할 수 있다.";
    const file = reviewFileFor(await parse("반복.docx", createDocxParagraphs(paragraphs)), "반복.docx");
    expect(file.scan.candidates).toBeGreaterThan(200);
    const sent = file.document.segments.map((segment) => segment.location);
    for (const place of ["제702조 면책", "제1389조 갱신", "제1497조 정보"]) expect(sent).toContain(place);
    const penalties = sent.filter((place) => place.endsWith("위약금")).map((place) => Number(/\d+/u.exec(place)![0]));
    expect(Math.min(...penalties)).toBeLessThan(150);
    expect(Math.max(...penalties)).toBeGreaterThan(1350);
    expect(penalties.some((n) => n > 600 && n < 900)).toBe(true);
    expect(file.document.segments.reduce((sum, segment) => sum + segment.text.length, 0)).toBeLessThanOrEqual(LAW_REVIEW_FILE_MAX_CHARS);
  });

  it("distributes bounded review through the last article and counts every omitted paragraph", async () => {
    const paragraphs = Array.from({ length: 1400 }, (_, index) => `제${index + 1}조(조항) 회사는 이 조항에 따라 상대방에게 서비스를 제공하며 상대방은 이에 따른 대가를 지급하여야 한다. 세부 사항은 별도 합의로 정한다.`);
    const file = reviewFileFor(await parse("긴계약.docx", createDocxParagraphs(paragraphs)), "긴계약.docx");
    const sent = file.document.segments.reduce((sum, segment) => sum + segment.text.length, 0);
    expect(sent).toBeLessThanOrEqual(LAW_REVIEW_FILE_MAX_CHARS);
    expect(file.coverage.status).toBe("partial");
    expect(file.coverage.reviewed + file.coverage.unreviewed).toBe(1400);
    expect(file.coverage.unreviewed).toBeGreaterThan(0);
    expect(file.coverage.reasons[0]).toContain(`처리 한도`);
    expect(file.coverage.reasons[0]).toContain(`${file.coverage.unreviewed.toLocaleString("ko-KR")}개 문단`);
    // The last range reaches the end rather than silently stopping at a prefix.
    expect(file.document.segments[0].location).toBe("제1조 조항");
    expect(file.document.segments.at(-1)!.location).toBe("제1400조 조항");
    expect(new Set(file.document.segments.map((segment) => segment.batch)).size).toBeGreaterThan(1);
  });

  it("classifies the full parsed document when a defining clause falls in an omitted window", async () => {
    const paragraphs = Array.from({ length: 1400 }, (_, index) =>
      `제${index + 1}조(일반) ${"이 항목은 업무 내용과 진행 시기를 기록하며 적용 순서는 양 당사자가 정한다. 세부 사항은 문서에 따른다. ".repeat(2)}`);
    paragraphs[60] = "제61조(기본) 근로계약 근로자 사용자 임금 근로시간을 정한다.";
    const file = reviewFileFor(await parse("긴규정.docx", createDocxParagraphs(paragraphs)), "긴규정.docx");
    expect(file.coverage.status).toBe("partial");
    expect(file.document.segments.some((segment) => segment.text.includes("근로계약 근로자 사용자"))).toBe(false);
    expect(file.document.profile?.type).toBe("employment");
  });

  it("sends only identity and text segments: no bytes, styles, media or locators", async () => {
    const terms = await createXlsx({ 계약조건: [["제8조 자동 갱신", "별도의 해지 의사표시가 없으면 계약은 1년 단위로 자동 연장된다."]] });
    for (const file of [
      reviewFileFor(await parse("계약조건.xlsx", terms), "계약조건.xlsx"),
      reviewFileFor(await parse("이미지.docx", createDocxWithOmissions()), "이미지.docx"),
    ]) {
      expect(Object.keys(file.document).sort()).toEqual(["id", "kind", "name", "profile", "segments", "version"]);
      for (const segment of file.document.segments) expect(Object.keys(segment).sort()).toEqual(["batch", "location", "text"]);
      expect(JSON.stringify(file.document)).not.toMatch(/"(?:style|template|data|media|bytes|nodeId|quote|spans)"/u);
    }
  });
});
