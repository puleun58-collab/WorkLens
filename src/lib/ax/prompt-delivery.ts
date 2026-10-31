/**
 * 올인원 지시문 전달 완전성 검사 (P1).
 *
 * buildAllInOnePrompt의 본문은 바꾸지 않고, 생성된 본문을 입력으로 받아
 * 확정 규칙이 그대로 전달됐는지 프로그램적으로 대조한다. 검출 범위는
 * 도메인 비의존적으로 판정 가능한 7종으로 한정한다. 동일 규칙명 이외의
 * 미묘한 의미적 모순은 여기서 판정하지 않고 P4 인간 검토 항목으로 남긴다.
 *
 * 섹션 인식: 본문의 `## N. 제목` / `### 소제목` 형식을 기준으로 한다.
 * 구현 요구 섹션은 "구현 목표·구현 범위·기능별 요구사항"이며, 그 안에서도
 * 합법적 귀속처(현재 자동화 제외·사람 검토 반영·확인 필요·업무 규칙 블록·
 * 업무 설명·향후 확장)는 구현 요구로 보지 않는다.
 */
import { duplicateGenericRuleConflicts } from "./generic-rules";
import type { GenericRule } from "./types";

export type PromptDeliveryFindingKind =
  | "confirmed-missing"
  | "confirmed-detail"
  | "confirmed-scope"
  | "confirmed-conflict"
  | "pending-as-confirmed"
  | "not-applicable-demanded"
  | "hitl-reappeared";

export interface PromptDeliveryFinding {
  kind: PromptDeliveryFindingKind;
  /** 관련 규칙 id (충돌·HITL 재등장은 없을 수 있다). */
  ruleId?: string;
  ruleName?: string;
  message: string;
}

export interface PromptDeliveryReport {
  /** 확정 규칙 수 (적용 + 확정). */
  confirmedTotal: number;
  /** 누락·상세·범위 finding이 없는 확정 규칙 수 (충돌 finding은 전달 여부와 별개로 집계한다). */
  deliveredCount: number;
  findings: PromptDeliveryFinding[];
}

export interface PromptDeliveryInput {
  confirmed: readonly GenericRule[];
  pending: readonly GenericRule[];
  applicabilityPending: readonly GenericRule[];
  notApplicable: readonly GenericRule[];
  hitlDeferredNames: readonly string[];
  hitlExcludedNames: readonly string[];
}

/** 공백 정규화 비교용: 줄바꿈·연속 공백을 한 칸으로 접는다. */
const normalize = (value: string): string => value.replace(/\s+/gu, " ").trim();

/** `## N. 제목` 기준 최상위 섹션 분리 (제목은 번호를 뗀 이름). */
function topSections(prompt: string): { title: string; body: string }[] {
  const sections: { title: string; body: string }[] = [];
  const pattern = /^## \d+\.\s+(.+)$/gmu;
  let match: RegExpExecArray | null;
  let lastTitle: string | null = null;
  let lastIndex = 0;
  const flush = (end: number) => {
    if (lastTitle !== null) sections.push({ title: lastTitle, body: prompt.slice(lastIndex, end) });
  };
  while ((match = pattern.exec(prompt)) !== null) {
    flush(match.index);
    lastTitle = match[1].trim();
    lastIndex = match.index + match[0].length;
  }
  flush(prompt.length);
  return sections;
}

/** 합법적 귀속처 소제목: 구현 요구로 보지 않는다. 부분 문자열 매칭은
 * "기능 N. <단계명>"처럼 단계명에 '제외' 등이 들어간 경우를 오제외하므로,
 * 아래 고정 소제목 형태에만 적용한다. */
function isLegitimateSubsection(title: string): boolean {
  return title === "현재 자동화 제외"
    || title === "사람 검토 반영"
    || title.startsWith("적용 단계 확인 필요")
    || title === "업무 규칙 (범용)"
    || title.startsWith("업무 설명")
    || title.startsWith("향후 확장");
}

/**
 * 구현 요구 텍스트: 구현 목표·구현 범위·기능별 요구사항 섹션에서
 * 합법적 귀속처 소제목 블록을 뺀 나머지 (소제목 없는 서두 포함).
 */
export function implementationDemandText(prompt: string): string {
  const demandTitles = new Set(["구현 목표", "구현 범위", "기능별 요구사항"]);
  const parts: string[] = [];
  for (const section of topSections(prompt)) {
    if (!demandTitles.has(section.title)) continue;
    const subPattern = /^### (.+)$/gmu;
    let match: RegExpExecArray | null;
    let lastSubtitle: string | null = null;
    let lastIndex = 0;
    const flush = (end: number) => {
      if (lastSubtitle === null || !isLegitimateSubsection(lastSubtitle)) {
        parts.push(section.body.slice(lastIndex, end));
      }
    };
    while ((match = subPattern.exec(section.body)) !== null) {
      flush(match.index);
      lastSubtitle = match[1].trim();
      lastIndex = match.index + match[0].length;
    }
    flush(section.body.length);
  }
  return normalize(parts.join("\n"));
}

export function checkPromptRuleDelivery(prompt: string, input: PromptDeliveryInput): PromptDeliveryReport {
  const normalizedPrompt = normalize(prompt);
  const lines = prompt.split("\n").map(line => normalize(line));
  const findings: PromptDeliveryFinding[] = [];
  const undelivered = new Set<string>();

  const ruleLines = (rule: GenericRule): string[] => {
    const needle = normalize(`${rule.id} ${rule.name}`);
    return lines.filter(line => line.includes(needle));
  };

  // ① 확정 누락: id·이름이 본문에 없으면 결함.
  // ② 상세 누락·변형: 방출이 verbatim이므로 정규화 후 상세 부재는 결함.
  // ③ 적용 범위 불일치: 원본에 있는 step·source·linkedDecisionId 표기 부재.
  for (const rule of input.confirmed) {
    const present = ruleLines(rule);
    if (!present.length) {
      findings.push({ kind: "confirmed-missing", ruleId: rule.id, ruleName: rule.name, message: `확정 규칙 ${rule.id} ${rule.name}이(가) 지시문에 전달되지 않았습니다.` });
      undelivered.add(rule.id);
      continue;
    }
    const detail = rule.detail?.trim();
    if (detail && !normalizedPrompt.includes(normalize(detail))) {
      findings.push({ kind: "confirmed-detail", ruleId: rule.id, ruleName: rule.name, message: `확정 규칙 ${rule.id} ${rule.name}의 상세가 지시문에서 verbatim으로 확인되지 않습니다.` });
      undelivered.add(rule.id);
    }
    const requiredTokens = [
      ...(rule.step?.trim() ? [`[관련 단계: ${rule.step.trim()}]`] : []),
      ...(rule.source?.trim() ? [`[근거: ${rule.source.trim()}]`] : []),
      ...(rule.linkedDecisionId ? [`[연계: ${rule.linkedDecisionId}]`] : []),
    ];
    const missingTokens = requiredTokens.filter(token => !present.some(line => line.includes(normalize(token))));
    if (missingTokens.length) {
      findings.push({ kind: "confirmed-scope", ruleId: rule.id, ruleName: rule.name, message: `확정 규칙 ${rule.id} ${rule.name}의 적용 범위 표기가 누락됐습니다: ${missingTokens.join(", ")}` });
      undelivered.add(rule.id);
    }
  }

  // ④ 확정 충돌: 기존 duplicateGenericRuleConflicts를 재사용 (자동 병합 없음).
  for (const message of duplicateGenericRuleConflicts(input.confirmed)) {
    findings.push({ kind: "confirmed-conflict", message });
  }

  // ⑤ 미확정 확정 처리: 미확정·적용 여부 미확정 규칙이 `— 확정` 행으로 렌더링되면 결함.
  for (const rule of [...input.pending, ...input.applicabilityPending]) {
    if (ruleLines(rule).some(line => line.includes("— 확정"))) {
      findings.push({ kind: "pending-as-confirmed", ruleId: rule.id, ruleName: rule.name, message: `미확정 규칙 ${rule.id} ${rule.name}이(가) 확정 행으로 렌더링됐습니다.` });
    }
  }

  const demand = implementationDemandText(prompt);
  // ⑥ 해당 없음 구현 요구: 해당 없음 규칙이 구현 요구 섹션에 등장하면 결함.
  for (const rule of input.notApplicable) {
    if (rule.name.trim() && demand.includes(normalize(rule.name))) {
      findings.push({ kind: "not-applicable-demanded", ruleId: rule.id, ruleName: rule.name, message: `해당 없음 규칙 ${rule.id} ${rule.name}이(가) 구현 요구 섹션에 등장합니다.` });
    }
  }
  // ⑦ HITL 보류·제외 재등장: 보류·제외 이름이 구현 요구 섹션에 등장하면 결함.
  for (const name of [...input.hitlDeferredNames, ...input.hitlExcludedNames]) {
    const trimmed = name.trim();
    if (trimmed && demand.includes(normalize(trimmed))) {
      findings.push({ kind: "hitl-reappeared", ruleName: trimmed, message: `보류·제외 항목 "${trimmed}"이(가) 구현 요구 섹션에 다시 등장합니다.` });
    }
  }

  return {
    confirmedTotal: input.confirmed.length,
    deliveredCount: input.confirmed.filter(rule => !undelivered.has(rule.id)).length,
    findings,
  };
}
