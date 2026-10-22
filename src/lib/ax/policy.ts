import type { AxDiagnosis, AxTask, FactorKey } from "./types";
import { FACTOR_LABELS } from "./schema";
// All coefficients and thresholds are public policy; no additional weights.
export const AX_POLICY = { priority: { value: 2, feasibility: 1.5, judgment: -1, risk: -1.5, needsCheck: -1, partial: -0.5 }, matrixThreshold: 3.5, holdRisk: 4, holdJudgment: 4.5 } as const;
export const LEVEL_LABELS = ["L0 수동 유지", "L1 AI 보조", "L2 부분 자동화", "L3 고도 자동화"] as const;
export const REGION_LABELS = { quick: "빠른 실행 후보", strategic: "전략 과제", maybe: "검토 후보", hold: "수동 유지·보류" } as const;
export function factorEffectiveValue(f: AxDiagnosis["factors"][number]): number {
  return f.finalValue !== undefined && f.finalValue !== f.aiValue ? f.finalValue : f.aiValue;
}
export function factorHasAdjustment(f: AxDiagnosis["factors"][number]): boolean {
  return f.finalValue !== undefined && f.finalValue !== f.aiValue;
}
export function diagnosisHasAdjustment(d: AxDiagnosis): boolean {
  return d.factors.some(factorHasAdjustment);
}
export function axes(diagnosis: AxDiagnosis) {
  const value = (key: FactorKey) => { const f = diagnosis.factors.find(f => f.key === key); if (!f) throw new Error("Factor 누락"); return factorEffectiveValue(f); };
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
    return { task, score, monthlyMinutes: monthlyMinutes(task), reason: `${strongest}점이 가장 크게 기여; 담당자 판단 ${a.judgment}점·위험 ${a.risk}점${penalty ? "·정보 부족" : ""} 반영` };
  }).sort((a, b) => b.score - a.score || (b.monthlyMinutes ?? -1) - (a.monthlyMinutes ?? -1));
}
/**
 * Next action follows the confirmed gate and Level, not the AI narrative:
 * blocked → resolve blockers, conditional → prerequisites, Level 0/1 → validation;
 * only Level 2~3 with a ready gate may use the diagnosis' own next action.
 */
export function nextAction(d: AxDiagnosis): AxDiagnosis["nextAction"] {
  const gate = executionGate(d);
  if (gate === "blocked") return { label: "차단 사유 해결", detail: gateBlockReasons(d).slice(0, 3).join(" · ") };
  if (d.informationSufficiency === "needs-check") return { label: "핵심 확인사항 확인 필요", detail: d.followUpQuestions.join(" · ") || "입력·승인·시스템 접근 가능 여부를 확인하세요." };
  if (gate === "conditional") return { label: "선행 확인사항 확인", detail: gatePrerequisites(d).slice(0, 3).join(" · ") };
  const { level } = automationLevel(d);
  if (level === 0) return { label: "데이터·업무 규칙 확인", detail: "샘플 데이터 형식과 업무 규칙을 확인하고 사전 검증 결과로 다시 진단하세요." };
  if (level === 1) {
    const steps = stepsBy(d, "AI 보조").length ? stepsBy(d, "AI 보조") : stepsBy(d, "자동화");
    return { label: "AI 보조 사전 검증", detail: `${steps.length ? `${steps.join("·")} 단계의 ` : ""}AI 보조 결과를 담당자가 검토하는 흐름으로 검증하세요.` };
  }
  return d.nextAction;
}
export function taskStatus(d?: AxDiagnosis): AxTask["status"] {
  return !d ? "registered" : diagnosisHasAdjustment(d) ? "adjusted" : d.informationSufficiency === "needs-check" ? "needs-info" : "diagnosed";
}
/**
 * Display state for a task header/list: the adjustment badge stays primary,
 * but a task that is both user-adjusted and needs-check keeps a visible
 * "추가 확인 필요" flag so the sufficiency state is not hidden.
 */
export function taskDisplayStatus(task: AxTask): { status: AxTask["status"]; needsCheck: boolean } {
  const needsCheck = task.status === "adjusted" && !!task.diagnosis && task.diagnosis.informationSufficiency === "needs-check";
  return { status: task.status, needsCheck };
}
export function factorScale(key: FactorKey) {
  return key === "humanJudgment" ? "1: 판단 적음 → 5: 판단 많음" : key === "operationalRisk" ? "1: 위험 낮음 → 5: 위험 높음" : `1: ${FACTOR_LABELS[key]} 낮음 → 5: 높음`;
}

export type ExecutionGate = "ready" | "conditional" | "blocked";
export const GATE_LABELS: Record<ExecutionGate, string> = {
  ready: "진행 가능", conditional: "확인 후 진행", blocked: "진행 보류",
};

export function executionGate(d: AxDiagnosis): ExecutionGate {
  // 1. no-go만 hard blocker다. "불가" 상태의 필수 항목만 전체를 차단한다.
  if (d.decisionGate.verdict === "no-go") return "blocked";
  // 2. 조건부 판정, 정보 부족, 미확인 필수 기술 항목은 선행 확인이 필요하다.
  //    선택(optional) 항목은 Gate 판정에 영향을 주지 않는다.
  const requiredUnconfirmed = d.technicalChecks.some(c => c.status !== "확인됨" && c.required !== false);
  if (d.decisionGate.verdict === "conditional" || d.informationSufficiency === "needs-check"
    || requiredUnconfirmed) return "conditional";
  // 3. go이고 남은 필수 확인 항목이 없으면 실행 가능하다. 원본 진단은 변경하지 않는다.
  return "ready";
}

function checkLabel(c: AxDiagnosis["technicalChecks"][number]): string {
  return c.note ? `${c.topic} — ${c.note}` : c.topic;
}
function optionalCheckLabel(c: AxDiagnosis["technicalChecks"][number]): string {
  return c.note ? `${c.topic} (선택) — ${c.note}` : `${c.topic} (선택)`;
}
export function gatePrerequisites(d: AxDiagnosis): string[] {
  if (executionGate(d) === "ready") return [];
  const required = d.technicalChecks.filter(c => c.status !== "확인됨" && c.required !== false)
    .map(checkLabel);
  const optional = d.technicalChecks.filter(c => c.status !== "확인됨" && c.required === false)
    .map(optionalCheckLabel);
  const items = [...required, ...optional];
  if (d.informationSufficiency === "needs-check") items.push(...d.followUpQuestions);
  if (d.decisionGate.verdict !== "go") items.push(...d.decisionGate.reasons);
  const unique = [...new Set(items)].slice(0, 10);
  return unique.length ? unique : ["진단에서 제시된 조건부 진행 사유를 확인하세요."];
}

/**
 * Display-only: 미확인 선택(required: false) 기술 확인사항 — "권장 확인사항" 표시에만 사용한다.
 * Gate 판정·계산에는 영향을 주지 않으며, required 필드가 없는 기존 데이터는 필수로 간주한다 (PR #217 규칙 유지).
 */
export function gateRecommendedChecks(d: AxDiagnosis): string[] {
  const items = d.technicalChecks.filter(c => c.status !== "확인됨" && c.required === false).map(checkLabel);
  return [...new Set(items)].slice(0, 10);
}

/** 표시 전용 주제 키: 확인 항목 라벨("주제 — 비고")의 주제 부분과, 같은 주제를 묻는
 * 추가 질문("API 제공 여부를 알려주세요.")을 하나의 조건으로 식별한다. */
function prerequisiteTopicKey(text: string): string {
  const head = text.split(" — ")[0];
  let topic = head.trim().toLowerCase().replace(/\s+/g, "").replace(/[.?。]+$/, "");
  topic = topic.replace(/(을|를)?(알려주세요|알려주십시오|확인해주세요)$/, "");
  topic = topic.replace(/(인가요|인지요|입니까)$/, "");
  return topic.replace(/(을|를)$/, "");
}

/**
 * Display-only dedupe for prerequisite lines: 같은 확인 조건이 여러 출처(기술 확인·추가 질문 등)에서
 * 반복되면 첫 항목만 남긴다. 주제가 다른 조건은 합치지 않는다 — 예를 들어 "API 제공 여부"와
 * "API 접근 권한"은 서로 다른 조건으로 각각 유지한다 (diagnosisCheckItems와 동일한 기준).
 * 원본 데이터·Gate 판정·계산은 변경하지 않는다.
 */
function dedupePrerequisiteLines(items: string[]): string[] {
  const seenExact = new Set<string>();
  const seenTopics = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const exactKey = item.trim().toLowerCase();
    if (!exactKey || seenExact.has(exactKey)) continue;
    const topic = prerequisiteTopicKey(item);
    if (topic && seenTopics.has(topic)) continue;
    seenExact.add(exactKey);
    if (topic) seenTopics.add(topic);
    result.push(item);
  }
  return result;
}

/**
 * Display-only: 화면 표시용으로 필수 선행 조건과 권장 확인사항을 분리한다.
 * `required`는 gatePrerequisites에서 선택 항목을 제외한 목록과 동일하고,
 * Gate 판정·계산은 절대 변경하지 않는다.
 */
export function splitGatePrerequisites(d: AxDiagnosis): { required: string[]; recommended: string[] } {
  const optionalLabels = new Set(
    d.technicalChecks.filter(c => c.status !== "확인됨" && c.required === false).map(optionalCheckLabel),
  );
  return {
    required: dedupePrerequisiteLines(gatePrerequisites(d).filter(item => !optionalLabels.has(item))),
    recommended: dedupePrerequisiteLines(gateRecommendedChecks(d)),
  };
}

export function gateBlockReasons(d: AxDiagnosis): string[] {
  const reasons = [...d.decisionGate.reasons, ...d.technicalChecks.filter(c => c.status === "불가")
    .map(c => c.note ? `${c.topic} 불가 — ${c.note}` : `${c.topic} 불가`)];
  return reasons.length ? reasons : ["Decision Gate에서 진행 불가(no-go)로 판정되었습니다."];
}

export function planAllowed(d: AxDiagnosis): boolean {
  return executionGate(d) !== "blocked";
}

export function priorityDisplayLabel(d: AxDiagnosis): string {
  return executionGate(d) === "blocked" ? GATE_LABELS.blocked : matrixPosition(d).label;
}

type Verdict = AxDiagnosis["stepAssessments"][number]["verdict"];
type RoadmapPhase = AxDiagnosis["roadmap"][number];
function stepsBy(d: AxDiagnosis, verdict: Verdict): string[] {
  return d.stepAssessments.filter(step => step.verdict === verdict).map(step => step.step);
}
function distinct(items: string[], limit: number): string[] {
  return [...new Set(items.map(item => item.trim()).filter(Boolean))].slice(0, limit);
}
export const ROADMAP_TITLES = ["자동화 준비 로드맵", "AI 보조 도입 로드맵", "부분 자동화 로드맵", "자동화 도입 로드맵"] as const;

/** What the effective Level permits for one diagnosed step; null leaves the step outside the current scope.
 * Level은 운영 자동화의 자율성 기준이며 일반 기능 구현 가능성과 다르다:
 * Level 1에서도 "자동화" 판정 단계는 담당자 실행 기반의 사용자 실행형 기능으로 구현할 수 있다
 * (무인 자동 실행·자동 확정은 여전히 금지되며 "운영 자동화 적용"은 범위 밖으로 유지). */
function stepTreatment(level: number, verdict: Verdict, hasAssisted: boolean): string | null {
  if (verdict === "사람 유지") return null;
  if (level === 0) return "처리 가능성 검증";
  if (level === 1) return verdict === "AI 보조" || !hasAssisted ? "AI 보조 결과(후보·초안) 생성" : "사용자 실행 결과 생성";
  if (level === 2) return verdict === "자동화" ? "규칙 기반 처리" : "AI 보조";
  return verdict === "자동화" ? "자동 처리" : "AI 보조";
}
/** Checks each Level's scope carries besides the diagnosed steps: [before, after]. */
const SCOPE_SUPPORT: ReadonlyArray<readonly [string[], string[]]> = [
  [["샘플 데이터 형식·필수 항목 확인", "업무 규칙·예외 기준 확인"], ["자동화 가능성 판단"]],
  [[], ["담당자 검토 흐름 확인"]],
  [[], ["예외 분리 후 담당자 확인"]],
  [[], ["실패 복구·Fallback 확인", "운영 모니터링 확인"]],
];

/** PoC inclusion by the effective Level; a blocked gate falls back to Level 0 validation. */
function pocScope(d: AxDiagnosis, level: number): string[] {
  const hasAssisted = stepsBy(d, "AI 보조").length > 0;
  const steps = [...stepsBy(d, "자동화").map(step => [step, "자동화"] as const), ...stepsBy(d, "AI 보조").map(step => [step, "AI 보조"] as const)]
    .flatMap(([step, verdict]) => { const treatment = stepTreatment(level, verdict, hasAssisted); return treatment ? [`${step} ${treatment}`] : []; });
  const [before, after] = SCOPE_SUPPORT[level];
  return [...before, ...steps, ...after];
}

/**
 * How the permitted Level × Gate scope treats one diagnosed step. The same rule builds the PoC scope above, so
 * Step 4 and the coding-agent instruction never disagree about a step:
 * implement (ready) · after-check (conditional) · verify (Level 0 or blocked: review only) · future (outside the Level) · human.
 */
export interface StepScope {
  step: string; verdict: Verdict; owner: AxDiagnosis["stepAssessments"][number]["owner"]; note: string;
  scope: "implement" | "after-check" | "verify" | "future" | "human";
  treatment: string | null;
}
function stepScopes(d: AxDiagnosis, scopeLevel: number, gate: ExecutionGate): StepScope[] {
  const hasAssisted = stepsBy(d, "AI 보조").length > 0;
  return d.stepAssessments.map(({ step, verdict, owner, note }) => {
    const treatment = stepTreatment(scopeLevel, verdict, hasAssisted);
    const scope: StepScope["scope"] = verdict === "사람 유지" ? "human" : !treatment ? "future"
      : scopeLevel === 0 ? "verify" : gate === "ready" ? "implement" : "after-check";
    return { step, verdict, owner, note, scope, treatment };
  });
}

function readyRoadmap(d: AxDiagnosis, level: number, manual: string[]): Array<[string, string[]]> {
  const automated = stepsBy(d, "자동화"), assisted = stepsBy(d, "AI 보조");
  const inputs = d.asIs.inputs.map(input => `${input} 구조·필수 항목 확인`);
  const kept = manual.map(step => `${step} 담당자 수행 유지`);
  if (level === 0) return [
    ["데이터 형식 확인", inputs.length ? inputs : ["샘플 파일 구조·필수 항목 확인"]],
    ["업무 규칙 정리", [...d.asIs.humanDecisions, ...d.asIs.exceptions].map(rule => `${rule} 기준 정리`)],
    ["사전 검증", pocScope(d, 0)],
    ["재진단", ["검증 결과를 반영해 자동화 가능성 재진단"]],
  ];
  if (level === 1) return [
    ["입력·규칙 확인", inputs],
    ["AI 보조 기능 검증", pocScope(d, 1)],
    ["담당자 검토", [...kept, ...d.humanInLoop]],
    ["제한 적용·결과 평가", ["담당자 검토를 유지한 채 일부 건에 적용", ...d.poc.evaluation]],
  ];
  if (level === 2) return [
    ["입력·규칙 검증", inputs],
    ["부분 자동화 구현", [...automated.map(step => `${step} 규칙 기반 처리`), ...assisted.map(step => `${step} AI 보조`)]],
    ["예외·실패 검증", [...d.asIs.exceptions.map(item => `${item} 분리 후 담당자 확인`), `실패 시 ${d.operation.fallback}`]],
    ["파일럿", [...kept, ...d.poc.evaluation]],
    ["운영 적용", [`운영 담당 ${d.operation.owner}`, ...d.operation.notes]],
  ];
  return [
    ["자동화 흐름 구현", [...automated.map(step => `${step} 자동 처리`), ...assisted.map(step => `${step} AI 보조`)]],
    ["실패 복구·Fallback", [`실패 시 ${d.operation.fallback}`, `장애 대응 ${d.operation.failureOwner}`]],
    ["단계적 도입", ["일부 범위 적용 후 결과 확인 뒤 확대", ...kept]],
    ["운영·모니터링", [`운영 담당 ${d.operation.owner}`, ...d.operation.notes]],
  ];
}

/** Derived execution scope for one task; computed on render, never persisted. */
export interface ExecutionProfile {
  level: number;
  gate: ExecutionGate;
  region: keyof typeof REGION_LABELS;
  prerequisites: string[];
  blockReasons: string[];
  manualSteps: string[];
  automationSteps: string[];
  assistSteps: string[];
  /** Level 0, conditional or blocked tasks are not immediate execution candidates. */
  executionCandidate: boolean;
  readyExecutionCandidate: boolean;
  planAllowed: boolean;
  roadmapTitle: string;
  roadmap: RoadmapPhase[];
  poc: AxDiagnosis["poc"];
  nextAction: AxDiagnosis["nextAction"];
  /** Every diagnosed step with its treatment inside the permitted scope (blocked gates use Level 0 review). */
  stepScope: StepScope[];
  /** Non-step checks the permitted scope includes, in order. */
  scopeSupport: string[];
}

/**
 * Single interpretation of a confirmed diagnosis for Step 3~4 and plan generation.
 * Executable scope = Level scope ∩ Gate scope. Matrix region and priority only compare
 * tasks; the AI's raw roadmap/PoC/next action are reference material and never widen it.
 * Nothing here is persisted: raw diagnoses stay unchanged for storage and export.
 */
export function executionProfile(d: AxDiagnosis): ExecutionProfile {
  const { level } = automationLevel(d), gate = executionGate(d), region = matrixPosition(d).region as ExecutionProfile["region"];
  const manualSteps = stepsBy(d, "사람 유지"), automationSteps = stepsBy(d, "자동화"), assistSteps = stepsBy(d, "AI 보조");
  const prerequisites = gatePrerequisites(d), blockReasons = gate === "blocked" ? gateBlockReasons(d) : [];
  const pocLevel = gate === "blocked" ? 0 : level;
  const phases: Array<[string, string[]]> = gate === "blocked" ? [
    ["차단 사유 확인", blockReasons],
    ["조건 해결", d.technicalChecks.filter(check => check.status !== "확인됨").map(check => `${check.topic} 해결 방안 확인`).concat(d.technicalChecks.some(check => check.status !== "확인됨") ? [] : ["차단 사유별 해결 방법 확인"])],
    ["검증", ["해결된 조건을 샘플 데이터로 확인"]],
    ["재진단", ["해결 결과를 반영해 다시 진단"]],
  ] : gate === "conditional" ? [
    ["선행 확인", prerequisites],
    ["제한 PoC", pocScope(d, level).map(item => `샘플 범위: ${item}`)],
    ["결과 확인·다음 단계 판단", [...d.poc.evaluation, "결과를 반영해 재진단 또는 다음 단계 결정"]],
  ] : readyRoadmap(d, level, manualSteps);
  const roadmap: RoadmapPhase[] = phases.map(([title, items]) => ({ title, items: distinct(items, 4) }))
    .filter(phase => phase.items.length).map((phase, index) => ({ phase: String(index + 1), ...phase }));
  const poc: AxDiagnosis["poc"] = {
    ...d.poc,
    // PART B: Level 1의 자동화 판정 단계도 사용자 실행형으로 포함되므로, 잘라내기 제한을 확장 범위에 맞게 상향한다.
    inScope: distinct([...(gate === "conditional" ? ["선행 확인사항 해결 후 샘플 범위에서 진행"] : []), ...pocScope(d, pocLevel)], 10),
    outOfScope: distinct([...d.poc.outOfScope, ...manualSteps.map(step => `${step} 자동화 (담당자 수행)`), ...(pocLevel < 2 ? ["운영 자동화 적용"] : [])], 8),
  };
  return {
    level, gate, region, prerequisites, blockReasons, manualSteps, automationSteps, assistSteps,
    executionCandidate: gate === "ready" && level > 0,
    readyExecutionCandidate: gate === "ready" && level > 0,
    planAllowed: planAllowed(d),
    roadmapTitle: gate === "blocked" ? "선행 조치" : ROADMAP_TITLES[level],
    roadmap, poc, nextAction: nextAction(d),
    stepScope: stepScopes(d, pocLevel, gate), scopeSupport: SCOPE_SUPPORT[pocLevel].flat(),
  };
}

/** Section heading for the ranked list: ranking language only when something can run. */
export function priorityHeading(profiles: ExecutionProfile[]): string {
  const ready = profiles.filter(profile => profile.readyExecutionCandidate);
  if (ready.length) return `자동화 우선순위 TOP ${Math.min(3, ready.length)}`;
  if (profiles.some(profile => profile.gate === "conditional")) return "확인 후 진행 업무";
  return profiles.length === 1 ? "업무 진단 결과" : "현재 검토 업무";
}
