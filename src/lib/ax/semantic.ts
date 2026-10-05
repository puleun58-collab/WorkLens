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
