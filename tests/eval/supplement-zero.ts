import type { SupplementEvalCase, EvalFile, Expected } from "./supplement-cases";
import type { SupplementDocType } from "@/domain/supplement";

export const INCOMPLETE_PLAN: NonNullable<EvalFile["docx"]> = [
  { heading: "사무동 시각화물 개선 검토안" },
  { heading: "추진 배경" }, "안내물이 노후되어 공간을 이해하기 어렵다는 의견이 있어 전반적인 정비가 필요합니다.",
  { heading: "개선 방향" }, "교체가 필요한 항목을 정리하고 주요 동선에 새 안내물과 시각화물을 설치하여 통일감 있는 디자인을 적용합니다.",
  { heading: "추진 방법" }, "관련 부서와 협의 뒤 외부 업체 의견을 받아 제작·설치를 추진한다. 세부 범위와 방식은 협의 과정에서 조정한다.",
  { heading: "예산" }, "제작 범위와 업체 견적을 확인한 후 확정할 예정이다.",
  { heading: "기대 효과" }, "인지성과 방문 편의성이 개선되고 회사 이미지가 향상될 것으로 예상한다.",
  { heading: "검토 요청" }, "위 개선 방향의 검토를 요청한다.",
];
export const PLAN_GOLD: Expected[] = [{ check: "owner", at: "추진 방법" }, { check: "schedule", at: "추진 방법" }, { check: "scope", at: "추진 방법" }, { check: "budget", at: "예산" }];
export const PLAN_ADDITIONS = {
  owner: "제작·설치 담당: 경영지원팀",
  schedule: "추진 일정: 10월 업체 선정, 11월 설치 완료",
  scope: "설치 대상: 1층 로비 안내판 3개, 회의실 표찰 8개",
  budget: "예산: 약 450만원, 산정 근거: 2개 업체 사전 견적",
};
export const SUPPLEMENT_ZERO_CASES: SupplementEvalCase[] = [
  { id: "Z01", category: "missing", purpose: "불완전한 추진 검토안", files: [{ name: "검토안.docx", docx: INCOMPLETE_PLAN }], must: PLAN_GOLD, allowed: [{ check: "baseline" }, { check: "conclusion" }], mustNot: [{ check: "response" }] },
  { id: "Z02", category: "normal", purpose: "완성된 개선 추진안", quiet: true, files: [{ name: "검토안.docx", docx: [...INCOMPLETE_PLAN, ...Object.values(PLAN_ADDITIONS), "측정 기준: 방문객 안내 문의 건수를 전월 대비 비교한다."] }] },
  { id: "Z03", category: "missing", purpose: "예산 범위는 있음: 예산 없음 단정 금지", files: [{ name: "검토안.docx", docx: [...INCOMPLETE_PLAN, "예산은 400~500만원 수준으로 예상하며 업체 선정 후 확정한다."] }], must: PLAN_GOLD.filter((item) => item.check !== "budget"), mustNot: [{ check: "budget" }], allowed: [{ check: "conclusion" }] },
  ...Object.entries(PLAN_ADDITIONS).map(([check, text], index): SupplementEvalCase => ({ id: `Z0${index + 4}`, category: "missing", purpose: `${check}만 추가: 해당 누락만 해소`, files: [{ name: "검토안.docx", docx: [...INCOMPLETE_PLAN, text] }], must: PLAN_GOLD.filter((item) => item.check !== check), mustNot: [{ check: check as Expected["check"] }], allowed: [{ check: "conclusion" }] })),
  { id: "Z08", category: "large", purpose: "긴 DOCX 마지막의 실행 정보", quiet: true, files: [{ name: "검토안.docx", docx: [...INCOMPLETE_PLAN, ...Array.from({ length: 80 }, (_, index) => `참고 자료 ${index + 1}: 기존 안내 현황을 기록한다.`), { heading: "추진 정보" }, ...Object.values(PLAN_ADDITIONS)] }] },
  { id: "Z09", category: "rebuttal", purpose: "DOCX 표의 실제 실행 정보", quiet: true, files: [{ name: "검토안.docx", docx: [...INCOMPLETE_PLAN, { table: [["항목", "내용"], ...Object.entries(PLAN_ADDITIONS).map(([check, text]) => [check, text])] }] }] },
  { id: "Z10", category: "normal", purpose: "XLSX 표의 담당·일정·예산", quiet: true, files: [{ name: "추진계획.xlsx", sheets: [{ name: "추진 계획", rows: [["항목", "내용"], ["담당", "경영지원팀"], ["일정", "11월 완료"], ["예산", "450만원"], ["대상", "안내판 3개"]] }] }] },
  { id: "Z11", category: "missing", purpose: "스타일 없는 첫 제목보다 예산 섹션이 우선하지 않음", docTypes: ["improvement"], must: PLAN_GOLD, files: [{ name: "자료.docx", docx: ["공용 공간 안내 개선 검토안", ...INCOMPLETE_PLAN.slice(1)] }] },
  { id: "Z12", category: "missing", purpose: "먼저 나온 예산의 제작 범위 언급은 실행/범위 앵커가 아님",
    must: [{ check: "owner", at: "실행 방법" }, { check: "schedule", at: "실행 방법" }, { check: "scope", at: "적용 범위" }, { check: "budget", at: "비용 검토" }],
    files: [{ name: "개선계획.docx", docx: [{ heading: "시설 개선 추진 계획" }, { heading: "비용 검토" }, "제작 범위를 검토한 뒤 견적에 따라 예산을 정할 예정이다.",
      { heading: "실행 방법" }, "관계 부서와 협의하여 장비를 설치하고 개선을 추진한다.",
      { heading: "적용 범위" }, "세부 작업 범위와 설치 방식은 협의 과정에서 조정한다."] }] },
];

/** Existing taxonomy falls back to general for unsupported/unclear types. */
const CLASSIFICATION_TITLES: Array<[string, SupplementDocType]> = [
  ["비용 보고", "cost"], ["일반 업무 보고", "general"], ["업무 개선 계획", "improvement"],
  ["사업 추진 계획", "plan"], ["업체 비교 검토", "general"], ["회의 결과", "general"],
  ["일정 계획", "general"], ["검토 자료", "general"],
];
SUPPLEMENT_ZERO_CASES.push(...CLASSIFICATION_TITLES.map(([title, docType], index): SupplementEvalCase => ({
  id: `ZC${index + 1}`, category: "normal", purpose: `자료 유형: ${title}`, quiet: true, docTypes: [docType],
  files: [{ name: "자료.docx", docx: [{ heading: title }, "확인된 내용을 공유합니다."] }],
})));
