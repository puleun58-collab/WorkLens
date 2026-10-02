import type { FileKind, NormalizedDocument, SourceLocator, SourceRef, TableCell } from "../../src/domain/document";

/** Synthetic documents only. No example claims to be an official statute or judgment. */
export interface GoldFinding {
  issue: string;
  /** Exact location of the triggering sentence, not merely its containing clause. */
  location: string;
  /** Statute/article links expected when the deterministic source has that article. */
  laws?: string[];
  /** Synthetic precedent IDs expected when the deterministic source has a relevant holding. */
  precedents?: string[];
}
export interface ReviewCase {
  id: string;
  kind: FileKind;
  document: NormalizedDocument;
  gold: GoldFinding[];
  coverage: { status: "complete" | "partial" | "excluded"; reviewed?: number; excluded?: number; unreviewed?: number };
}

const prefix = "가상 계약서: 주식회사 가와 주식회사 나는 아래 조건에 합의한다.";
const terms = "서비스 이용약관: 회사와 이용자는 아래 사항에 합의한다.";
const employment = "근로계약서: 회사와 근로자는 아래 근로조건에 합의한다.";
const rules = "취업규칙 및 복무규정: 회사와 근로자는 아래 규정에 따른다.";
const lease = "상가건물 임대차계약서: 임대인과 임차인은 다음과 같이 약정한다.";
const at = (issue: string, location: string, laws?: string[], precedents?: string[]): GoldFinding => ({ issue, location, ...(laws ? { laws } : {}), ...(precedents ? { precedents } : {}) });
const penaltyLaw = "민법:제398조";
const termsLaw = "약관의 규제에 관한 법률:제7조";
const SYNTHETIC_VERSION = "0000000000000001";

function source(id: string, node: number, locator: SourceLocator, label: string): SourceRef {
  return { fileId: id, documentId: id, documentVersion: SYNTHETIC_VERSION, nodeId: `${id}-${node}`, locator, label, quoteHash: `synthetic-${node}` };
}
function paragraphs(id: string, kind: "docx" | "pdf" | "pptx", lines: string[], pages?: number[]): NormalizedDocument {
  return {
    id, fileId: id, version: SYNTHETIC_VERSION, kind, metadata: { fileName: `${id}.${kind}`, ...(kind === "pdf" ? { pageCount: Math.max(...(pages ?? [1])) } : {}) }, warnings: [],
    blocks: lines.map((text, index) => {
      const locator: SourceLocator = kind === "docx" ? { kind, part: "body", block: index }
        : kind === "pdf" ? { kind, page: pages?.[index] ?? 1, spans: [] }
          : { kind, slide: pages?.[index] ?? 1, shape: index + 1 };
      return { type: "paragraph" as const, id: `${id}-${index}`, text, source: source(id, index, locator, `${index + 1}`) };
    }),
  };
}
function table(id: string, kind: "csv" | "xlsx" | "docx", rows: string[][], sheet = "계약조건"): NormalizedDocument {
  const makeCell = (text: string, row: number, column: number): TableCell => {
    const range = `${String.fromCharCode(65 + column)}${row + 1}`;
    const locator: SourceLocator = kind === "csv" ? { kind, record: row + 1, column: column + 1 }
      : kind === "xlsx" ? { kind, sheet, range }
        : { kind, part: "body", block: 0, tableCell: { row, column } };
    return { value: text, display: text, source: source(id, row * 10 + column, locator, range) };
  };
  const first = makeCell(rows[0][0], 0, 0);
  return { id, fileId: id, version: SYNTHETIC_VERSION, kind, metadata: { fileName: `${id}.${kind}` }, warnings: [], blocks: [{ type: "table", id: `${id}-table`, source: first.source, rows: rows.map((row, index) => row.map((text, column) => makeCell(text, index, column))) }] };
}
export function paragraphCase(id: string, kind: "docx" | "pdf" | "pptx", lines: string[], gold: GoldFinding[], pages?: number[], coverage: ReviewCase["coverage"] = { status: "complete" }): ReviewCase {
  return { id, kind, document: paragraphs(id, kind, lines, pages), gold, coverage };
}
export function tableCase(id: string, kind: "csv" | "xlsx" | "docx", rows: string[][], gold: GoldFinding[], coverage: ReviewCase["coverage"], sheet?: string): ReviewCase {
  return { id, kind, document: table(id, kind, rows, sheet), gold, coverage };
}

export const neutral = (n: number) => `제${n}조(검수) 당사자는 작업물을 확인한 뒤 인수 여부를 서면으로 알린다.`;
const longLines = [prefix, ...Array.from({ length: 2200 }, (_, index) => index === 1989 ? "제1990조(위약금) 위반자는 위약금 100만원을 지급한다." : neutral(index + 1)), "제2201조(위약금) 위반자는 위약금 200만원을 지급한다."];

/** A neutral article long enough that 1,500 of them exceed the request bound (about 150,000 characters). */
export const filler = (n: number) => `제${n}조(업무 협의) 당사자는 업무 일정과 산출물의 범위를 매월 협의하여 정하고, 협의 결과는 서면으로 기록하여 각자 보관한다. 일정이 바뀌는 경우 담당자는 변경 사유와 새 일정을 함께 알린다.`;
/**
 * A long contract of `filler` articles 1..count with some replaced. Article n is reviewable unit n
 * (unit 0 is the preamble). Distributed sampling sends roughly the first two thirds of each of its
 * 20 bands (75 units each at 1,500 articles), so units about 55-74 past a band start fall in its gap.
 */
export function longContract(head: string, count: number, replaced: Record<number, string>): string[] {
  return [head, ...Array.from({ length: count }, (_, index) => replaced[index + 1] ?? filler(index + 1))];
}
const boilerplate = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [index * 10 + 3, `제${index * 10 + 3}조(위약금) 위반자는 위약금 100만원을 지급한다.`]));
const traps = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [index * 25 + 7, index % 3 === 0
  ? `제${index * 25 + 7}조(손해배상) 당사자는 고의 또는 과실로 상대방에게 손해를 입힌 경우 민법에 따라 배상한다.`
  : index % 3 === 1 ? `제${index * 25 + 7}조(해지) 당사자는 상대방이 30일 이상 의무를 이행하지 않으면 서면으로 시정을 요구한 뒤 해지할 수 있다.`
    : `제${index * 25 + 7}조(정보 보호) 당사자는 업무상 알게 된 개인정보를 관련 법령에 따라 안전하게 보호한다.`]));

export const DEVELOPMENT_CASES: ReviewCase[] = [
  paragraphCase("dev-01-penalty", "docx", [prefix, "제1조(위약금) 위반자는 위약금 100만원을 지급한다."], [at("penalty", "제1조 위약금", [penaltyLaw], ["900001"])]),
  paragraphCase("dev-02-multi-penalty", "docx", [prefix, "제1조(위약금) 위약금 100만원을 지급한다.", "제2조(위약금) 위약금 200만원을 지급한다."], [at("penalty", "제1조 위약금", [penaltyLaw], ["900001"]), at("penalty", "제2조 위약금", [penaltyLaw], ["900001"])]),
  paragraphCase("dev-03-exemption", "pdf", [terms, "제1조(면책) 회사는 어떠한 경우에도 책임을 지지 않는다."], [at("exemption", "2페이지", [termsLaw])], [1, 2]),
  paragraphCase("dev-04-employment", "docx", [employment, "제1조(징계) 회사는 경고 없이 즉시 해고할 수 있다."], [at("dismissal", "제1조 징계")]),
  paragraphCase("dev-05-work-rules", "docx", [rules, "제1조(근로시간) 주 근로시간은 60시간으로 정한다."], [at("working_hours", "제1조 근로시간")]),
  paragraphCase("dev-06-privacy", "pptx", [terms, "제1조(정보) 개인정보를 제3자에게 제공한다."], [at("data_transfer", "2P")], [1, 2]),
  paragraphCase("dev-07-lease", "docx", [lease, "제1조(갱신) 임대인은 임차인의 갱신 요구를 거절할 수 있다."], [at("lease_renewal", "제1조 갱신")]),
  paragraphCase("dev-08-normal", "docx", [prefix, "제1조(대금) 갑은 검수 후 대금을 지급한다.", "제2조(종료) 쌍방은 서면 합의로 계약을 종료한다."], []),
  tableCase("dev-09-short-table", "xlsx", [["제8조 위약금", "위약금 100만원을 지급한다."], ["월", "매출"], ["4월", "800"]], [at("penalty", "계약조건 / A1:B1", [penaltyLaw], ["900001"])], { status: "complete", reviewed: 1, excluded: 2 }),
  tableCase("dev-10-data-negative", "csv", [["품목", "금액"], ["A-100", "14000"], ["B-200", "23000"]], [], { status: "excluded", reviewed: 0, excluded: 3 }),
  { ...paragraphCase("dev-11-no-pdf-text", "pdf", [], [], [], { status: "excluded", reviewed: 0, unreviewed: 2 }), document: { ...paragraphs("dev-11-no-pdf-text", "pdf", []), metadata: { fileName: "dev-11-no-pdf-text.pdf", pageCount: 2 } } },
  paragraphCase("dev-12-renewal", "pptx", [terms, "제1조(갱신) 통지가 없으면 계약은 자동 갱신된다."], [at("auto_renewal", "2P")], [1, 2]),
  paragraphCase("dev-13-termination", "docx", [prefix, "제1조(해지) 갑은 최고 없이 즉시 계약을 해지할 수 있다."], [at("unilateral_termination", "제1조 해지")]),
  paragraphCase("dev-14-price", "pdf", [terms, "제1조(요금) 회사는 이용료를 변경할 수 있다."], [at("price_change", "1페이지")]),
  paragraphCase("dev-15-citation-trap", "docx", [prefix, "제1조(관할) 분쟁은 갑의 본점 소재지를 관할하는 법원을 전속 관할로 한다."], [at("jurisdiction", "제1조 관할")]),
  paragraphCase("dev-16-no-over-suggestion", "docx", [employment, "제1조(휴가) 근로자는 연차휴가를 사용하며 사용일은 사전 협의로 정한다."], []),
  paragraphCase("dev-17-long-end", "docx", longLines, [at("penalty", "제1990조 위약금", [penaltyLaw], ["900001"]), at("penalty", "제2201조 위약금", [penaltyLaw], ["900001"])], undefined, { status: "partial" }),
  // Adversarial long documents: each places what matters where distributed sampling does not look.
  paragraphCase("dev-18-sampling-gap", "docx", longContract(prefix, 1500, { 590: "제590조(해지) 갑은 별도의 최고 없이 언제든 계약을 해지할 수 있다." }),
    [at("unilateral_termination", "제590조 해지")], undefined, { status: "partial" }),
  paragraphCase("dev-19-band-middle", "docx", longContract(prefix, 1500, { 818: "제818조(면책) 회사는 어떠한 경우에도 책임을 지지 않는다." }),
    [at("exemption", "제818조 면책")], undefined, { status: "partial" }),
  paragraphCase("dev-20-multi-issue", "docx", longContract(prefix, 1500, {
    62: "제62조(위약금) 위반자는 위약금 300만원을 지급한다.",
    745: "제745조(정보 제공) 회사는 이용자 정보를 관계 회사에 제공할 수 있다.",
    1341: "제1341조(관할) 분쟁은 갑의 본점 소재지를 관할하는 법원을 전속 관할로 한다.",
  }), [at("penalty", "제62조 위약금", [penaltyLaw], ["900001"]), at("data_transfer", "제745조 정보 제공"), at("jurisdiction", "제1341조 관할")], undefined, { status: "partial" }),
  paragraphCase("dev-21-last-tail", "docx", longContract(prefix, 1500, { 1418: "제1418조(갱신) 통지가 없으면 계약은 자동 갱신된다." }),
    [at("auto_renewal", "제1418조 갱신")], undefined, { status: "partial" }),
  paragraphCase("dev-22-repeated-boilerplate", "docx", longContract(prefix, 1500, {
    ...boilerplate,
    668: "제668조(면책) 회사는 일체의 책임을 지지 않는다.",
    1269: "제1269조(해지) 갑은 최고 없이 즉시 계약을 해지할 수 있다.",
  }), [at("penalty", "제3조 위약금", [penaltyLaw], ["900001"]), at("exemption", "제668조 면책"), at("unilateral_termination", "제1269조 해지")], undefined, { status: "partial" }),
  paragraphCase("dev-23-false-positive-trap", "docx", longContract(prefix, 1500, traps), [], undefined, { status: "partial" }),
  paragraphCase("dev-24-candidate-zero", "docx", longContract(prefix, 1500, {}), [], undefined, { status: "partial" }),
  tableCase("dev-25-short-conditions", "xlsx", [["항목", "내용"], ["책임한도", "월 이용료 1개월분"], ["계약기간", "2026.01.01 ~ 2026.12.31"], ["보유기간", "계약 종료 후 3년"],
    ["해지통보", "30일 전"], ["관할법원", "서울중앙지방법원"], ["위약금", "계약금의 20%"]],
  [at("penalty", "계약조건 / A7:B7", [penaltyLaw], ["900001"])], { status: "complete", reviewed: 6, excluded: 1 }),
  tableCase("dev-26-short-negative", "xlsx", [["항목", "값"], ["책임한도", "100"], ["보유기간", "3년"], ["계약기간", "1년"]], [], { status: "excluded", reviewed: 0, excluded: 4 }, "재고현황"),
];

