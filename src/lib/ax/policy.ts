import type { AxDiagnosis, AxTask, FactorKey } from "./types";
import { FACTOR_LABELS } from "./schema";
// All coefficients and thresholds are public policy; no additional weights.
export const AX_POLICY = { priority: { value: 2, feasibility: 1.5, judgment: -1, risk: -1.5, needsCheck: -1, partial: -0.5 }, matrixThreshold: 3.5, holdRisk: 4, holdJudgment: 4.5 } as const;
export const LEVEL_LABELS = ["L0 수동 유지", "L1 AI 보조", "L2 부분 자동화", "L3 고도 자동화"] as const;
export const REGION_LABELS = { quick: "빠른 실행 후보", strategic: "전략 과제", maybe: "검토 후보", hold: "수동 유지·보류" } as const;
export function axes(diagnosis: AxDiagnosis) {
  const value = (key: FactorKey) => { const f = diagnosis.factors.find(f => f.key === key); if (!f) throw new Error("Factor 누락"); return f.finalValue ?? f.aiValue; };
  return {
    value: Math.round((value("repetition") + value("regularity") + value("dataStructure")) / 3),
    feasibility: Math.round((value("regularity") + value("dataStructure") + value("systemAccess")) / 3),
    judgment: value("humanJudgment"), risk: value("operationalRisk"),
  };
}
export function automationLevel(d: AxDiagnosis) {
  const a = axes(d);
  const level = a.value <= 2 || (a.judgment >= 4 && a.risk >= 4) ? 0
    : a.value >= 4 && a.feasibility >= 4 && a.judgment <= 2 && a.risk <= 2 ? 3
    : a.value >= 3 && a.feasibility >= 3 && a.judgment <= 3 ? 2 : 1;
  return { level, label: LEVEL_LABELS[level], provisional: d.informationSufficiency === "needs-check" };
}
export function matrixPosition(d: AxDiagnosis) {
  const a = axes(d), p = AX_POLICY;
  const region = a.risk >= p.holdRisk || a.judgment >= p.holdJudgment ? "hold" : a.value >= p.matrixThreshold
    ? a.feasibility >= p.matrixThreshold ? "quick" : "strategic"
    : a.feasibility >= p.matrixThreshold ? "maybe" : "hold";
  return { x: (a.feasibility - 1) / 4 * 100, y: (a.value - 1) / 4 * 100, region, label: REGION_LABELS[region] };
}
export function monthlyMinutes(task: AxTask): number | null {
  return task.minutesPerRun !== undefined && task.runsPerMonth !== undefined ? task.minutesPerRun * task.runsPerMonth : null;
}
/** Area is proportional to known monthly minutes; unknown tasks share a fixed area. */
export function bubbleArea(task: AxTask, maxMinutes: number): number {
  const minutes = monthlyMinutes(task);
  return minutes === null ? 400 : maxMinutes > 0 ? 1600 * minutes / maxMinutes : 0;
}
export function priority(tasks: AxTask[]) {
  return tasks.filter((t): t is AxTask & { diagnosis: AxDiagnosis } => !!t.diagnosis).map(task => {
    const a = axes(task.diagnosis), w = AX_POLICY.priority;
    const penalty = task.diagnosis.informationSufficiency === "needs-check" ? w.needsCheck : task.diagnosis.informationSufficiency === "partial" ? w.partial : 0;
    const score = a.value * w.value + a.feasibility * w.feasibility + a.judgment * w.judgment + a.risk * w.risk + penalty;
    const strongest = a.value * w.value >= a.feasibility * w.feasibility ? `자동화 가치 ${a.value}` : `기술 실현 가능성 ${a.feasibility}`;
    return { task, score, monthlyMinutes: monthlyMinutes(task), reason: `${strongest}점이 가장 크게 기여; 사람 판단 ${a.judgment}점·위험 ${a.risk}점${penalty ? "·정보 부족" : ""} 반영` };
  }).sort((a, b) => b.score - a.score || (b.monthlyMinutes ?? -1) - (a.monthlyMinutes ?? -1));
}
export function nextAction(d: AxDiagnosis) {
  return d.informationSufficiency === "needs-check" ? { label: "핵심 확인사항 먼저 확인", detail: d.followUpQuestions.join(" · ") || "입력·승인·시스템 접근 가능 여부를 확인하세요." } : d.nextAction;
}
export function taskStatus(d?: AxDiagnosis): AxTask["status"] {
  return !d ? "registered" : d.factors.some(f => f.finalValue !== undefined) ? "adjusted" : d.informationSufficiency === "needs-check" ? "needs-info" : "diagnosed";
}
export function factorScale(key: FactorKey) {
  return key === "humanJudgment" ? "1: 판단 적음 → 5: 판단 많음" : key === "operationalRisk" ? "1: 위험 낮음 → 5: 위험 높음" : `1: ${FACTOR_LABELS[key]} 낮음 → 5: 높음`;
}
