import type { z } from "zod";
import type { axDiagnosisOutputSchema } from "./schema";
import type { AxDiagnosisRequest } from "./types";

type AxDiagnosisOutput = z.infer<typeof axDiagnosisOutputSchema>;

export type AxSemanticViolationCategory =
  | "unsupported_performance_metric"
  | "invented_roi"
  | "invented_accuracy_claim"
  | "invented_time_saving"
  | "invented_automation_rate";

export interface AxSemanticViolation {
  category: AxSemanticViolationCategory;
  field: string;
}

const NUMBER_UNIT = /(\d+(?:\.\d+)?)\s*(%|퍼센트|배|분|시간|회|명|건|개|일|주|개월|년)/g;
const PREDICTION = /절감|감소|단축|향상|개선|줄어들|늘어날|높아질|낮아질|자동화하면|자동화 후|달성됩니다|기대됩니다|예상|전망/;
const token = (value: string, unit: string) => `${Number(value)}|${unit}`;

/** Only narrative fields are inspected; scores, enums and other structural values are excluded. */
function narrativeFields(diagnosis: AxDiagnosisOutput): [string, string][] {
  const fields: [string, string][] = [];
  const text = (field: string, value: string) => { fields.push([field, value]); };
  const list = (field: string, values: string[]) => values.forEach((value, index) => text(`${field}[${index}]`, value));
  list("followUpQuestions", diagnosis.followUpQuestions);
  for (const key of ["purpose", "trigger"] as const) text(`asIs.${key}`, diagnosis.asIs[key]);
  for (const key of ["inputs", "steps", "outputs", "exceptions", "humanDecisions", "systems"] as const) list(`asIs.${key}`, diagnosis.asIs[key]);
  diagnosis.factors.forEach((factor, index) => text(`factors[${index}].rationale`, factor.rationale));
  diagnosis.stepAssessments.forEach((step, index) => {
    text(`stepAssessments[${index}].step`, step.step);
    text(`stepAssessments[${index}].note`, step.note);
  });
  diagnosis.toBe.forEach((step, index) => {
    text(`toBe[${index}].step`, step.step);
    text(`toBe[${index}].description`, step.description);
  });
  list("humanInLoop", diagnosis.humanInLoop);
  diagnosis.technicalChecks.forEach((check, index) => {
    text(`technicalChecks[${index}].topic`, check.topic);
    text(`technicalChecks[${index}].note`, check.note);
  });
  list("risks", diagnosis.risks);
  text("poc.hypothesis", diagnosis.poc.hypothesis);
  for (const key of ["inScope", "outOfScope", "inputs", "outputs", "evaluation", "success", "failure"] as const) list(`poc.${key}`, diagnosis.poc[key]);
  list("decisionGate.reasons", diagnosis.decisionGate.reasons);
  diagnosis.roadmap.forEach((phase, index) => {
    text(`roadmap[${index}].phase`, phase.phase);
    text(`roadmap[${index}].title`, phase.title);
    list(`roadmap[${index}].items`, phase.items);
  });
  for (const key of ["owner", "failureOwner", "fallback"] as const) text(`operation.${key}`, diagnosis.operation[key]);
  list("operation.notes", diagnosis.operation.notes);
  text("nextAction.label", diagnosis.nextAction.label);
  text("nextAction.detail", diagnosis.nextAction.detail);
  return fields;
}

function categoryFor(text: string): AxSemanticViolationCategory {
  if (/ROI/i.test(text)) return "invented_roi";
  if (/정확도|오류|에러율/.test(text)) return "invented_accuracy_claim";
  if (/자동화율/.test(text)) return "invented_automation_rate";
  if (/시간|소요|\d+(?:\.\d+)?\s*분/.test(text) && /절감|단축|%|퍼센트/.test(text)) return "invented_time_saving";
  return "unsupported_performance_metric";
}

/** Read-only validation after schema validation; never rewrites a model's claims. */
export function validateAxSemantics(diagnosis: AxDiagnosisOutput, request: AxDiagnosisRequest): AxSemanticViolation[] {
  const { details } = request;
  const corpus = [request.name, request.description];
  for (const key of ["cycle", "systems", "inputs", "outputs", "humanSteps", "painPoints", "goal"] as const) {
    if (details[key] !== undefined) corpus.push(details[key]);
  }
  for (const [key, unit] of [["minutesPerRun", "분"], ["runsPerMonth", "회"], ["people", "명"]] as const) {
    if (details[key] !== undefined) corpus.push(`${details[key]}${unit}`);
  }
  const goalText = corpus.join(" ");
  const inputTokens = new Set([...goalText.matchAll(NUMBER_UNIT)].map(match => token(match[1], match[2])));
  const violations = new Map<string, AxSemanticViolation>();

  for (const [field, text] of narrativeFields(diagnosis)) {
    const claims = new Set<string>();
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(%|퍼센트)/g)) claims.add(token(match[1], match[2]));
    if (/효율|생산성|처리 속도|처리량|향상|개선/.test(text)) {
      for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*배/g)) claims.add(token(match[1], "배"));
    }
    for (const match of text.matchAll(/(ROI|정확도|오류율|에러율|자동화율|성공률|처리율|절감률|감소율|향상률|생산성|효율)[^0-9]{0,8}(\d+(?:\.\d+)?)\s*(%|퍼센트|배|분|시간|회|명|건|개|일|주|개월|년)?/gi)) claims.add(token(match[2], match[3] ?? ""));
    // Absolute time reductions are performance claims too, including input values reused as predictions.
    if (/절감|단축/.test(text)) {
      for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(분|시간)/g)) claims.add(token(match[1], match[2]));
    }
    for (const claim of claims) {
      if (text.includes("목표") && goalText.includes("목표") && inputTokens.has(claim)) continue;
      if (inputTokens.has(claim) && !PREDICTION.test(text)) continue;
      const category = categoryFor(text);
      violations.set(`${category}|${field}`, { category, field });
    }
  }
  return [...violations.values()];
}

/** Consistency categories between decisionGate.verdict, informationSufficiency and technicalChecks. */
export type AxGateConsistencyCategory =
  | "go_with_unconfirmed_required"
  | "go_with_insufficient_information"
  | "conditional_without_required_cause"
  | "conditional_on_approval_only"
  | "confirmed_but_note_unconfirmed";

export interface AxGateConsistencyIssue {
  category: AxGateConsistencyCategory;
  detail: string;
}

/** A note that reads as still-unconfirmed even though the check is marked 확인됨. */
const UNCONFIRMED_NOTE = /미확인|미확정|확인 필요|알 수 없|불명확/;
/** Reasons that only restate the 담당자 approval flow, which belongs to humanInLoop, not the gate. */
const APPROVAL_ONLY_REASON = /승인|검토|담당자/;

/**
 * Read-only consistency check for decisionGate.verdict × informationSufficiency × technicalChecks.
 * Never rewrites the model's verdict or changes Gate policy: it only reports structural conflicts
 * (required conditions confirmed yet conditional without cause, go despite gaps, confirmed flags
 * with unconfirmed notes) so reviewers and tests can spot over-conditional diagnoses.
 */
export function validateAxGateConsistency(diagnosis: AxDiagnosisOutput): AxGateConsistencyIssue[] {
  const issues: AxGateConsistencyIssue[] = [];
  const requiredUnconfirmed = diagnosis.technicalChecks.filter(check => check.status !== "확인됨" && check.required !== false);
  const { verdict, reasons } = diagnosis.decisionGate;

  if (verdict === "go" && requiredUnconfirmed.length) {
    issues.push({
      category: "go_with_unconfirmed_required",
      detail: `go 판정인데 미확정 필수 조건이 있습니다: ${requiredUnconfirmed.map(check => check.topic).join(", ")}`,
    });
  }
  if (verdict === "go" && diagnosis.informationSufficiency === "needs-check") {
    issues.push({ category: "go_with_insufficient_information", detail: "핵심 정보가 부족한데 go로 판정되었습니다." });
  }
  if (verdict === "conditional" && !requiredUnconfirmed.length && diagnosis.informationSufficiency !== "needs-check") {
    if (!reasons.length) {
      issues.push({ category: "conditional_without_required_cause", detail: "미확정 필수 조건·핵심 정보 부족 없이 근거도 없이 conditional로 판정되었습니다." });
    } else if (reasons.every(reason => APPROVAL_ONLY_REASON.test(reason))) {
      issues.push({ category: "conditional_on_approval_only", detail: "담당자 승인 단계 사유만으로 무관한 독립 단계까지 조건부로 제한되었습니다." });
    }
  }
  for (const check of diagnosis.technicalChecks) {
    if (check.status === "확인됨" && UNCONFIRMED_NOTE.test(check.note)) {
      issues.push({ category: "confirmed_but_note_unconfirmed", detail: `확인 완료 표시인데 note가 미확정을 시사합니다: ${check.topic}` });
    }
  }
  return issues;
}
