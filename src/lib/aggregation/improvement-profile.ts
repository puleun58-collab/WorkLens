import type { AggregationOutputProfile, AggregationRecord } from "@/domain/aggregation";

export const IMPROVEMENT_PROFILE: AggregationOutputProfile = {
  id: "improvement-bank-backdata",
  label: "개선 Bank + Backdata",
  requiredFields: ["department", "current", "result"],
  formats: ["xlsx", "pptx"],
  sheetMappings: [{
    targetSheet: "개선 Bank",
    purpose: "records",
    fieldMappings: {
      managementNo: "관리 No",
      department: "공장",
      category: "구분",
      current: "현상 파악",
      result: "개선 결과",
      proposer: "제안자",
      owner: "N/O",
      registeredAt: "진행 현황 등록",
      closedAt: "진행 현황 종료",
      note: "비고",
    },
  }],
};

const FIELD_ALIASES: Record<string, RegExp> = {
  managementNo: /^(?:관리\s*(?:no|번호)|id)$/iu,
  department: /^(?:공장|부서|담당부서|구역|area|department)$/iu,
  category: /^(?:구분|분류|유형|category)$/iu,
  title: /^(?:제목|개선명|과제명|title)$/iu,
  period: /^(?:기간|일정|period)$/iu,
  current: /^(?:현상\s*파악|문제점|점검내용|교육내용|현황|before)$/iu,
  result: /^(?:개선\s*결과|개선내용|점검결과|교육결과|조치내용|after)$/iu,
  effect: /^(?:개선효과|효과|성과)$/iu,
  proposer: /^(?:제안자|작성자|담당자)$/iu,
  owner: /^(?:n\/o|owner|소유자)$/iu,
  registeredAt: /^(?:진행\s*현황\s*등록|등록일|시작일)$/iu,
  closedAt: /^(?:진행\s*현황\s*종료|종료일|완료일)$/iu,
  note: /^(?:비고|메모|note)$/iu,
};

export function improvementValue(record: AggregationRecord, key: keyof typeof FIELD_ALIASES): string | number | boolean | null {
  return record.fields.find((field) => FIELD_ALIASES[key].test(field.label.trim()))?.value.value ?? null;
}

export function improvementProfileStatus(records: readonly AggregationRecord[]): { available: boolean; missing: string[] } {
  const missing = IMPROVEMENT_PROFILE.requiredFields.filter((field) =>
    !records.some((record) => improvementValue(record, field as keyof typeof FIELD_ALIASES) !== null));
  return { available: missing.length === 0, missing };
}
