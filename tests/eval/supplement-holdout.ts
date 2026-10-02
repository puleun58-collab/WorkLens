import type { SupplementEvalCase } from "./supplement-cases";
import { branchSheet, longPdf, slides } from "./supplement-realistic";

/**
 * Holdout 보완 cases: final verification only. Written together with the
 * realistic set and not run while fixes were made; do not tune prompts or
 * rules against them. Not part of the CI gate (`--set holdout` runs them).
 */
/**
 * The largest raw sheet the parser admits at 5 columns: 19,990 rows (99,955 cells,
 * under the 100,000 cells-per-sheet limit; a larger sheet is refused at upload,
 * before 보완). Structure only, never findings.
 */
const bigRaw: Array<Array<string | number>> = [["일자", "지점", "품목", "수량", "금액"]];
for (let index = 0; index < 19_990; index += 1) {
  bigRaw.push([`2026-09-${String((index % 30) + 1).padStart(2, "0")}`, `지점${index % 40}`, `품목${index % 300}`, 1 + (index % 9), 10_000 + (index % 997) * 10]);
}

export const SUPPLEMENT_HOLDOUT_CASES: SupplementEvalCase[] = [
  { id: "HO01", category: "missing", purpose: "PPTX 이슈 보고: 영향은 있으나 대응 없음", must: [{ check: "response" }],
    files: [{ name: "보안점검결과.pptx", slides: slides("9월 보안 점검 결과", ["점검 결과", "관리자 계정 비밀번호 정책 미준수 14건 발견", "영향: 외부 침입 시 권한 탈취 위험"], ["기타", "다음 점검은 12월 예정"]) }] },
  { id: "HO02", category: "normal", purpose: "PDF 분석 보고서: 원인·영향·대응 완비 (0건)", quiet: true,
    files: [{ name: "반품분석.pdf", pages: [["2026년 9월 반품 분석"], ["반품률 3.4%, 전월 2.6% 대비 0.8%p 상승"], ["상승 요인: 신규 의류 카테고리의 사이즈 불만 반품 증가"], ["영향: 반품 처리비 월 1,800만원 추가"], ["대응: 상세페이지 사이즈 표 개선 (MD팀, 10월 중)"]] }] },
  { id: "HO03", category: "large", purpose: "52시트 + 약 2만 행 Raw(시트 셀 한도) + 숨김 Lookup·Config: 시트 전부 표시, Raw 행을 보완 대상으로 삼지 않음", must: [{ check: "cause", at: "Summary" }],
    files: [{ name: "지점실적_통합.xlsx", sheets: [
      { name: "Summary", percent: [6], rows: [["2026년 9월 전사 실적 (단위: 백만원)"], [], ["구분", "목표", "실적", "달성률", "전월", "전월 대비 증감률"], ["매출", 4000, 4120, "103%", 3980, 0.035], ["물류비", 400, 492, "123%", 401, 0.227]] },
      ...Array.from({ length: 48 }, (_, index) => branchSheet(index)),
      { name: "Raw_Data", rows: bigRaw },
      { name: "Lookup", hidden: true, rows: [["코드", "지점명"], ...Array.from({ length: 40 }, (_, index) => [`B${index}`, `지점${index}`])] },
      { name: "Config", hidden: true, rows: [["항목", "값"], ["기준월", "2026-09"], ["환율", 1380]] }] }] },
  { id: "HO04", category: "rebuttal", purpose: "DOCX 경력기술서형 섹션 문서: 업무 성과 서술에 보완 요구 없음", quiet: true,
    files: [{ name: "경력기술서.docx", docx: [{ heading: "경력기술서" }, { heading: "물류운영팀 (2021.03 ~ 현재)", level: 2 },
      "출고 프로세스 개선: 피킹 동선 재배치로 평균 리드타임을 3.2일에서 2.4일로 단축했습니다.",
      { heading: "주요 프로젝트", level: 2 }, { table: [["프로젝트", "역할", "기간", "성과"], ["WMS 고도화", "PM", "2025.01 ~ 2025.09", "재고정확도 99.1% → 99.7%"]] }] }] },
  { id: "HO05", category: "linking", purpose: "YTD 누적 분석을 당월 증가 근거로 쓰지 않음", must: [{ check: "cause", scope: "all" }], neverLinkFrom: "누적분석.pdf",
    files: [{ name: "9월보고.pptx", slides: slides("2026년 9월 실적 보고", ["인건비", "9월 인건비가 전월 대비 11% 증가했습니다."]) },
      { name: "누적분석.pdf", pages: [["2026년 1~9월 누적(YTD) 인건비 분석"], ["누적 인건비 증가 원인: 연초 임금 인상 반영"]] }] },
  { id: "HO06", category: "multi", purpose: "PPTX + XLSX + PDF: 근거는 XLSX 비고 열 → 보고자료 보완, 그 파일만 연결", must: [{ check: "cause", scope: "report", at: "영업보고.pptx" }], linkFrom: "영업실적.xlsx",
    files: [{ name: "영업보고.pptx", slides: slides("2026년 9월 영업 보고", ["B2B", "B2B 매출이 전월 대비 19% 증가했습니다."]) },
      { name: "영업실적.xlsx", sheets: [{ name: "B2B", rows: [["2026년 9월 B2B 실적 (단위: 백만원)"], ["구분", "전월", "당월", "비고"], ["B2B 매출", 520, 619, "신규 대형 고객사 2곳 계약 개시로 증가"]] }] },
      { name: "업계동향.pdf", pages: [["2026년 9월 업계 동향"], ["B2C 시장은 전월과 비슷한 수준을 유지했습니다."]] }] },
  { id: "HO07", category: "large", purpose: "100페이지 PDF: 부록의 원인·계획을 반증으로 사용", quiet: true, coverage: [{ total: 100, analyzed: 100, complete: true }],
    files: [longPdf] },
  ...["추후 협의하여 진행한다", "준비 완료 후 추진한다", "업체와 조율 후 시행 예정이다", "세부 일정은 별도 협의한다"].map((expression, index): SupplementEvalCase => ({
    id: `HO-T${index + 1}`, category: "missing", purpose: "일정 언급과 실제 시점의 구분", must: [{ check: "schedule" }], mustNot: [{ check: "owner" }, { check: "budget" }, { check: "scope" }],
    files: [{ name: "업무개선.docx", docx: [{ heading: "고객 응대 개선 추진 계획" }, { heading: "실행 계획" }, `응대 매뉴얼을 개편하여 적용할 계획이다. ${expression}.`, "담당: 고객지원팀", "적용 대상: 상담 창구 4곳", "예산: 120만원 (기존 계약 단가 기준)" ] }],
  })),
];
