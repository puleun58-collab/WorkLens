import type { EvalFile, SupplementEvalCase } from "./supplement-cases";
import { SUPPLEMENT_UNRESOLVED_CASES } from "./supplement-unresolved-cases";

/**
 * Realistic 보완 cases: synthetic, anonymised material shaped like real
 * company reports (notes and footnotes, org-name owners, relative dates,
 * units stated once, periods only in file or sheet names, summary in the deck
 * with detail in the workbook). Expectations were set by reading each case
 * as a reviewer would, before running anything.
 *
 * SUPPLEMENT_REALISTIC_CASES is development material and may drive fixes.
 * The holdout set lives in supplement-holdout.ts: final verification only.
 */

export const slides = (title: string, ...rest: string[][]): string[][] => [[title, "보고 개요"], ...rest];

export const branchSheet = (index: number) => ({
  name: `지점${String(index + 1).padStart(2, "0")}`,
  rows: [["2026년 9월 지점 실적 (단위: 백만원)"], ["구분", "목표", "실적", "달성률"], ["매출", 100, 100 + (index % 7), `${100 + (index % 7)}%`], ["비용", 60, 59 + (index % 3), `${98 + (index % 3)}%`]] as Array<Array<string | number | null>>,
});

export const longPdf: EvalFile = {
  name: "연간운영보고서.pdf",
  pages: [
    ["2026년 3분기 운영 보고서", "물류센터 운영 현황을 분기별로 정리했습니다."],
    ["요약", "3분기 물류비는 52억 원으로 전분기 대비 15% 증가했습니다."],
    ...Array.from({ length: 96 }, (_, index) => [`센터별 운영 지표 ${index + 1}`, `센터 ${index + 1} 처리 물량 ${(12_000 + index * 37).toLocaleString("ko-KR")}건, 목표 12,000건 대비 달성`, `평균 리드타임 ${2 + (index % 3)}일 (전분기 ${2 + ((index + 1) % 3)}일)`]),
    ["부록 A. 비용 변동 분석", "물류비 증가는 유류비 단가 상승과 신규 센터 가동에 따른 운송 구간 증가 때문입니다."],
    ["부록 B. 향후 계획", "운송 구간 재설계를 물류기획팀이 연내 완료할 예정입니다."],
  ],
};

export const SUPPLEMENT_REALISTIC_CASES: SupplementEvalCase[] = [
  ...SUPPLEMENT_UNRESOLVED_CASES,
  // ── Information present in realistic, non-keyword places ──────────────
  { id: "RW01", category: "rebuttal", purpose: "원인이 제목이 아닌 ※ 주석에 있음", quiet: true,
    files: [{ name: "9월_비용보고.pptx", slides: slides("2026년 9월 비용 보고",
      ["비용 현황", "물류비 4.75억원, 전월 대비 18% 증가", "※ 유가 상승 및 신규 거래처 운송 구간 추가로 증가"],
      ["대응", "운송사 단가 재협상 진행 (물류팀, 10월 중)"]) }] },
  // Impact of the defect rate is not stated; asking for it is a fair 확인 필요, so it is allowed either way.
  { id: "RW02", category: "rebuttal", purpose: "대응·담당·일정이 슬라이드 표 형식 줄에만 있음", mustNot: [{ check: "response" }, { check: "owner" }, { check: "schedule" }], allowed: [{ check: "impact" }],
    files: [{ name: "품질이슈보고.pptx", slides: slides("9월 품질 이슈 보고",
      ["이슈", "B라인 포장 불량 1.8% 발생 (목표 0.5% 이하)", "원인: 포장기 실링 온도 편차"],
      ["조치 계획", "조치 | 담당 | 일정", "실링 온도 센서 교체 | 생산기술팀 | 10/15", "작업자 재교육 | 품질팀 | 10월 2주차"]) }] },
  { id: "RW03", category: "rebuttal", purpose: "담당이 조직명, 일정이 '차주·연내' 같은 상대 표현", quiet: true,
    files: [{ name: "프로젝트주간보고.docx", docx: [{ heading: "WMS 고도화 프로젝트 주간 보고" }, { heading: "진행 현황", level: 2 },
      "전체 진행률 72%, 계획 대비 3%p 지연", { heading: "지연 사유", level: 2 }, "외부 API 연동 사양 확정이 늦어졌습니다.",
      { heading: "대응", level: 2 }, "IT운영팀이 차주까지 연동 사양을 확정하고, 잔여 개발은 연내 완료합니다."] }] },
  { id: "RW04", category: "rebuttal", purpose: "단위가 표 상단에 한 번만 표시된 Excel", quiet: true,
    files: [{ name: "월간실적.xlsx", sheets: [{ name: "Summary", rows: [["2026년 9월 실적 요약"], ["(단위: 백만원, %)"], ["구분", "목표", "실적", "달성률", "비고"],
      ["매출", 1200, 1236, "103%", "신규 고객 2곳 매출 반영"], ["영업이익", 96, 101, "105%", "원가 절감 효과"]] }] }] },
  { id: "RW05", category: "rebuttal", purpose: "기간이 파일명·시트명에만 있음", quiet: true, allowed: [{ check: "period" }],
    files: [{ name: "실적_2026년9월.xlsx", sheets: [{ name: "9월 실적", rows: [["구분", "목표", "실적", "달성률"], ["매출 (백만원)", 800, 812, "102%"], ["원가 (백만원)", 560, 548, "98%"]] }] }] },
  { id: "RW06", category: "semantic", purpose: "'원인' 없이 다른 표현으로 쓴 증가 배경", needsModel: true, mustNot: [{ check: "cause" }],
    files: [{ name: "운송비보고.pptx", slides: slides("2026년 9월 운송비 보고",
      ["운송비", "운송비가 전월 대비 21% 늘었습니다."],
      ["상세", "추석 연휴 전 출고가 몰리면서 야간 차량을 추가로 배차했고, 이 비용이 전체 증가분의 대부분을 차지합니다."]) }] },
  { id: "RW07", category: "rebuttal", purpose: "같은 KPI가 여러 시트에 반복돼도 중복 보고하지 않음", quiet: true,
    files: [{ name: "KPI대시보드.xlsx", sheets: [
      { name: "Dashboard", rows: [["2026년 9월 KPI (단위: %)"], ["지표", "목표", "실적"], ["정시배송률", 98, 98.6], ["재고정확도", 99.5, 99.7]] },
      { name: "물류KPI", rows: [["2026년 9월 물류 KPI (단위: %)"], ["지표", "목표", "실적", "전월"], ["정시배송률", 98, 98.6, 98.1]] },
      { name: "재고KPI", rows: [["2026년 9월 재고 KPI (단위: %)"], ["지표", "목표", "실적", "전월"], ["재고정확도", 99.5, 99.7, 99.6]] }] }] },
  { id: "RW08", category: "rebuttal", purpose: "DOCX 회의록 표 안의 담당·기한", quiet: true,
    files: [{ name: "운영회의결과.docx", docx: [{ heading: "9월 운영회의 결과" }, { heading: "논의 사항", level: 2 }, "반품 처리 지연이 평균 4일로 늘어 고객 문의가 증가했습니다.",
      "지연은 반품 검수 인력 부족 때문입니다.",
      { heading: "결정 사항", level: 2 }, { table: [["결정 내용", "담당", "기한"], ["반품 검수 인력 2명 충원", "물류운영팀", "10월 말"], ["검수 기준 간소화", "품질팀", "10/20"]] }] }] },

  // ── Real gaps in realistic reports ─────────────────────────────────────
  { id: "RW09", category: "missing", purpose: "임원 보고: 큰 감소에 원인 없음", must: [{ check: "cause", at: "3P" }],
    files: [{ name: "임원보고_9월.pptx", slides: slides("2026년 9월 경영 실적 보고",
      ["매출", "매출 1,236억 원, 목표 대비 103% 달성"],
      ["해외 사업", "해외 매출이 전월 대비 27% 감소했습니다."],
      ["다음 달 계획", "4분기 판촉 계획은 별도 보고 예정"]) }] },
  { id: "RW10", category: "missing", purpose: "이슈 레지스터에서 진행 이슈의 대응 없음", must: [{ check: "response", at: "이슈목록" }],
    files: [{ name: "프로젝트이슈.xlsx", sheets: [{ name: "이슈목록", rows: [["2026년 9월 프로젝트 이슈"], ["No", "이슈", "영향", "상태", "대응", "담당"],
      [1, "데이터 이관 검증 오류", "오픈 1주 지연 위험", "진행", "", ""], [2, "권한 체계 변경 요청", "영향 없음", "완료", "권한표 반영", "보안팀"]] }] }] },
  { id: "RW11", category: "missing", purpose: "DOCX 계획서: 조치는 있으나 담당·일정 없음", must: [{ check: "owner" }],
    files: [{ name: "개선계획서.docx", docx: [{ heading: "출고 리드타임 개선 계획" }, { heading: "현황", level: 2 }, "평균 출고 리드타임 3.2일 (목표 2.5일)",
      { heading: "원인", level: 2 }, "피킹 동선이 길고 수작업 검수 비중이 높습니다.",
      { heading: "개선 방안", level: 2 }, "피킹 동선 재배치와 바코드 검수 도입을 추진합니다."] }] },

  // ── Several files ──────────────────────────────────────────────────────
  { id: "RW12", category: "multi", purpose: "PPT는 요약, Excel에 상세 원인 → 전체 누락으로 보지 않음", mustNot: [{ check: "cause", scope: "all" }], allowed: [{ check: "cause", scope: "report" }],
    files: [{ name: "월간보고.pptx", slides: slides("2026년 9월 월간 보고", ["비용", "물류비가 전월 대비 18% 증가했습니다."]) },
      { name: "물류비분석.xlsx", sheets: [{ name: "증감분석", rows: [["2026년 9월 물류비 증감 분석 (단위: 백만원)"], ["요인", "증감액", "설명"], ["유류비", 41, "경유 단가 상승"], ["운송 구간", 34, "신규 거래처 배송 구간 추가"]] }] }] },
  { id: "RW22", category: "linking", purpose: "전년도 원인을 올해 증가 근거로 쓰지 않음", must: [{ check: "cause", scope: "all" }], neverLinkFrom: "2025년비용분석.docx",
    files: [{ name: "2026년9월보고.pptx", slides: slides("2026년 9월 비용 보고", ["보관비", "2026년 9월 보관비가 전월 대비 13% 증가했습니다."]) },
      { name: "2025년비용분석.docx", docx: [{ heading: "2025년 9월 비용 분석" }, "2025년 9월 보관비 증가 원인: 임차 창고 추가 계약"] }] },
  { id: "RW23", category: "linking", purpose: "제품군 A의 원인을 제품군 B 근거로 쓰지 않음", must: [{ check: "cause", scope: "all" }], neverLinkFrom: "제품분석.xlsx",
    files: [{ name: "제품실적.pptx", slides: slides("2026년 9월 제품 실적", ["제품군 B", "제품군 B 판매량이 전월 대비 17% 감소했습니다."]) },
      { name: "제품분석.xlsx", sheets: [{ name: "제품군A", rows: [["2026년 9월 제품군 A 분석"], ["항목", "설명"], ["판매 감소 원인", "제품군 A 경쟁사 신제품 출시"]] }] }] },
  { id: "RW13", category: "multi", purpose: "PPTX + PDF: 원인은 PDF에만 → 보고자료 보완", must: [{ check: "cause", scope: "report", at: "주간보고.pptx" }], mustNot: [{ check: "cause", scope: "all" }], linkFrom: "운영분석.pdf",
    files: [{ name: "주간보고.pptx", slides: slides("2026년 9월 4주차 주간 보고", ["출고", "출고 지연 건수가 전주 대비 35% 증가했습니다."]) },
      { name: "운영분석.pdf", pages: [["2026년 9월 4주차 운영 분석"], ["출고 지연 증가 원인: 자동 분류기 정비로 수작업 분류 비중 확대"]] }] },
  { id: "RW14", category: "multi", purpose: "DOCX + XLSX: 보고서 원인 없음, Excel은 수치만 → 전체 자료 보완", must: [{ check: "cause", scope: "all" }],
    files: [{ name: "비용보고.docx", docx: [{ heading: "2026년 9월 비용 보고" }, { heading: "비용 현황", level: 2 }, "포장재 비용이 전월 대비 22% 증가했습니다.", { heading: "향후 계획", level: 2 }, "포장재 단가 협상을 10월 중 구매팀이 진행합니다."] },
      { name: "비용집계.xlsx", sheets: [{ name: "Summary", rows: [["2026년 9월 비용 집계 (단위: 백만원)"], ["항목", "전월", "당월"], ["포장재", 50, 61], ["소모품", 12, 12]] }] }] },
  { id: "RW15", category: "multi", purpose: "PPTX + XLSX + PDF + DOCX: 근거는 DOCX에만 → 그 파일만 연결", must: [{ check: "cause", scope: "report", at: "경영보고.pptx" }], linkFrom: "원가분석.docx", mustNot: [{ check: "cause", scope: "all" }],
    files: [{ name: "경영보고.pptx", slides: slides("2026년 9월 경영 보고", ["원가", "제조원가율이 전월 대비 2.1%p 상승했습니다."]) },
      { name: "원가집계.xlsx", sheets: [{ name: "Summary", rows: [["2026년 9월 원가 집계 (단위: %)"], ["구분", "전월", "당월"], ["제조원가율", 71.3, 73.4]] }] },
      { name: "시장동향.pdf", pages: [["2026년 9월 시장 동향"], ["업계 전반의 수요가 전월과 비슷한 수준을 유지했습니다."]] },
      { name: "원가분석.docx", docx: [{ heading: "2026년 9월 원가 분석" }, "제조원가율 상승은 원자재(레진) 단가 인상과 B라인 가동률 하락 때문입니다."] }] },

  // ── Wrong-linking guards ───────────────────────────────────────────────
  { id: "RW16", category: "linking", purpose: "Q2 분석을 Q3 보고 근거로 쓰지 않음", must: [{ check: "cause", scope: "all" }], neverLinkFrom: "2분기분석.pdf",
    files: [{ name: "3분기보고.pptx", slides: slides("2026년 3분기 실적 보고", ["비용", "3분기 판관비가 전분기 대비 14% 증가했습니다."]) },
      { name: "2분기분석.pdf", pages: [["2026년 2분기 비용 분석"], ["2분기 판관비 증가 원인: 광고비 집행 확대"]] }] },
  { id: "RW17", category: "linking", purpose: "국내 매출 원인을 해외 매출 근거로 쓰지 않음", must: [{ check: "cause", scope: "all" }], neverLinkFrom: "국내매출분석.docx",
    files: [{ name: "매출보고.pptx", slides: slides("2026년 9월 매출 보고", ["해외", "해외 매출이 전월 대비 16% 감소했습니다."]) },
      { name: "국내매출분석.docx", docx: [{ heading: "2026년 9월 국내 매출 분석" }, "국내 매출 감소 원인: 대형 유통 채널 발주 축소"] }] },
  { id: "RW18", category: "linking", purpose: "프로젝트 A의 지연 대응을 프로젝트 B 근거로 쓰지 않음", must: [{ check: "response", scope: "all" }], neverLinkFrom: "A프로젝트보고.docx",
    files: [{ name: "B프로젝트보고.pptx", slides: slides("B 프로젝트 9월 보고", ["이슈", "B 프로젝트 테스트 일정이 2주 지연되었습니다."]) },
      { name: "A프로젝트보고.docx", docx: [{ heading: "A 프로젝트 9월 보고" }, "A 프로젝트 테스트 지연 대응: 테스트 인력 3명 추가 투입 (QA팀, 10/10)"] }] },
  { id: "RW19", category: "linking", purpose: "천원 단위 1,200 ≠ 12억원은 연결하지 않음", must: [{ check: "cause", scope: "all" }], neverLinkFrom: "비용상세.xlsx",
    files: [{ name: "비용보고.pptx", slides: slides("2026년 9월 비용 보고", ["외주비", "외주비 12억원, 전월 대비 25% 증가"]) },
      { name: "비용상세.xlsx", sheets: [{ name: "외주비", rows: [["2026년 9월 외주비 상세 (단위: 천원)"], ["항목", "금액", "설명"], ["시스템 유지보수", 1200, "계약 갱신에 따른 단가 인상"]] }] }] },
  { id: "RW24", category: "large", purpose: "PPTX 30장 + XLSX 22시트 + PDF 100P + 긴 DOCX: 파일별 범위 표시, 원인은 DOCX 뒤쪽", must: [{ check: "cause", scope: "report", at: "분기보고.pptx" }], linkFrom: "원인분석.docx",
    mustNot: [{ check: "cause", scope: "all" }],
    coverage: [{ total: 30, analyzed: 30, complete: true }, { total: 22, complete: true }, { total: 100, analyzed: 100, complete: true }],
    files: [
      { name: "분기보고.pptx", slides: [["2026년 3분기 보고", "분기 결과"], ["인건비", "3분기 인건비가 전분기 대비 12% 증가했습니다."], ...Array.from({ length: 28 }, (_, index) => [`부문 ${index + 1}`, `처리 건수 ${(5_000 + index * 13).toLocaleString("ko-KR")}건 (목표 5,000건)`])] },
      { name: "지점실적.xlsx", sheets: Array.from({ length: 22 }, (_, index) => branchSheet(index)) },
      { ...longPdf, name: "운영보고서.pdf" },
      { name: "원인분석.docx", docx: [{ heading: "2026년 3분기 인건비 분석" }, ...Array.from({ length: 60 }, (_, index) => `부문 ${index + 1} 인원 현황은 전분기와 동일합니다.`),
        { heading: "증가 요인", level: 2 }, "3분기 인건비 증가는 성수기 단기 인력 채용과 연장근로 수당 증가 때문입니다."] },
    ] },

  // ── Normal, well-written material ──────────────────────────────────────
  { id: "RW20", category: "normal", purpose: "잘 작성된 운영 현황 PDF (0건이 정상)", quiet: true, coverage: [{ total: 4, analyzed: 4, complete: true }],
    files: [{ name: "운영현황_9월.pdf", pages: [["2026년 9월 물류 운영 현황"], ["처리 물량 12.4만 건 (목표 12만 건, 전월 11.8만 건)"], ["정시배송률 98.6% (목표 98%, 전월 98.1%)"], ["특이사항 없음. 10월에도 동일 수준 운영 예정입니다."]] }] },

  // ── Large inputs ───────────────────────────────────────────────────────
  { id: "RW21", category: "large", purpose: "50장 PPT: 뒤쪽 슬라이드의 원인 설명을 놓치지 않음", quiet: true, coverage: [{ total: 50, analyzed: 50, complete: true }],
    files: [{ name: "분기운영보고.pptx", slides: [["2026년 3분기 운영 보고", "분기 운영 결과를 보고드립니다."], ["물류비", "3분기 물류비가 전분기 대비 15% 증가했습니다."],
      ...Array.from({ length: 46 }, (_, index) => [`센터 ${index + 1} 현황`, `처리 물량 ${(9_000 + index * 41).toLocaleString("ko-KR")}건 (목표 9,000건)`]),
      ["부록: 비용 분석", "물류비 증가는 유류비 단가 상승과 신규 센터 가동에 따른 운송 구간 증가 때문입니다."], ["향후 계획", "운송 구간 재설계 (물류기획팀, 연내)"]] }] },
];
