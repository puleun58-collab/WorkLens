import type { AiRequest } from "@/domain/ai";
import { MONTHS, REGIONS, forecastValue, salesValue, type EvalFormat } from "./fixtures";

/**
 * Fixed evaluation set.
 *
 * Every case names the evidence that must be retrieved, expressed as text the
 * winning evidence has to contain plus an optional locator constraint. That
 * keeps scoring deterministic: no model judgement is involved in deciding
 * whether retrieval and grounding found the right place in the document.
 */
export type EvalKind = "fact" | "numeric" | "date" | "percentage" | "cross-section" | "sheet" | "slide" | "heading" | "unanswerable";

export interface EvalCase {
  id: string;
  format: EvalFormat;
  kind: EvalKind;
  request: AiRequest;
  /** Substrings the correct evidence must contain; all must match one node. */
  answerContains: string[];
  /** Optional locator constraints on the correct evidence. */
  sheet?: string;
  slide?: number;
  page?: number;
  /** True when the document cannot answer: nothing may be produced. */
  refuse?: boolean;
}

const ask = (question: string): AiRequest => ({ operation: "ask", question });

function xlsxCases(): EvalCase[] {
  const cases: EvalCase[] = [];
  // Numeric lookups spread over every month so no answer sits near the top.
  MONTHS.forEach((month, monthIndex) => {
    const region = REGIONS[monthIndex % REGIONS.length];
    const regionIndex = REGIONS.indexOf(region);
    cases.push({
      id: `xlsx-sales-${monthIndex + 1}`,
      format: "xlsx",
      kind: "numeric",
      request: ask(`${month} ${region} 매출은 얼마인가요?`),
      answerContains: [String(salesValue(monthIndex, regionIndex))],
      sheet: "매출",
    });
  });
  [3, 7, 10].forEach((monthIndex) => {
    cases.push({
      id: `xlsx-forecast-${monthIndex + 1}`,
      format: "xlsx",
      kind: "sheet",
      request: ask(`Forecast 시트의 ${MONTHS[monthIndex]} 예상값은 얼마인가요?`),
      answerContains: [String(forecastValue(monthIndex))],
      sheet: "Forecast",
    });
    cases.push({
      id: `xlsx-achievement-${monthIndex + 1}`,
      format: "xlsx",
      kind: "percentage",
      request: ask(`Forecast 시트 ${MONTHS[monthIndex]} 달성률은 몇 %인가요?`),
      answerContains: [`${(80 + monthIndex).toFixed(1)}%`],
      sheet: "Forecast",
    });
  });
  REGIONS.forEach((region) => {
    cases.push({
      id: `xlsx-rate-${region}`,
      format: "xlsx",
      kind: "sheet",
      request: ask(`운송단가 시트의 ${region} 단가는 얼마인가요?`),
      answerContains: [String({ 서울: 145000, 부산: 90000, 대구: 70000, 인천: 60000 }[region])],
      sheet: "운송단가",
    });
  });
  cases.push({
    id: "xlsx-rate-date",
    format: "xlsx",
    kind: "date",
    request: ask("운송단가 기준일은 언제인가요?"),
    answerContains: ["2026-08-01"],
    sheet: "운송단가",
  });
  cases.push({
    id: "xlsx-cross-section",
    format: "xlsx",
    kind: "cross-section",
    request: ask("7월과 8월 서울 매출 차이는 얼마인가요?"),
    answerContains: [String(salesValue(7, 0))],
    sheet: "매출",
  });
  cases.push({
    id: "xlsx-unanswerable-address",
    format: "xlsx",
    kind: "unanswerable",
    request: ask("부산 창고의 도로명 주소가 있나요?"),
    answerContains: ["도로명"],
    refuse: true,
  });
  cases.push({
    id: "xlsx-unanswerable-ceo",
    format: "xlsx",
    kind: "unanswerable",
    request: ask("대표이사 이름은 무엇인가요?"),
    answerContains: ["대표이사"],
    refuse: true,
  });
  return cases;
}

function csvCases(): EvalCase[] {
  const cases: EvalCase[] = [];
  REGIONS.forEach((region, regionIndex) => {
    [2, 6, 9, 11].forEach((monthIndex) => {
      cases.push({
        id: `csv-${region}-${monthIndex + 1}`,
        format: "csv",
        kind: "numeric",
        request: ask(`${region} 2026-${String(monthIndex + 1).padStart(2, "0")}-15 금액은 얼마인가요?`),
        answerContains: [String(salesValue(monthIndex, regionIndex))],
      });
    });
    cases.push({
      id: `csv-code-${region}`,
      format: "csv",
      kind: "fact",
      request: ask(`${region} 8월 코드 값은 무엇인가요?`),
      answerContains: [`WL-${regionIndex}7`],
    });
  });
  cases.push({
    id: "csv-unanswerable-quantity",
    format: "csv",
    kind: "unanswerable",
    request: ask("배송 담당자 연락처가 있나요?"),
    answerContains: ["연락처"],
    refuse: true,
  });
  return cases;
}

function pdfCases(): EvalCase[] {
  return [
    { id: "pdf-term-end", format: "pdf", kind: "date", request: ask("When does the agreement term end?"), answerContains: ["2026-12-31"] },
    { id: "pdf-term-start", format: "pdf", kind: "date", request: ask("What is the agreement start date?"), answerContains: ["2026-03-01"] },
    { id: "pdf-fee", format: "pdf", kind: "numeric", request: ask("What is the monthly base fee?"), answerContains: ["145000"] },
    { id: "pdf-penalty", format: "pdf", kind: "percentage", request: ask("What is the late penalty rate?"), answerContains: ["2.5%"] },
    { id: "pdf-scope", format: "pdf", kind: "fact", request: ask("Which hubs are in scope?"), answerContains: ["Incheon"] },
    { id: "pdf-termination", format: "pdf", kind: "fact", request: ask("How much notice is required to terminate?"), answerContains: ["60 days"] },
    { id: "pdf-appendix-12", format: "pdf", kind: "fact", request: ask("What does Appendix 12 cover?"), answerContains: ["Appendix 12"] },
    { id: "pdf-appendix-19", format: "pdf", kind: "fact", request: ask("What does Appendix 19 cover?"), answerContains: ["Appendix 19"] },
    { id: "pdf-title", format: "pdf", kind: "heading", request: ask("What is the title of this document?"), answerContains: ["Service Agreement"] },
    { id: "pdf-unanswerable-insurance", format: "pdf", kind: "unanswerable", request: ask("What is the insurance policy number?"), answerContains: ["insurance policy"], refuse: true },
    { id: "pdf-unanswerable-bank", format: "pdf", kind: "unanswerable", request: ask("Which bank account should we pay into?"), answerContains: ["bank account"], refuse: true },
  ];
}

function docxCases(): EvalCase[] {
  return [
    { id: "docx-risk", format: "docx", kind: "heading", request: ask("리스크 항목에는 무엇이 있나요?"), answerContains: ["유가 변동"] },
    { id: "docx-contract-amount", format: "docx", kind: "numeric", request: ask("연간 계약 금액은 얼마인가요?"), answerContains: ["1,740,000"] },
    { id: "docx-payment-day", format: "docx", kind: "fact", request: ask("대금 지급일은 언제인가요?"), answerContains: ["25일"] },
    { id: "docx-written-date", format: "docx", kind: "date", request: ask("보고서 작성일은 언제인가요?"), answerContains: ["2026-09-15"] },
    { id: "docx-transport-fee", format: "docx", kind: "numeric", request: ask("표에 있는 운송비 금액은 얼마인가요?"), answerContains: ["145000"] },
    { id: "docx-storage-fee", format: "docx", kind: "numeric", request: ask("표에 있는 보관비 금액은 얼마인가요?"), answerContains: ["52000"] },
    { id: "docx-title", format: "docx", kind: "heading", request: ask("이 보고서의 제목은 무엇인가요?"), answerContains: ["3분기 운영 보고서"] },
    { id: "docx-detail-20", format: "docx", kind: "fact", request: ask("운영 세부 항목 20은 어떤 내용인가요?"), answerContains: ["운영 세부 항목 20"] },
    { id: "docx-detail-24", format: "docx", kind: "fact", request: ask("운영 세부 항목 24는 어떤 내용인가요?"), answerContains: ["운영 세부 항목 24"] },
    { id: "docx-unanswerable-headcount", format: "docx", kind: "unanswerable", request: ask("전체 직원 수는 몇 명인가요?"), answerContains: ["직원 수"], refuse: true },
    { id: "docx-unanswerable-email", format: "docx", kind: "unanswerable", request: ask("담당자 이메일 주소가 있나요?"), answerContains: ["이메일"], refuse: true },
  ];
}

function pptxCases(): EvalCase[] {
  return [
    { id: "pptx-oil-forecast", format: "pptx", kind: "slide", request: ask("향후 13주 유가 전망은 어떤 내용인가요?"), answerContains: ["82.4달러"] },
    { id: "pptx-risk", format: "pptx", kind: "slide", request: ask("리스크 대응 계획은 무엇인가요?"), answerContains: ["대체 운송사"] },
    { id: "pptx-august-sales", format: "pptx", kind: "numeric", request: ask("8월 서울 매출은 얼마인가요?"), answerContains: ["158000"] },
    { id: "pptx-achievement", format: "pptx", kind: "percentage", request: ask("8월 달성률은 몇 %인가요?"), answerContains: ["87.0%"] },
    { id: "pptx-written-date", format: "pptx", kind: "date", request: ask("이 자료 작성일은 언제인가요?"), answerContains: ["2026-09-15"] },
    { id: "pptx-title", format: "pptx", kind: "heading", request: ask("이 발표자료의 제목은 무엇인가요?"), answerContains: ["3분기 사업 계획"] },
    { id: "pptx-weekly-10", format: "pptx", kind: "fact", request: ask("운영 현황 10의 주간 배송 건수는?"), answerContains: ["1353건"] },
    { id: "pptx-weekly-18", format: "pptx", kind: "fact", request: ask("운영 현황 18의 주간 배송 건수는?"), answerContains: ["1489건"] },
    { id: "pptx-unanswerable-budget", format: "pptx", kind: "unanswerable", request: ask("내년 광고 예산은 얼마인가요?"), answerContains: ["광고 예산"], refuse: true },
    { id: "pptx-unanswerable-vendor", format: "pptx", kind: "unanswerable", request: ask("계약한 보험사 이름은 무엇인가요?"), answerContains: ["보험사"], refuse: true },
  ];
}

export const EVAL_CASES: EvalCase[] = [
  ...xlsxCases(),
  ...csvCases(),
  ...pdfCases(),
  ...docxCases(),
  ...pptxCases(),
];

/**
 * Pasted-text polish cases. Scored on preservation, not on how much changed:
 * every protected token has to survive verbatim, the pasted line structure has
 * to come back identical, and an already-natural sentence has to come back
 * unchanged rather than rewritten for its own sake.
 */
export interface PolishTextCase {
  id: string;
  text: string;
  /** Substrings that must appear unchanged in the polished text. */
  keep: string[];
  /** True when the input is already natural and must not be rewritten. */
  expectUnchanged?: boolean;
}

export const POLISH_TEXT_CASES: PolishTextCase[] = [
  {
    id: "polish-text-sentence",
    text: "본 사안에 대해서는 관련 부서와의 협의를 통해 진행하고자 하는 방향으로 검토가 이루어지고 있습니다.",
    keep: [],
  },
  {
    id: "polish-text-multi-sentence",
    text: "3분기 운영 실적에 대한 검토가 진행되었습니다. 결론적으로 말씀드리면 주요 지표는 계획 대비 안정적인 수준을 유지하고 있는 상황입니다.",
    keep: ["3분기"],
  },
  {
    id: "polish-text-paragraphs",
    text: [
      "안녕하세요. 물류운영팀 김도현입니다.",
      "",
      "9월 운영 보고와 관련하여 아래와 같이 공유드리고자 합니다. 확인 후 회신 부탁드립니다.",
    ].join("\n"),
    keep: ["김도현", "9월"],
  },
  {
    id: "polish-text-email",
    text: "말씀해 주신 부분에 대하여 내부적으로 검토를 진행한 결과, 2026-09-20까지 회신을 드릴 수 있을 것으로 예상됩니다.",
    keep: ["2026-09-20"],
  },
  {
    id: "polish-text-report",
    text: "매출은 1,250만원으로 집계되었으며, 전월 대비 8.9% 증가한 것으로 확인되고 있는 상황입니다.",
    keep: ["1,250만원", "8.9%"],
  },
  {
    id: "polish-text-notice",
    text: "사내 시스템 점검이 예정되어 있어 해당 시간 동안에는 서비스 이용이 제한될 수 있다는 점을 안내드리고자 합니다.",
    keep: [],
  },
  {
    id: "polish-text-bullets",
    text: [
      "- 운영 지표는 계획 대비 안정적으로 유지되고 있는 것으로 파악됩니다.",
      "- 상세 내용은 https://intra.example.com/report 에서 확인이 가능합니다.",
      "1. 다음 회의는 2026-09-25에 진행될 예정입니다.",
    ].join("\n"),
    keep: ["https://intra.example.com/report", "2026-09-25"],
  },
  {
    id: "polish-text-natural",
    text: "오늘 회의에서 합의한 일정대로 진행하겠습니다.",
    keep: ["오늘 회의에서 합의한 일정대로 진행하겠습니다."],
    expectUnchanged: true,
  },
];
