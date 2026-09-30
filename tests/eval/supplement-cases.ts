import type { SupplementCheck, SupplementFileRole } from "@/domain/supplement";

/**
 * Fixed quality set for 보완. Every case states, in human terms, what must be
 * reported, what must not be, and what is acceptable either way. Nothing here
 * compares wording: a finding is identified by its check, scope and location.
 */

export type SupplementEvalCategory =
  | "normal"
  | "missing"
  | "rebuttal"
  | "semantic"
  | "multi"
  | "conflict"
  | "partial"
  | "large"
  | "linking";

export interface EvalFile {
  name: string;
  slides?: string[][];
  /** PDF pages; the first line of each page is set as a heading. An empty page has no text layer. */
  pages?: string[][];
  sheets?: Array<{ name: string; rows: Array<Array<string | number | null>>; hidden?: boolean; percent?: number[] }>;
  /** Word body: a paragraph, a styled heading, or a table (first row is the header). */
  docx?: Array<string | { heading: string; level?: number } | { table: string[][] }>;
  /** Adds an unread chart part to a deck. */
  chart?: boolean;
}

export interface Expected {
  check: SupplementCheck;
  scope?: "all" | "report" | "conflict";
  /** Substring of one of the finding's locations, e.g. "2P" or "Summary / F5". */
  at?: string;
  status?: "missing" | "unverified";
}

export interface SupplementEvalCase {
  id: string;
  purpose: string;
  category: SupplementEvalCategory;
  files: EvalFile[];
  /** Must be reported. */
  must?: Expected[];
  /** Must not be reported (critical or warning). `{ check: "any" }`-style blanket bans use `quiet`. */
  mustNot?: Expected[];
  /** Normal material: no 중요/확인 필요 finding at all. 참고 is tolerated as over-suggestion (minor). */
  quiet?: boolean;
  /** Acceptable either way; never counted as FP or FN. */
  allowed?: Expected[];
  /** Evidence (report/conflict) must come from this file… */
  linkFrom?: string;
  /** …and never from this one (other period, other party, raw data). */
  neverLinkFrom?: string;
  /** Expected coverage of each file, in upload order. */
  coverage?: Array<{ total: number; analyzed?: number; complete: boolean }>;
  roles?: SupplementFileRole[];
  /** The expected outcome depends on the model's meaning check; without it the case is only checked for critical failures. */
  needsModel?: boolean;
}

const REPORT = { name: "월간보고.pptx", slides: [["2026년 9월 월간 보고", "물류 운영 현황"], ["비용 현황", "물류비가 전월 대비 18% 증가했습니다."]] };
const SUMMARY_ROWS: Array<Array<string | number | null>> = [
  ["2026년 9월 물류 실적 (단위: 백만원)"], [],
  ["구분", "목표", "실적", "달성률", "전월", "전월 대비 증감률"],
  ["매출", 1200, 1250, "104%", 1180, 0.059],
  ["물류비", 400, 475, "119%", 400, 0.187],
  ["인건비", 300, 305, "102%", 298, 0.023],
];
const raw: Array<Array<string | number>> = [["일자", "거래처", "금액"]];
for (let index = 0; index < 30_000; index += 1) raw.push([`2026-09-${String((index % 28) + 1).padStart(2, "0")}`, `거래처${index % 50}`, 1000 + (index % 97)]);

export const SUPPLEMENT_EVAL_CASES: SupplementEvalCase[] = [
  // ── Normal material: nothing important to add ──────────────────────────
  { id: "N01", category: "normal", purpose: "정상 KPI 실적: 대응·담당·일정을 요구하지 않음", quiet: true,
    files: [{ name: "실적보고.pptx", slides: [["3분기 영업 실적 보고", "3분기 실적을 보고드립니다."], ["매출 실적", "매출 1,250억 원, 목표 1,200억 원 대비 104% 달성", "영업이익 전년 동기 대비 3% 증가"], ["고객 지표", "고객 만족도 88점 (목표 85점, 전년 84점)"], ["향후 전망", "4분기에도 목표 수준의 실적이 유지될 것으로 예상됩니다. 수주 잔고 1,800억 원 확보로 매출 기반이 안정적입니다."]] }] },
  { id: "N02", category: "normal", purpose: "원인·영향·대응·담당·일정이 모두 있는 이슈 보고", quiet: true,
    files: [{ name: "이슈보고.pptx", slides: [["9월 이슈 보고", "주요 이슈를 공유합니다."], ["납기 이슈", "고객사 A 납기 지연 12건 발생", "원인: 설비 고장으로 생산 라인 2일 중단", "영향: 고객 클레임 3건, 지체상금 1,200만원 예상"], ["대응 계획", "예비 설비 확보 및 정기 점검 강화", "담당: 생산팀 김OO 팀장", "완료 목표: 2026.10.31"]] }] },
  { id: "N03", category: "normal", purpose: "완성된 비용 PDF", quiet: true, coverage: [{ total: 5, analyzed: 5, complete: true }],
    files: [{ name: "물류비보고.pdf", pages: [["3분기 물류비 보고"], ["물류비 42억 원, 예산 40억 원 대비 5% 초과", "전분기 대비 18% 증가"], ["증가 원인: 유가 상승과 운송거리 증가"], ["영향: 영업이익률 0.3%p 하락"], ["대응: 운송사 단가 재협상 (물류팀, 2026.11.30까지)"]] }] },
  { id: "N04", category: "large", purpose: "숫자가 많은 31장 정상 PPT", quiet: true, coverage: [{ total: 31, analyzed: 31, complete: true }],
    files: [{ name: "연간실적.pptx", slides: [["연간 운영 실적", "연간 운영 실적을 정리했습니다."], ...Array.from({ length: 30 }, (_, index) => [`${index + 1}월 실적`, `처리 건수 ${1000 + index}건 (목표 1,000건 대비 달성)`, `평균 처리시간 ${3 + (index % 3)}일 (전월 ${3 + ((index + 1) % 3)}일)`])] }] },
  { id: "N05", category: "normal", purpose: "비고 열에 원인이 있는 Excel Summary", quiet: true,
    files: [{ name: "실적.xlsx", sheets: [{ name: "Summary", percent: [6], rows: SUMMARY_ROWS.map((row, index) => index === 2 ? [...row, "비고"] : index === 4 ? [...row, "유가 상승·물동량 증가 (일회성 아님)"] : row) }] }] },
  { id: "N06", category: "multi", purpose: "보고자료와 집계가 모두 충분한 복수 파일", quiet: true,
    files: [{ name: "월간보고.pptx", slides: [["2026년 9월 월간 보고", "현황"], ["비용", "물류비가 전월 대비 18% 증가했습니다.", "유가 상승과 운송거리 증가로 비용 확대", "운송사 단가 재협상 예정 (물류팀, 11월)"]] },
      { name: "실적.xlsx", sheets: [{ name: "Summary", rows: [["2026년 9월 물류 실적 (단위: 백만원)"], ["구분", "목표", "실적"], ["물류비", 400, 475], ["인건비", 300, 303]] }] }] },

  // ── Clear gaps ─────────────────────────────────────────────────────────
  { id: "M01", category: "missing", purpose: "비용 18% 증가, 원인 없음", must: [{ check: "cause", at: "2P" }], mustNot: [{ check: "owner" }, { check: "response" }],
    files: [{ name: "비용보고.pptx", slides: [["3분기 비용 보고", "운영 현황을 공유합니다."], ["비용 현황", "3분기 물류비가 전분기 대비 18% 증가했습니다."], ["향후 계획", "운송사 단가 재협상을 11월까지 물류팀이 진행할 예정입니다."]] }] },
  { id: "M02", category: "missing", purpose: "이슈만 있고 대응·영향 없음", must: [{ check: "response", at: "2P" }, { check: "impact", at: "2P" }],
    files: [{ name: "이슈보고.pptx", slides: [["9월 이슈 보고", "주요 이슈를 공유합니다."], ["납기 이슈", "고객사 A 납기 지연 12건 발생"], ["기타", "10월 생산 계획은 전월과 동일합니다."]] }] },
  { id: "M03", category: "missing", purpose: "근거 없는 결론", must: [{ check: "conclusion", at: "2P" }],
    files: [{ name: "비용현황.pptx", slides: [["비용 현황 보고", "3분기 운송비 42억 원 집행"], ["결론", "향후 비용 부담은 제한적일 것으로 예상됩니다."]] }] },
  { id: "M04", category: "missing", purpose: "프로젝트 조치의 담당·일정 없음", must: [{ check: "owner", at: "3P" }],
    files: [{ name: "ERP 프로젝트 진행 보고.pptx", slides: [["ERP 구축 프로젝트 진행 보고", "전체 진행률 65%"], ["이슈", "데이터 이관 지연 2주 발생"], ["조치", "이관 스크립트 재작성 추진", "추가 인력 투입 검토 중"]] }] },
  { id: "M05", category: "missing", purpose: "달성률만 있고 목표 없음 (Excel)", must: [{ check: "target", at: "Summary" }],
    files: [{ name: "매출.xlsx", sheets: [{ name: "Summary", rows: [["2026년 9월 매출 실적 (단위: 백만원)"], ["구분", "실적", "달성률"], ["국내 매출", 1250, "104%"], ["해외 매출", 830, "92%"]] }] }] },
  { id: "M06", category: "missing", purpose: "기간·단위가 어디에도 없는 비용 시트", must: [{ check: "period" }, { check: "unit" }],
    files: [{ name: "비용보고.xlsx", sheets: [{ name: "비용", rows: [["항목", "목표", "실적"], ["운송비", 400, 410], ["보관비", 120, 118]] }] }] },
  { id: "M07", category: "missing", purpose: "이슈 레지스터의 조치 없는 진행 항목", must: [{ check: "response", at: "이슈관리" }],
    files: [{ name: "이슈.xlsx", sheets: [{ name: "이슈관리", rows: [["2026년 9월 이슈 현황"], ["이슈", "영향", "상태", "조치"], ["A라인 설비 고장", "생산 2일 지연", "진행", ""], ["원자재 입고 지연", "납기 3건 지연", "완료", ""], ["품질 클레임", "고객 1곳", "진행", "공정 점검 (품질팀, 10/15)"]] }] }] },

  // ── Rebuttal: the information exists elsewhere in the same file ────────
  { id: "R01", category: "rebuttal", purpose: "다른 슬라이드의 원인·대응", quiet: true,
    files: [{ name: "비용보고.pptx", slides: [["3분기 비용 보고", "운영 현황"], ["비용 현황", "물류비 +18%"], ["증가 배경", "유가 및 운송거리 증가로 비용 확대"], ["향후 계획", "운송사 단가 재협상 예정 (물류팀, 11월)"]] }] },
  { id: "R02", category: "rebuttal", purpose: "'원인' 단어 없이 '요인'으로 설명", mustNot: [{ check: "cause" }],
    files: [{ name: "물류비.pptx", slides: [["물류비 보고", "물류비가 전월 대비 18% 증가했습니다."], ["분석", "물동량 증가와 단가 상승이 주요 증가 요인입니다."]] }] },
  { id: "R03", category: "rebuttal", purpose: "다른 시트의 요인 분해", quiet: true,
    files: [{ name: "실적.xlsx", sheets: [{ name: "Summary", percent: [6], rows: SUMMARY_ROWS }, { name: "Cost_Analysis", rows: [["물류비 증가 요인 분석"], ["요인", "기여"], ["유가 영향", "+8.2%p"], ["물동량 영향", "+6.1%p"], ["기타", "+4.4%p"]] }] }] },
  { id: "R04", category: "rebuttal", purpose: "단위·기간이 표 위 제목에 있음", quiet: true,
    files: [{ name: "비용.xlsx", sheets: [{ name: "비용", rows: [["2026년 9월 비용 현황"], ["단위: 백만원"], ["항목", "목표", "실적"], ["운송비", 400, 410], ["보관비", 120, 118]] }] }] },

  // ── Meaning: same meaning in other words, or same words other meaning ──
  { id: "S01", category: "semantic", purpose: "다른 표현의 원인 설명", needsModel: true, mustNot: [{ check: "cause" }],
    files: [{ name: "물류비.pptx", slides: [["물류비 보고", "물류비가 전월 대비 18% 증가했습니다."], ["배경", "운송 노선이 길어지고 연료 단가가 오르면서 지출이 커졌습니다."]] }] },
  { id: "S02", category: "semantic", purpose: "같은 단어지만 원인이 아닌 문장", must: [{ check: "cause" }],
    files: [{ name: "물류비.pptx", slides: [["물류비 보고", "물류비가 전월 대비 18% 증가했습니다."], ["세부", "물류비 증가율은 18%로 집계되었습니다.", "물류비 집계 기준은 전월과 동일합니다."]] }] },
  { id: "S03", category: "semantic", purpose: "다른 표현의 결론 근거", needsModel: true, mustNot: [{ check: "conclusion" }],
    files: [{ name: "비용전망.pptx", slides: [["비용 전망", "향후 비용 부담은 제한적일 것으로 예상됩니다."], ["계약 현황", "주요 운송 단가는 2027년 말까지 동결되어 있습니다."]] }] },
  { id: "S04", category: "semantic", purpose: "다른 시트의 서술형 원인", needsModel: true, mustNot: [{ check: "cause" }],
    files: [{ name: "실적.xlsx", sheets: [{ name: "Summary", percent: [6], rows: SUMMARY_ROWS }, { name: "코멘트", rows: [["9월 코멘트"], ["운송 노선이 길어지고 연료 단가가 오르면서 물류 지출이 커졌습니다."]] }] }] },

  // ── Several files ──────────────────────────────────────────────────────
  { id: "F01", category: "multi", purpose: "PPT에 없고 분석 PDF에 있는 원인 → 보고자료 보완", roles: ["report", "analysis"],
    must: [{ check: "cause", scope: "report", at: "월간보고.pptx / 2P" }], mustNot: [{ check: "cause", scope: "all" }], linkFrom: "원인분석.pdf",
    files: [REPORT, { name: "원인분석.pdf", pages: [["2026년 9월 물류비 분석"], ["물류비 증가 요인: 유가 상승과 운송거리 증가"]] }] },
  { id: "F02", category: "multi", purpose: "모든 파일에 원인 없음 → 전체 자료 보완 1건", must: [{ check: "cause", scope: "all", at: "월간보고.pptx" }],
    files: [REPORT, { name: "실적.xlsx", sheets: [{ name: "Summary", percent: [4], rows: [["2026년 9월 물류 실적 (단위: 백만원)"], ["구분", "전월", "당월", "전월 대비"], ["물류비", 400, 475, 0.18], ["인건비", 300, 303, 0.01]] }] }] },
  { id: "F03", category: "multi", purpose: "보고자료 안에서 먼저 해결", quiet: true,
    files: [{ ...REPORT, slides: [...REPORT.slides, ["증가 배경", "유가 상승과 운송거리 증가로 비용 확대"]] }, { name: "원인분석.pdf", pages: [["2026년 9월 물류비 분석"], ["물류비 증가 요인: 유가 상승"]] }] },
  { id: "F04", category: "multi", purpose: "다른 Excel의 분석 시트 → 보고자료 보완", must: [{ check: "cause", scope: "report" }], linkFrom: "실적.xlsx",
    files: [REPORT, { name: "실적.xlsx", sheets: [{ name: "Cost_Analysis", rows: [["2026년 9월 물류비 증가 요인"], ["요인", "기여"], ["유가 영향", "+8.2%p"], ["물동량 영향", "+6.1%p"]] }] }] },
  { id: "F05", category: "multi", purpose: "두 보고자료 각각 판단", roles: ["report", "report"],
    must: [{ check: "cause", scope: "report", at: "고객보고.pdf" }], mustNot: [{ check: "cause", at: "임원보고.pptx" }],
    files: [{ name: "임원보고.pptx", slides: [["2026년 9월 임원 보고", "현황"], ["비용", "물류비가 전월 대비 18% 증가했습니다.", "유가 상승과 운송거리 증가로 비용 확대"]] },
      { name: "고객보고.pdf", pages: [["2026년 9월 고객 보고"], ["물류비가 전월 대비 18% 증가했습니다."], ["결론", "서비스 수준은 유지됩니다."]] }] },
  { id: "F06", category: "multi", purpose: "Raw Data만 있는 설명은 설명으로 보지 않음", must: [{ check: "cause", scope: "all" }], neverLinkFrom: "실적.xlsx",
    files: [REPORT, { name: "실적.xlsx", sheets: [{ name: "Raw_Data", rows: [["일자", "메모", "금액"], ...Array.from({ length: 1500 }, (_, index) => ["2026-09-01", index % 2 ? "유가 상승 영향" : "정상", 1000])] }] }] },

  // ── Wrong linking guards ───────────────────────────────────────────────
  { id: "K01", category: "linking", purpose: "다른 기간(8월) 원인을 9월 근거로 쓰지 않음", must: [{ check: "cause", scope: "all" }], mustNot: [{ check: "cause", scope: "report" }], neverLinkFrom: "원인분석.pdf",
    files: [REPORT, { name: "원인분석.pdf", pages: [["2026년 8월 물류비 분석"], ["2026년 8월 물류비 증가 원인: 유가 상승"]] }] },
  { id: "K02", category: "linking", purpose: "12억원 = 1,200백만원은 연결", must: [{ check: "cause", scope: "report" }], linkFrom: "집계.xlsx",
    files: [{ name: "보고.pptx", slides: [["2026년 9월 보고", "현황"], ["운송", "운송비 12억원, 전월 대비 20% 증가"]] }, { name: "집계.xlsx", sheets: [{ name: "원인정리", rows: [["2026년 9월 (단위: 백만원)"], ["코드", "금액", "설명"], ["X-9", 1200, "유가 상승 영향으로 증가"]] }] }] },
  { id: "K03", category: "linking", purpose: "12억원 ≠ 1,200원은 연결하지 않음", must: [{ check: "cause", scope: "all" }], neverLinkFrom: "집계.xlsx",
    files: [{ name: "보고.pptx", slides: [["2026년 9월 보고", "현황"], ["운송", "운송비 12억원, 전월 대비 20% 증가"]] }, { name: "집계.xlsx", sheets: [{ name: "원인정리", rows: [["2026년 9월 (단위: 원)"], ["코드", "금액", "설명"], ["X-9", 1200, "유가 상승 영향으로 증가"]] }] }] },
  { id: "K04", category: "linking", purpose: "다른 고객의 원인을 연결하지 않음", must: [{ check: "cause", scope: "all" }], neverLinkFrom: "원인분석.pdf",
    files: [{ name: "보고.pptx", slides: [["2026년 9월 매출 보고", "현황"], ["매출", "고객사 A 매출이 전월 대비 12% 감소했습니다."]] }, { name: "원인분석.pdf", pages: [["2026년 9월 매출 분석"], ["고객사 B 매출 감소 원인: 단가 인하"]] }] },
  { id: "K05", category: "linking", purpose: "같은 '비용'이라도 운송비와 인건비는 연결하지 않음", must: [{ check: "cause", scope: "all" }], neverLinkFrom: "원인분석.pdf",
    files: [{ name: "보고.pptx", slides: [["2026년 9월 비용 보고", "현황"], ["운송", "운송비가 전월 대비 20% 증가했습니다."]] }, { name: "원인분석.pdf", pages: [["2026년 9월 인사 분석"], ["인건비 증가 원인: 임금 인상"]] }] },

  // ── Conflicts ──────────────────────────────────────────────────────────
  { id: "C01", category: "conflict", purpose: "자료별 주요 원인이 다름 → 선택하지 않고 확인 필요", must: [{ check: "cause", scope: "conflict" }], mustNot: [{ check: "cause", scope: "all" }, { check: "cause", scope: "report" }],
    files: [{ ...REPORT, slides: [...REPORT.slides, ["원인", "물류비 증가의 주요 원인은 유가 상승입니다."]] }, { name: "원인분석.pdf", pages: [["2026년 9월 물류비 분석"], ["물류비 증가의 주된 원인은 물동량 증가입니다."]] }] },

  // ── Partial reads ──────────────────────────────────────────────────────

  // ── Word documents ─────────────────────────────────────────────────────
  { id: "D01", category: "missing", purpose: "DOCX 결과는 있으나 원인 없음", must: [{ check: "cause", at: "비용 현황" }],
    files: [{ name: "비용보고.docx", docx: [{ heading: "2026년 9월 비용 보고" }, { heading: "비용 현황", level: 2 }, "물류비가 전월 대비 18% 증가했습니다.", { heading: "향후 계획", level: 2 }, "운송사 단가 재협상을 11월까지 물류팀이 진행할 예정입니다."] }] },
  { id: "D02", category: "rebuttal", purpose: "DOCX 뒤쪽 섹션의 원인 설명", quiet: true,
    files: [{ name: "비용보고.docx", docx: [{ heading: "2026년 9월 비용 보고" }, { heading: "비용 현황", level: 2 }, "물류비가 전월 대비 18% 증가했습니다.", { heading: "원인 분석", level: 2 }, "유가 상승 및 운송거리 증가 영향으로 비용이 늘었습니다.", { heading: "대응", level: 2 }, "운송사 단가 재협상 예정 (물류팀, 11월)"] }] },
  { id: "D03", category: "rebuttal", purpose: "본문에 없는 담당·일정이 표에 있음", quiet: true,
    files: [{ name: "프로젝트보고.docx", docx: ["1. 진행 현황", "ERP 구축 프로젝트 진행률 65%, 데이터 이관 지연 2주 발생.", "2. 조치 계획", "이관 스크립트 재작성을 추진할 예정입니다.", { table: [["조치내용", "담당자", "완료예정일"], ["이관 스크립트 재작성", "IT팀 박OO", "2026.10.20"]] }] }] },
  { id: "D04", category: "normal", purpose: "충분히 작성된 DOCX", quiet: true,
    files: [{ name: "이슈보고.docx", docx: [{ heading: "9월 이슈 보고" }, { heading: "발생 내용", level: 2 }, "고객사 A 납기 지연 12건 발생", { heading: "원인", level: 2 }, "설비 고장으로 생산 라인이 2일 중단되었습니다.", { heading: "영향", level: 2 }, "고객 클레임 3건, 지체상금 1,200만원 예상", { heading: "대응 계획", level: 2 }, "예비 설비 확보 및 정기 점검 강화 (생산팀 김OO, 2026.10.31까지)"] }] },
  { id: "D05", category: "missing", purpose: "DOCX 결론 근거 부족", must: [{ check: "conclusion", at: "결론" }],
    files: [{ name: "비용현황.docx", docx: [{ heading: "비용 현황" }, "3분기 운송비 42억 원 집행", { heading: "결론", level: 2 }, "향후 비용 부담은 제한적일 것으로 예상됩니다."] }] },
  { id: "D06", category: "multi", purpose: "DOCX에 원인, PPT에 없음 → PPT 보고자료 보완", must: [{ check: "cause", scope: "report", at: "월간보고.pptx" }], mustNot: [{ check: "cause", scope: "all" }], linkFrom: "원인분석.docx",
    files: [REPORT, { name: "원인분석.docx", docx: [{ heading: "2026년 9월 물류비 분석" }, "물류비 증가 요인: 유가 상승과 운송거리 증가"] }] },
  { id: "D07", category: "linking", purpose: "DOCX 보고서와 다른 기간 Excel 원인을 연결하지 않음", must: [{ check: "cause", scope: "all" }], neverLinkFrom: "실적_8월.xlsx",
    files: [{ name: "월간보고.docx", docx: [{ heading: "2026년 9월 월간 보고" }, { heading: "비용", level: 2 }, "물류비가 전월 대비 18% 증가했습니다.", { heading: "결론", level: 2 }, "비용 관리가 필요합니다."] },
      { name: "실적_8월.xlsx", sheets: [{ name: "원인분석", rows: [["2026년 8월 물류비 증가 요인"], ["요인", "설명"], ["유가", "유가 상승 영향으로 증가"]] }] }] },
  { id: "D08", category: "normal", purpose: "표 중심 DOCX에서 대량 오탐 없음", quiet: true,
    files: [{ name: "월간현황.docx", docx: [{ heading: "2026년 9월 운영 현황 (단위: 건)" }, { table: [["구분", "목표", "실적", "전월"], ["접수", "1,000", "1,020", "990"], ["처리", "950", "960", "940"], ["반려", "30", "28", "31"]] }, { table: [["지점", "담당", "비고"], ["서울지점", "김OO", "정상"], ["부산지점", "이OO", "정상"]] }] }] },
  { id: "P01", category: "partial", purpose: "텍스트 없는 PDF 페이지 → 제한 표시, 확정하지 않음", must: [{ check: "cause", status: "unverified" }], coverage: [{ total: 2, analyzed: 1, complete: false }],
    files: [{ name: "비용보고.pdf", pages: [["비용 보고", "3분기 물류비가 전분기 대비 18% 증가했습니다."], []] }] },
  { id: "P02", category: "partial", purpose: "차트를 읽지 못한 PPT → 제한 표시", must: [{ check: "cause", status: "unverified" }], coverage: [{ total: 1, complete: false }],
    files: [{ name: "차트보고.pptx", chart: true, slides: [["비용 보고", "3분기 물류비가 전분기 대비 18% 증가했습니다."]] }] },
  { id: "P03", category: "partial", purpose: "다른 파일의 미분석 영역 때문에 전체 누락을 확정하지 않음", must: [{ check: "cause", status: "unverified" }],
    files: [REPORT, { name: "원인분석.pdf", pages: [["2026년 9월 물류비 분석"], []] }] },

  // ── Large inputs ───────────────────────────────────────────────────────
  { id: "L01", category: "large", purpose: "3만 행 Raw Data: 구조 확인만, Summary 중심", must: [{ check: "cause", at: "Summary / F5" }], coverage: [{ total: 2, analyzed: 1, complete: true }],
    files: [{ name: "실적.xlsx", sheets: [{ name: "Summary", percent: [6], rows: SUMMARY_ROWS }, { name: "Raw_Data", rows: raw }] }] },
  { id: "L02", category: "large", purpose: "22개 시트 모두 처리 상태 보유", quiet: true, coverage: [{ total: 22, analyzed: 22, complete: true }],
    files: [{ name: "지점현황.xlsx", sheets: Array.from({ length: 22 }, (_, index) => ({ name: `지점${index + 1}`, rows: [["2026년 9월 지점 현황 (단위: 건)"], ["구분", "목표", "실적"], ["처리", 100, 100 + index]] })) }] },
];
