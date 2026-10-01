import { neutral, paragraphCase, tableCase, type ReviewCase } from "./document-review-cases";

/** Deliberately excluded from development runs and all baseline updates. */
export const HOLDOUT_CASES: ReviewCase[] = [
  paragraphCase("hold-01-multi-page", "pdf", ["가상 용역계약서: 당사자는 검수와 대금 정산을 약정한다.", neutral(1), "제2조(손해) 실제 손해와 관계없이 위약금 300만원을 지급한다."], [{ issue: "penalty", location: "3페이지", laws: ["민법:제398조"], precedents: ["900001"] }], [1, 2, 3]),
  tableCase("hold-02-csv-terms", "csv", [["조항", "내용"], ["제1조 즉시 해지", "갑은 최고 없이 즉시 계약을 해지할 수 있다."]], [{ issue: "unilateral_termination", location: "2행" }], { status: "complete", reviewed: 1, excluded: 1 }),
  tableCase("hold-03-docx-table", "docx", [["조항", "내용"], ["제1조 위약금", "위약금 50만원을 지급한다."]], [{ issue: "penalty", location: "표 2행", laws: ["민법:제398조"], precedents: ["900001"] }], { status: "complete", reviewed: 2 }),
  paragraphCase("hold-04-foreign-citation-trap", "docx", ["가상 용역계약서: 쌍방은 검수 절차에 합의한다.", "제1조(관할) 분쟁은 갑의 본점 소재지를 관할하는 법원을 전속 관할로 한다."], [{ issue: "jurisdiction", location: "제1조 관할" }]),
  tableCase("hold-05-preserved-data", "xlsx", [["월", "매출"], ["4월", "800"], ["5월", "900"]], [], { status: "excluded", reviewed: 0, excluded: 3 }),
  paragraphCase("hold-06-last-page", "pdf", ["서비스 이용약관: 사업자와 이용자가 아래 조건에 합의한다.", neutral(1), "제2조(면책) 회사는 일체의 책임을 지지 않는다."], [{ issue: "exemption", location: "4페이지", laws: ["약관의 규제에 관한 법률:제7조"] }], [1, 2, 4], { status: "partial", unreviewed: 1 }),
  paragraphCase("hold-07-staff-negative", "docx", ["근로계약서: 회사와 근로자는 다음 조건에 합의한다.", "제1조(근태) 근로자는 사전 협의로 휴가를 사용한다."], []),
];
