import { longContract, neutral, paragraphCase, tableCase, type ReviewCase } from "./document-review-cases";

const pdfLines = longContract("가상 서비스 이용약관: 회사와 이용자는 아래 조건에 합의한다.", 1500, { 1046: "제1046조(요금) 회사는 이용료를 변경할 수 있다." });

/** Deliberately excluded from development runs and all baseline updates. */
export const HOLDOUT_CASES: ReviewCase[] = [
  paragraphCase("hold-01-multi-page", "pdf", ["가상 용역계약서: 당사자는 검수와 대금 정산을 약정한다.", neutral(1), "제2조(손해) 실제 손해와 관계없이 위약금 300만원을 지급한다."], [{ issue: "penalty", location: "3페이지", laws: ["민법:제398조"], precedents: ["900001"] }], [1, 2, 3]),
  tableCase("hold-02-csv-terms", "csv", [["조항", "내용"], ["제1조 즉시 해지", "갑은 최고 없이 즉시 계약을 해지할 수 있다."]], [{ issue: "unilateral_termination", location: "2행" }], { status: "complete", reviewed: 1, excluded: 1 }),
  tableCase("hold-03-docx-table", "docx", [["조항", "내용"], ["제1조 위약금", "위약금 50만원을 지급한다."]], [{ issue: "penalty", location: "표 2행", laws: ["민법:제398조"], precedents: ["900001"] }], { status: "complete", reviewed: 2 }),
  paragraphCase("hold-04-foreign-citation-trap", "docx", ["가상 용역계약서: 쌍방은 검수 절차에 합의한다.", "제1조(관할) 분쟁은 갑의 본점 소재지를 관할하는 법원을 전속 관할로 한다."], [{ issue: "jurisdiction", location: "제1조 관할" }]),
  tableCase("hold-05-preserved-data", "xlsx", [["월", "매출"], ["4월", "800"], ["5월", "900"]], [], { status: "excluded", reviewed: 0, excluded: 3 }),
  paragraphCase("hold-06-last-page", "pdf", ["서비스 이용약관: 사업자와 이용자가 아래 조건에 합의한다.", neutral(1), "제2조(면책) 회사는 일체의 책임을 지지 않는다."], [{ issue: "exemption", location: "4페이지", laws: ["약관의 규제에 관한 법률:제7조"] }], [1, 2, 4], { status: "partial", unreviewed: 1 }),
  paragraphCase("hold-07-staff-negative", "docx", ["근로계약서: 회사와 근로자는 다음 조건에 합의한다.", "제1조(근태) 근로자는 사전 협의로 휴가를 사용한다."], []),
  // Added with the candidate scan; written once before any run and never tuned against.
  paragraphCase("hold-08-pdf-gap", "pdf", pdfLines, [{ issue: "price_change", location: "210페이지" }],
    pdfLines.map((_, index) => Math.floor(index / 5) + 1), { status: "partial" }),
  tableCase("hold-09-csv-short-terms", "csv", [["계약 조건", "값"], ["자동연장", "1년"], ["배상한도", "계약금액의 10%"], ["개인정보 보관", "5년"]],
    [{ issue: "auto_renewal", location: "2행" }], { status: "complete", reviewed: 3, excluded: 1 }),
  paragraphCase("hold-10-repeat-then-tail", "docx", longContract("가상 용역계약서: 주식회사 가와 주식회사 나는 아래 조건에 합의한다.", 1500, {
    ...Object.fromEntries(Array.from({ length: 120 }, (_, index) => [index * 12 + 5, `제${index * 12 + 5}조(관할) 분쟁은 갑의 본점 소재지를 관할하는 법원을 전속 관할로 한다.`])),
    1447: "제1447조(정보) 회사는 업무 데이터를 협력 업체에 제공할 수 있다.",
  }), [{ issue: "jurisdiction", location: "제5조 관할" }, { issue: "data_transfer", location: "제1447조 정보" }], undefined, { status: "partial" }),
  tableCase("hold-11-raw-insurance", "xlsx", [["항목", "값"], ["책임한도", "100"], ["보유기간", "3년"]], [], { status: "excluded", reviewed: 0, excluded: 3 }, "보험통계"),
];
