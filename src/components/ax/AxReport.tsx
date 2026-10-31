"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Bot, BrainCircuit, Check, CheckCircle2, CircleCheck, Clipboard, ClipboardCheck, ClipboardList, CloudUpload, Copy, Database, Download, FileCode2, FileOutput, FilePlus2, FileSpreadsheet, FileText, Folder, GitBranch, GitMerge, GitPullRequest, Globe, Info, ListChecks, Monitor, MonitorCog, Play, Plug, Rocket, Settings2, ShieldAlert, ShieldCheck, Target, Terminal, UserRound, type LucideIcon } from "lucide-react";
import type { AxDiagnosis, AxPlan, AxTask, AxTaskV2, HitlReview, VerificationResult } from "@/lib/ax/types";
import { automationLevel, axes, executionGate, executionProfile, factorEffectiveValue, GATE_LABELS, gateBlockReasons, LEVEL_DESCRIPTIONS, levelDisplayLabel, nextAction, prerequisiteTopicKey, splitGatePrerequisites } from "@/lib/ax/policy";
import { FACTOR_LABELS } from "@/lib/ax/schema";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { HitlReviewPanel } from "./HitlReview";
import { extractReviewableItems, extractPlanReviewableItems, findReview, getValidConfirmedReviews, type ReviewableItem } from "@/lib/ax/hitl";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import { buildFixPrompt, checkAllInOnePromptDelivery, guideCodeDisplayText, guideProseDisplayText, planSummary, setupGuide, TOOL_GUIDES, type AxCheckTone, type AxGitFlowBlock, type AxGuideBlock, type AxGuideSection, type AxPlanSummary, type AxToolId } from "@/lib/ax/guide";

const VERDICT_LABELS = { 자동화: "자동화", "AI 보조": "AI 보조", "사람 유지": "담당자 수행" } as const;
const OWNER_LABELS = { 시스템: "시스템", AI: "AI", 사용자: "담당자" } as const;
export function AxList({ items }: { items: string[] }) {
  return items.length ? <ul>{items.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p className="ax-muted">기재된 내용 없음</p>;
}
/** Level 툴팁 상태: 호버·키보드 포커스는 공통 툴팁의 기본 동작을 그대로 쓰고, 터치 탭은 클릭 토글로 연다.
 * 탭 직후에는 합성 hover 종료(trigger-hover)가 곧바로 발행돼 방금 연 설명을 닫으므로, 터치 눌림 1초 안에 온
 * 합성 종료 신호만 무시한다. 마우스·키보드 흐름은 가드 대상이 아니다.
 * 탭 토글은 눌림 시점 상태를 기준으로 한다: 터치 pointerleave로 공통 툴팁이 먼저 닫힌 뒤 클릭이 오면
 * blind한 !prev 토글은 닫힌 상태를 다시 열어 버린다(닫기 탭 경합). 눌림 시점이 열림이었으면 닫고,
 * 닫힘이었으면 여는 것이 탭의 의도다. */
function useLevelTooltip() {
  const [open, setOpen] = useState(false);
  const lastPointerType = useRef("");
  const pressedAt = useRef(0);
  const openAtPress = useRef<boolean | null>(null);
  // 눌림 시점 상태는 렌더 시점 클로저의 open으로 캡처한다. triggerHandlers는
  // 매 렌더마다 DOM에 재부착되므로 핸들러 클로저는 항상 최신 렌더의 값이다.
  // 렌더 중 ref 쓰기(react-hooks/refs 위반)와 effect 동기화의 경합을 모두 피한다.
  return {
    open,
    onOpenChange: (next: boolean, details: { reason?: string }) => {
      if (!next && lastPointerType.current === "touch" && Date.now() - pressedAt.current < 1_000
        && (details?.reason === "trigger-hover" || details?.reason === "trigger-focus")) return;
      setOpen(next);
    },
    triggerHandlers: {
      onPointerDown: (event: React.PointerEvent) => { lastPointerType.current = event.pointerType; openAtPress.current = open; },
      onPointerCancel: () => { openAtPress.current = null; },
      onClick: () => {
        pressedAt.current = Date.now();
        if (openAtPress.current !== null) { setOpen(!openAtPress.current); openAtPress.current = null; }
        else setOpen(prev => !prev);
      },
    },
  };
}
/** 구현 계획 헤더의 Level 표기: AxLevelBadge와 같은 표기·툴팁을 기존 span 배지 디자인으로 표시한다. */
export function AxPlanLevelTag({ level }: { level: ReturnType<typeof automationLevel> }) {
  const tip = useLevelTooltip();
  return <Tooltip open={tip.open} onOpenChange={tip.onOpenChange}>
    <TooltipTrigger render={<span className="ax-status-badge" tabIndex={0} {...tip.triggerHandlers} />}>{`${levelDisplayLabel(level)}${level.provisional ? " (잠정)" : ""}`}</TooltipTrigger>
    <TooltipPopup>{LEVEL_DESCRIPTIONS[level.level]}</TooltipPopup>
  </Tooltip>;
}
/** Level 배지: 표기는 levelDisplayLabel로 통일하고, 공통 툴팁으로 Level 의미를 한 줄로 안내한다 (호버·터치·포커스). */
export function AxLevelBadge({ level, className, variant, suffix }: {
  level: ReturnType<typeof automationLevel>;
  className?: string;
  variant?: React.ComponentProps<typeof Badge>["variant"];
  suffix?: string;
}) {
  const tip = useLevelTooltip();
  return <Tooltip open={tip.open} onOpenChange={tip.onOpenChange}>
    <TooltipTrigger render={<Badge variant={variant} className={className} tabIndex={0} {...tip.triggerHandlers} />}>{`${levelDisplayLabel(level)}${suffix ?? ""}`}</TooltipTrigger>
    <TooltipPopup>{LEVEL_DESCRIPTIONS[level.level]}</TooltipPopup>
  </Tooltip>;
}
export function AxSummary({ task, showGate = true }: { task: AxTask; showGate?: boolean }) {
  if (!task.diagnosis) return null;
  const a = axes(task.diagnosis), l = automationLevel(task.diagnosis), action = nextAction(task.diagnosis), gate = executionGate(task.diagnosis);
  // Only real prerequisite topics or blockers are named; the generic gate fallback sentence is not repeated next to the status.
  const checks = gate === "conditional" ? task.diagnosis.technicalChecks.filter(c => c.status !== "확인됨").map(c => c.topic) : [];
  const blocker = gate === "blocked" ? task.diagnosis.decisionGate.reasons[0] ?? task.diagnosis.technicalChecks.find(c => c.status === "불가")?.topic : undefined;
  return <div className="ax-summary">
    <AxLevelBadge level={l} variant="outline" className="ax-level-badge" suffix={l.provisional ? " · 잠정" : ""} />
    {showGate ? <p className="ax-gate-line"><span>실행 상태</span><span className="ax-gate-badge" data-gate={gate}>{GATE_LABELS[gate]}</span></p> : null}
    {showGate && (checks.length || blocker) ? <p className="ax-gate-checks"><span>{checks.length ? "확인 필요" : "보류 사유"}</span>{checks.length ? checks.join(" · ") : blocker}</p> : null}
    <p>자동화 가치 {a.value} · 기술 실현 가능성 {a.feasibility} · 담당자 판단 필요도 {a.judgment} · 운영 위험 {a.risk}</p>
    {showGate ? <p><strong>{action.label}</strong> — {action.detail}</p> : null}
  </div>;
}
/** Display-only summary sentences composed from confirmed diagnosis data; no AI call, no invented facts.
 * 구성은 세 가지로 제한한다: ① 전체 단계의 판정 분포(핵심 판단) ② 담당자 수행 단계와 명시된 검토·승인 지점
 * ③ 구현 전에 확인해야 할 사항. 단계명·확인 주제의 상세는 아래 영역에서 확인한다.
 * Level·Gate는 카드 상단 배지가 단일 표시이며 요약 문장에서 반복하지 않는다(진행 보류의 후속 조치만 예외). */
export interface DiagnosisSummaryParts {
  /** 핵심 판단의 판정 분포 명사구 (예: "전체 6개 업무 단계 중 자동화 적합 3개 · AI 보조 적합 2개 · 담당자 수행 1개"). */
  verdict?: string;
  /** verdict를 문장으로 푼 기존 요약 문장 (diagnosisSummarySentences와 동일 문구). */
  verdictSentence?: string;
  /** 담당자 수행·검토·승인 절 — 역할 구분 문구 그대로. */
  human?: string;
  /** 확인 필요 문장 — 진행 보류 시 차단·재진단 문장, 그 외 표시 항목 기준 확인 필요 건수 또는 추가 질문 건수. */
  check?: string;
}
/** Display-only summary parts composed from confirmed diagnosis data; no AI call, no invented facts.
 * diagnosisSummarySentences와 같은 데이터·문구를 핵심 판단/담당자 역할/확인 필요로 나눈 것으로,
 * 진단 결과 요약의 라벨 행 표시가 사용한다. 어느 부분도 새 사실을 만들지 않는다. */
export function diagnosisSummaryParts(d: AxDiagnosis): DiagnosisSummaryParts {
  const names = (list: string[]) => list.length > 3 ? `${list.slice(0, 3).join("·")} 등 ${list.length}개` : list.join("·");
  const count = (verdict: "자동화" | "AI 보조" | "사람 유지") => d.stepAssessments.filter(s => s.verdict === verdict).length;
  const parts: DiagnosisSummaryParts = {};
  const total = d.stepAssessments.length;
  if (total) {
    const distribution = [
      count("자동화") ? `자동화 적합 ${count("자동화")}개` : "",
      count("AI 보조") ? `AI 보조 적합 ${count("AI 보조")}개` : "",
      count("사람 유지") ? `담당자 수행 ${count("사람 유지")}개` : "",
    ].filter(Boolean);
    parts.verdict = `전체 ${total}개 업무 단계 중 ${distribution.join(" · ")}`;
    parts.verdictSentence = `${parts.verdict}로 ${automationLevel(d).provisional ? "잠정 판정" : "판정"}되었습니다.`;
  }
  // 담당자 관련 문장은 역할별로 구분한다. 사람 유지 단계는 '수행'으로만 표시하고,
  // humanInLoop 지점은 지점 자체의 명시 문구(승인 포함 여부)로만 검토·승인을 나눈다.
  // 수행 판정만으로 승인 요건을 추론하지 않는다.
  const humanClauses: string[] = [];
  const performSteps = d.stepAssessments.filter(s => s.verdict === "사람 유지").map(s => s.step);
  if (performSteps.length) humanClauses.push(`${names(performSteps)} 단계는 담당자가 직접 수행해야 합니다.`);
  const reviewPoints = d.humanInLoop.filter(point => !point.includes("승인"));
  const approvalPoints = d.humanInLoop.filter(point => point.includes("승인"));
  if (reviewPoints.length) humanClauses.push(`${names(reviewPoints)} 지점에서는 담당자 검토가 필요합니다.`);
  if (approvalPoints.length) humanClauses.push(`${names(approvalPoints)} 지점에서는 담당자 승인이 필요합니다.`);
  if (humanClauses.length) parts.human = humanClauses.join(" ");
  if (executionGate(d) === "blocked") parts.check = "현재 진행 보류 상태로, 차단 사유를 해결한 뒤 재진단이 필요합니다.";
  else {
    // 건수는 확인할 사항 영역에 실제로 표시되는 확인 필요 항목 수와 같은 기준을 쓴다
    // (추가 질문과 주제가 겹치는 항목은 질문 영역에서 확인하므로 세지 않는다).
    const needCount = visibleDiagnosisCheckItems(d).filter(item => item.kind === "need").length;
    if (needCount) parts.check = `구현 전 확인 ${needCount}건`;
    else if (d.followUpQuestions.length) parts.check = `구현 전에 추가 질문 ${d.followUpQuestions.length}건에 대한 답변이 필요합니다.`;
  }
  return parts;
}
export function diagnosisSummarySentences(d: AxDiagnosis): string[] {
  const parts = diagnosisSummaryParts(d);
  return [parts.verdictSentence, parts.human, parts.check].filter((s): s is string => !!s).slice(0, 3);
}
export type AxCheckItem = { title: string; desc?: string; badge: string; kind: "need" | "done" | "block" };
/** Deduped display items for the diagnosis "확인할 사항" area. Same topic from multiple sources shows once; independent conditions are kept. */
export function diagnosisCheckItems(d: AxDiagnosis): AxCheckItem[] {
  const items: AxCheckItem[] = [];
  if (executionGate(d) === "blocked") {
    for (const reason of gateBlockReasons(d)) items.push({ title: reason, badge: "보류 사유", kind: "block" });
  }
  const seen = new Set<string>();
  for (const c of d.technicalChecks) {
    const key = c.topic.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push({ title: c.topic, desc: c.note.trim() || undefined, badge: c.status === "확인됨" ? "확인됨" : "확인 필요", kind: c.status === "확인됨" ? "done" : "need" });
  }
  return items;
}
/** Display-only: 확인할 사항 중 추가 질문이 같은 주제를 묻고 있는 항목은 질문 영역에서
 * 확인하므로 목록에서 중복 표시하지 않는다. 주제 판정은 policy의 선행 조건 주제 키와 같은
 * 기준(주제 키 일치·포함)을 쓰며, 서로 다른 주제(예: API 제공 여부 vs API 접근 권한)는 합치지 않는다.
 * 보류 사유·확인됨 항목은 질문과 성격이 달라 항상 유지한다. 원본 데이터는 변경하지 않는다. */
export function visibleDiagnosisCheckItems(d: AxDiagnosis): AxCheckItem[] {
  const items = diagnosisCheckItems(d);
  if (!d.followUpQuestions.length) return items;
  const questionKeys = d.followUpQuestions.map(q => prerequisiteTopicKey(q)).filter(key => key.length >= 3);
  if (!questionKeys.length) return items;
  return items.filter(item => {
    if (item.kind !== "need") return true;
    const key = prerequisiteTopicKey(item.title);
    if (key.length < 3) return true;
    return !questionKeys.some(qk => qk === key || qk.startsWith(key) || key.startsWith(qk));
  });
}
/** Display-only: 다음 행동을 실제 확인 항목으로 구체화한다. 정책 판정·nextAction() 출력은
 * 바꾸지 않고, 단독 라벨만 노출되는 위치(TOP 목록·매트릭스 상세)에서 렌더층이 첫 항목을
 * 덧붙인다. 원본에 없는 확인 대상·결정 사항은 만들지 않는다: 모든 문구는 진단 데이터
 * (차단 사유·추가 질문·선행 필수 조건·기존 nextAction)에서 가져온다. */
export interface ConcreteNextAction { label: string; detail?: string }
/** 표시 후보에서 공백뿐인 항목을 건너뛴다. 원본 데이터의 빈 문자열을 안내 문구로 노출하지 않는다. */
function firstNonBlank(items: string[]): string | undefined {
  return items.find(item => item.trim().length > 0);
}
export function concreteNextAction(d: AxDiagnosis): ConcreteNextAction {
  const gate = executionGate(d);
  if (gate === "blocked") {
    const reason = firstNonBlank(gateBlockReasons(d));
    return reason ? { label: "차단 사유 해결", detail: reason } : { label: nextAction(d).label };
  }
  if (d.informationSufficiency === "needs-check") {
    if (d.followUpQuestions.length) return { label: "추가 질문 답변", detail: d.followUpQuestions[0] };
    // 질문이 없으면 선택 항목만으로 된 확인 목록을 필수 조치처럼 안내하지 않는다.
    // 필수 선행 조건이 있을 때만 그 첫 항목을 쓰고, 없으면 정책 라벨로 돌아간다.
    // (원본 근거가 전혀 없으면 정책 대체 안내가 목록에 들어갈 수 있으므로, 원본 유무를 먼저 확인한다.)
    const hasPrimary = d.technicalChecks.some(c => c.status !== "확인됨" && c.required !== false)
      || d.decisionGate.reasons.some(r => r.trim().length > 0);
    if (!hasPrimary) return { label: nextAction(d).label };
    const required = firstNonBlank(splitGatePrerequisites(d).required);
    return required ? { label: "확인할 사항 검토", detail: required } : { label: nextAction(d).label };
  }
  if (gate === "conditional") {
    const hasPrimary = d.technicalChecks.some(c => c.status !== "확인됨" && c.required !== false)
      || d.decisionGate.reasons.some(r => r.trim().length > 0);
    if (!hasPrimary) return { label: nextAction(d).label };
    const required = splitGatePrerequisites(d).required;
    const first = firstNonBlank(required);
    if (first) {
      // "외 N건"은 이 표시 목록(필수 선행 조건)의 잔여 행 수이며, 전체 미해결 조건 총수가 아니다.
      const rest = required.filter(item => item.trim().length > 0).length - 1;
      return { label: "먼저 확인", detail: rest > 0 ? `${first} 외 ${rest}건` : first };
    }
    return { label: nextAction(d).label };
  }
  return { label: nextAction(d).label };
}
/** Display-only: 통합 업무 목록의 다음 행동 표기. concreteNextAction()의 판정·우선순위·
 * 원본 문구는 바꾸지 않고 렌더층에서만 정리한다: "먼저 확인" 중간 문구와 " — " 하이픈
 * 구분자를 제거하고, 최우선 항목 1건 + 나머지 실제 건수("외 N건") 형태로 표시한다.
 * 0건이면 정책 라벨 그대로, 1건이면 외 N건을 붙이지 않는다. */
export function formatUnifiedNextAction(concrete: ConcreteNextAction): string {
  const detail = concrete.detail ?? "";
  const countMatch = / 외 (\d+)건$/u.exec(detail);
  const countSuffix = countMatch ? ` 외 ${countMatch[1]}건` : "";
  const coreRaw = countMatch ? detail.slice(0, countMatch.index) : detail;
  if (concrete.label === "먼저 확인") {
    // 최우선 항목의 첫 단락만 쓴다. "확인 필요" 같은 반복 접미사를 정리하고,
    // 명사형 항목이면 실제 필요한 행동이 보이도록 "확인"을 붙인다.
    const first = coreRaw.split(/ — | - /u)[0]?.trim() ?? "";
    const stripped = first.replace(/ 확인 필요$/u, "").replace(/ 필요$/u, "").trim();
    if (!stripped) return concrete.label;
    const verbEnd = /(확인|답변|검토|입력|선택|연결|제공|작성|등록|수집|전송|업로드|적용|설정|구성|점검|승인|요청|전달|공유|비교|분석|정리|준비|수정|보완|삭제|이동|실행)$/u;
    return verbEnd.test(stripped) ? `${stripped}${countSuffix}` : `${stripped} 확인${countSuffix}`;
  }
  const joined = detail ? `${concrete.label} ${coreRaw}` : concrete.label;
  return `${joined.replace(/ — /gu, " ")}${countSuffix}`;
}
/** Display-only: 구현 전 확인 항목의 실제 확인·수정 위치. 정책 판정·원본 데이터는
 * 바꾸지 않고, 항목 주제·비고·출처만으로 이동 대상을 정한다. 전용 편집 UI가 없는
 * 항목(출력 컬럼 미확정 등)은 이동 버튼을 만들지 않고 안내만 남긴다. */
export type PrecheckTarget =
  | { kind: "decision"; id?: string }
  | { kind: "hitl" }
  | { kind: "plan" }
  | { kind: "register" }
  | { kind: "checks" }
  | { kind: "none"; guidance: string };
export function resolvePrecheckTarget(item: { topic: string; note?: string; tone?: AxCheckTone; origin?: "check" | "extra" | "conflict" | "block" }): PrecheckTarget {
  const text = `${item.topic} ${item.note ?? ""}`;
  if (/출력 컬럼/u.test(text)) return { kind: "none", guidance: "전용 편집 화면이 없습니다. 출력 컬럼을 확정하려면 업무 등록 정보를 수정한 뒤 다시 진단하세요." };
  // D번호가 하나만 언급되면 해당 결정 지점 행으로, 여러 개면(예: D1·D2·D3·D7이 함께 언급된 경우) 섹션 전체로 연결한다.
  const dMatches = [...new Set([...item.topic.matchAll(/\bD([1-7])\b/gu), ...(item.note ?? "").matchAll(/\bD([1-7])\b/gu)].map(m => m[1]))];
  if (dMatches.length === 1) return { kind: "decision", id: `D${dMatches[0]}` };
  if (dMatches.length > 1) return { kind: "decision" };
  // 기준 충돌(결정 지점·예외 충돌, 수치 충돌)은 전용 편집기가 없으므로, 규칙을
  // 확인·수정할 수 있는 결정 지점 영역으로 연결한다. 무관한 질문·AS-IS 영역으로는 이동하지 않는다.
  if (item.origin === "conflict") return { kind: "decision" };
  if (/HITL/u.test(text)) return { kind: "hitl" };
  // HITL 보류 항목은 단계별 HITL 검토 표에서 확인한다.
  if (item.tone === "held") return { kind: "hitl" };
  if (/구현 계획/u.test(text)) return { kind: "plan" };
  if (/업무 (정보|등록|설명)/u.test(text)) return { kind: "register" };
  return { kind: "checks" };
}
/** Display-only: 이동 대상별 버튼 문구. "업무 진단에서 확인" 반복을 쓰지 않는다. */
export function precheckTargetLabel(target: PrecheckTarget): string {
  switch (target.kind) {
    case "decision": return "규칙 확인";
    case "hitl": return "HITL 검토";
    case "plan": return "계획 검토";
    case "register": return "업무 정보 수정";
    case "checks": return "확인 사항 보기";
    case "none": return "";
  }
}
/** Data-only bullets for the matrix "핵심 판단 근거" area: the strongest value driver's rationale and the binding constraint.
 * The axis scores and classification already shown in the score cards and header badges are not repeated here. */
export function matrixRationaleBullets(d: AxDiagnosis): string[] {
  const a = axes(d), gate = executionGate(d);
  const bullets: string[] = [];
  const driver = (["repetition", "regularity", "dataStructure", "systemAccess"] as const)
    .map(key => d.factors.find(f => f.key === key)!)
    .sort((x, y) => factorEffectiveValue(y) - factorEffectiveValue(x))[0];
  if (driver && driver.rationale.trim()) bullets.push(`${FACTOR_LABELS[driver.key]} ${factorEffectiveValue(driver)}점 — ${driver.rationale.trim()}`);
  const constraints: string[] = [];
  if (gate === "blocked") { const reason = gateBlockReasons(d)[0]; if (reason) constraints.push(`진행 보류: ${reason}`); }
  else {
    if (a.judgment >= 4) constraints.push("담당자 판단 필요도가 높아 담당자 수행 유지");
    if (a.risk >= 4) constraints.push("운영 위험이 높음");
  }
  if (constraints.length) bullets.push(constraints.join(" · "));
  return bullets.slice(0, 3);
}
/** Icon for a check item chosen by topic keywords; visual only, never changes the underlying condition. */
export function AxCheckIcon({ title }: { title: string }) {
  const t = title.toLowerCase();
  const Icon = /excel|스프레드시트|csv|파일|파싱/.test(t) ? FileSpreadsheet
    : /api|시스템|연동|인터페이스/.test(t) ? Plug
    : /보안|권한|접근|인증/.test(t) ? ShieldCheck
    : /데이터/.test(t) ? Database : ClipboardList;
  return <Icon size={18} aria-hidden="true" />;
}
export function AxResultSummary({ task }: { task: AxTask }) {
  const d = task.diagnosis;
  if (!d) return null;
  const level = automationLevel(d), profile = executionProfile(d);
  const groups = [
    { verdict: "자동화", label: "자동화 적합 단계", icon: Settings2 },
    { verdict: "AI 보조", label: "AI 보조 단계", icon: BrainCircuit },
    { verdict: "사람 유지", label: "담당자 수행 단계", icon: UserRound },
  ] as const;
  return <section className="ax-section ax-panel ax-result-summary" aria-label="진단 요약">
    <header className="ax-result-head"><h3>진단 요약</h3><small>현재 상태와 핵심 결과</small></header>
    <div className="ax-result-band">
      <div className="ax-result-meta">
        <AxLevelBadge level={level} variant="info" className="ax-result-level" suffix={level.provisional ? " · 잠정" : ""} />
        <span className="ax-gate-badge" data-gate={profile.gate}>{GATE_LABELS[profile.gate]}</span>
        {d.sourceNote ? <p>{d.sourceNote}</p> : null}
        <small>아래 단계별 건수는 진단상 목표 적합성으로, 현재 구현·배포 가능 범위가 아닙니다.</small>
      </div>
    </div>
    <div className="ax-result-counts">{groups.map(({ verdict, label, icon: Icon }) => <div className="ax-result-count" data-verdict={verdict} key={verdict}>
      <span className="ax-result-count-icon"><Icon aria-hidden="true" /></span><span>{label}</span>
      <strong>{d.stepAssessments.filter(step => step.verdict === verdict).length}개</strong>
    </div>)}</div>
  </section>;
}

export interface AxProcessReviewProps {
  taskId: string;
  reviews: HitlReview[];
  onSaveReview: (review: Omit<HitlReview, "id" | "reviewedAt" | "updatedAt"> & { id?: string }) => { saved: boolean; reason?: string };
}

export function AxProcess({ diagnosis: d, reviewProps }: { diagnosis: AxDiagnosis; reviewProps?: AxProcessReviewProps }) {
  const core = [
    { label: "업무 목적", icon: Target, value: d.asIs.purpose || "기재된 내용 없음" },
    { label: "시작 조건", icon: Play, value: d.asIs.trigger || "기재된 내용 없음" },
    { label: "입력 데이터", icon: Database, value: <AxList items={d.asIs.inputs} /> },
    { label: "출력 결과", icon: FileOutput, value: <AxList items={d.asIs.outputs} /> },
  ];
  return <>
    <section className="ax-section ax-panel ax-process-card">
      <header className="ax-process-head"><h3>AS-IS · 현재 업무</h3><small>현재 업무 구조 분석</small></header>
      <div className="ax-process-core">{core.map(({ label, icon: Icon, value }) => <div className="ax-process-field" key={label}>
        <span className="ax-process-icon"><Icon aria-hidden="true" /></span><div><h4>{label}</h4>{typeof value === "string" ? <p>{value}</p> : value}</div>
      </div>)}</div>
      {d.asIs.exceptions.length || d.asIs.humanDecisions.length ? <div className="ax-process-extras">
        {d.asIs.exceptions.length ? <div className="ax-process-extra" data-kind="exception"><AlertTriangle aria-hidden="true" /><div><h4>주요 예외 상황</h4><AxList items={d.asIs.exceptions} /></div></div> : null}
        {d.asIs.humanDecisions.length ? <div className="ax-process-extra" data-kind="human"><ClipboardList aria-hidden="true" /><div><h4>담당자 판단 사항</h4><AxList items={d.asIs.humanDecisions} /></div></div> : null}
      </div> : null}
      {d.asIs.systems.length ? <div className="ax-process-systems"><MonitorCog aria-hidden="true" /><p><strong>사용 시스템</strong><span aria-hidden="true"> · </span>{d.asIs.systems.join(" · ")}</p></div> : null}
    </section>
    <AxStepTable key={reviewProps?.taskId ?? "static"} diagnosis={d} headers={["업무 단계", "판정", "담당", "판단 근거"]} reviewProps={reviewProps} />
    {reviewProps ? <AxRiskReview key={reviewProps.taskId} diagnosis={d} reviewProps={reviewProps} /> : null}
    <AxToBe diagnosis={d} />
  </>;
}

/** 검토 건수 표시: 전체·검토 완료·검토 필요를 0건이어도 항상 같은 형식으로 보여
 * 접힌 상태에서도 상태를 알 수 있게 한다 (집계 자체는 호출부의 유효성 검증 결과). */
function ReviewCounts({ total, completed }: { total: number; completed: number }) {
  return <>
    <span>전체 {total}</span>
    <span aria-hidden="true">·</span>
    <span>검토 완료 {completed}</span>
    <span aria-hidden="true">·</span>
    <span>검토 필요 {total - completed}</span>
  </>;
}

/** 검토 영역 공통 COSS 아코디언: 단계별 자동화 판단·위험·확인사항 검토·구현 계획 검토·
 * 구현 전 확인이 같은 카드·헤더(아이콘 + 제목 | 상태·건수 + 셰브론) 규격을 쓴다.
 * 셰브론은 COSS AccordionTrigger 기본 지시자(접힘 아래·펼침 위)이며, 헤더 전체가
 * 트리거라 클릭·Enter·Space·aria-expanded를 Base UI가 처리한다. 펼침 상태는 호출부가
 * 소유한다. locked는 항목 검토 패널이 열려 입력 중일 때 접기를 막는 입력 보호다. */
function AxReviewAccordion({ label, icon: Icon, tone = "primary", meta, open, onOpenChange, locked = false, keepMounted = false, id, className, headClassName, children }: {
  label: string;
  icon: LucideIcon;
  tone?: "primary" | "warning";
  meta: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locked?: boolean;
  keepMounted?: boolean;
  id?: string;
  className?: string;
  headClassName?: string;
  children: React.ReactNode;
}) {
  return <section className={className ? `ax-section ${className}` : "ax-section"} id={id} aria-label={label}>
    <Accordion value={open ? ["review"] : []} onValueChange={values => { if (!locked) onOpenChange(values.includes("review")); }} keepMounted={keepMounted}>
      <AccordionItem value="review" className="border-b-0">
        <div className="ax-hitl-table-card">
          <AccordionTrigger className={`ax-hitl-table-trigger items-center rounded-none py-0${headClassName ? ` ${headClassName}` : ""}`} disabled={locked}>
            <span className="ax-hitl-table-header">
              <span className="ax-hitl-table-title">
                <span className="ax-hitl-table-icon" data-tone={tone}><Icon size={19} aria-hidden="true" /></span>
                <span className="ax-hitl-table-heading">{label}</span>
              </span>
              <span className="ax-hitl-table-counts">{meta}</span>
            </span>
          </AccordionTrigger>
          <AccordionPanel className="ax-hitl-table-panel pb-0">{children}</AccordionPanel>
        </div>
      </AccordionItem>
    </Accordion>
  </section>;
}

/** 위험·확인사항 검토 섹션 - 테이블형 UI.
 * 접기 기본값: 전부 유효하게 검토 완료됐으면 접힘, 검토 필요 항목이 있으면 펼침.
 * 사용자가 직접 바꾼 상태는 유지하고, 항목 패널이 열려 있는 동안에는 입력 보호를 위해
 * 펼침을 강제하고 접기 조작을 막는다. */
function AxRiskReview({ diagnosis: d, reviewProps }: { diagnosis: AxDiagnosis; reviewProps: AxProcessReviewProps }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const items = extractReviewableItems(d).filter(i => i.type === "risk");
  if (!items.length) return null;

  // 검토 완료 = confirmed이면서 현재 원본과 유효하게 연결된 기록만 (구현 계획 검토와 동일한
  // hitl.ts 유효성 검증 재사용). editing·stale·해시 불일치 기록은 검토 필요로 집계한다.
  const validKeys = validConfirmedKeySet(items, reviewProps.reviews);
  const completedCount = items.filter(item => validKeys.has(item.key)).length;
  const panelOpen = openKey !== null;
  const tableOpen = panelOpen ? true : (userOpen ?? items.length - completedCount > 0);

  return <AxReviewAccordion label="위험·확인사항 검토" icon={ShieldAlert} tone="warning" meta={<ReviewCounts total={items.length} completed={completedCount} />} open={tableOpen} onOpenChange={setUserOpen} locked={panelOpen} keepMounted>
      <div style={{ overflowX: "auto" }}>
        <table className="ax-hitl-table">
          <thead>
            <tr>
              <th className="col-type">구분</th>
              <th className="col-content">검토 내용</th>
              <th className="col-status">상태</th>
              <th className="col-action">작업</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => {
              const review = findReview({ reviews: reviewProps.reviews } as AxTaskV2, item.key);
              const displayState = reviewDisplayState(item, review, validKeys);
              const isOpen = openKey === item.key;
              return <>
                <tr key={item.key}>
                  <td className="col-type">
                    <span className="ax-hitl-type-badge ax-hitl-type-badge-plan">위험</span>
                  </td>
                  <td className="col-content">{item.text}</td>
                  <td className="col-status">
                    <span className="ax-hitl-status-dot" data-status={displayState.status}>{displayState.label}</span>
                  </td>
                  <td className="col-action">
                    <Button type="button" variant="outline" size="sm" onClick={() => setOpenKey(isOpen ? null : item.key)}>
                      {isOpen ? "닫기" : review ? "보기" : "검토"}
                    </Button>
                  </td>
                </tr>
                {isOpen ? <tr key={`${item.key}-panel`}>
                  <td colSpan={4} style={{ padding: 0, borderBottom: "1px solid var(--line-soft)" }}>
                    <div style={{ padding: "16px 20px" }}>
                      <HitlReviewPanel
                        key={item.key}
                        item={item}
                        review={editingKey === item.key ? { ...review!, status: "editing" as const } : review}
                        onSave={(r) => { const result = reviewProps.onSaveReview(r); if (result.saved) setEditingKey(null); }}
                        onCancel={() => { setEditingKey(null); setOpenKey(null); }}
                        onEdit={() => setEditingKey(item.key)}
                      />
                    </div>
                  </td>
                </tr> : null}
              </>;
            })}
          </tbody>
        </table>
      </div>
  </AxReviewAccordion>;
}
function AxStepTable({ diagnosis: d, headers, reviewProps }: { diagnosis: AxDiagnosis; headers: [string, string, string, string]; reviewProps?: AxProcessReviewProps }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  // 판단 표에 없는 AS-IS 단계는 표시하지 않는다 (원본 데이터 변경 없음).
  // AS-IS 원본 단계는 진단 카드·01~04 지시문에 그대로 유지된다.
  const items = reviewProps ? extractReviewableItems(d) : [];
  const itemByStep = new Map<string, ReviewableItem>();
  for (const item of items) {
    if (item.type === "step" && !itemByStep.has(item.text.split(":")[0])) {
      // step 이름으로 매칭 (첫 번째 occurrence)
      const stepName = d.stepAssessments.find(s => item.key.includes(s.step.slice(0, 8)))?.step;
      if (stepName) itemByStep.set(stepName, item);
    }
  }
  // 간단한 매칭: 순서대로 step 항목과 연결
  const stepItems = items.filter(i => i.type === "step");

  // 검토가 있는 경우 테이블형 UI 사용
  if (reviewProps) {
    // 검토 완료 = confirmed이면서 현재 원본과 유효하게 연결된 기록만 (구현 계획 검토와 동일한
    // hitl.ts 유효성 검증 재사용). editing·stale·해시 불일치 기록은 검토 필요로 집계한다.
    const validKeys = validConfirmedKeySet(stepItems, reviewProps.reviews);
    const completedCount = stepItems.filter(item => validKeys.has(item.key)).length;
    // 접기 기본값은 AxRiskReview와 같은 규칙: 전부 검토 완료면 접힘, 검토 필요가 있으면
    // 펼침. 항목 패널이 열려 있는 동안에는 입력 보호를 위해 펼침을 강제한다.
    const panelOpen = openKey !== null;
    const tableOpen = panelOpen ? true : (userOpen ?? stepItems.length - completedCount > 0);

    return <AxReviewAccordion id="ax-step-review" label="단계별 자동화 판단" icon={ListChecks} meta={<ReviewCounts total={stepItems.length} completed={completedCount} />} open={tableOpen} onOpenChange={setUserOpen} locked={panelOpen} keepMounted>
        <div style={{ overflowX: "auto" }}>
          <table className="ax-hitl-table ax-hitl-step-table">
            <thead>
              <tr>
                <th>업무 단계</th>
                <th>판정</th>
                <th>담당</th>
                <th>판단 근거</th>
                <th className="col-status">상태</th>
                <th className="col-action">작업</th>
              </tr>
            </thead>
            <tbody>
              {d.stepAssessments.length ? d.stepAssessments.map((s, i) => {
                const item = stepItems[i];
                const review = item ? findReview({ reviews: reviewProps.reviews } as AxTaskV2, item.key) : undefined;
                const displayState = item ? reviewDisplayState(item, review, validKeys) : undefined;
                const isOpen = item && openKey === item.key;
                return <>
                  <tr key={i}>
                    <td><span className="ax-step-number">{String(i + 1).padStart(2, "0")}</span>{s.step}</td>
                    <td><Badge variant="outline" className="ax-verdict-badge" data-verdict={s.verdict}>{VERDICT_LABELS[s.verdict]}</Badge></td>
                    <td>{OWNER_LABELS[s.owner]}</td>
                    <td>{s.note}</td>
                    <td className="col-status">
                      {displayState ? <span className="ax-hitl-status-dot" data-status={displayState.status}>{displayState.label}</span>
                        : <span className="ax-hitl-status-dot" data-status="pending">검토 전</span>}
                    </td>
                    <td className="col-action">
                      {item ? <Button type="button" variant="outline" size="sm" onClick={() => setOpenKey(isOpen ? null : item.key)}>
                        {isOpen ? "닫기" : review ? "보기" : "검토"}
                      </Button> : null}
                    </td>
                  </tr>
                  {isOpen && item ? <tr key={`${i}-review`}>
                    <td colSpan={6} style={{ padding: 0, borderBottom: "1px solid var(--line-soft)" }}>
                      <div style={{ padding: "16px 20px" }}>
                        <HitlReviewPanel
                          key={item.key}
                          item={item}
                          review={editingKey === item.key ? { ...review!, status: "editing" as const } : review}
                          onSave={(r) => { const result = reviewProps.onSaveReview(r); if (result.saved) setEditingKey(null); }}
                          onCancel={() => { setEditingKey(null); setOpenKey(null); }}
                          onEdit={() => setEditingKey(item.key)}
                        />
                      </div>
                    </td>
                  </tr> : null}
                </>;
              }) : <tr><td colSpan={6}>기재된 단계 없음</td></tr>}
            </tbody>
          </table>
        </div>
    </AxReviewAccordion>;
  }

  // 검토가 없는 경우 기존 테이블 유지
  return <section className="ax-section ax-panel" aria-label="단계별 자동화 판단"><h3>단계별 자동화 판단</h3>
    <div className="ax-table-wrap"><table className="ax-step-table"><thead><tr>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{d.stepAssessments.length ? d.stepAssessments.map((s, i) => {
    return <tr key={i}>
      <td><span className="ax-step-number">{String(i + 1).padStart(2, "0")}</span>{s.step}</td>
      <td><Badge variant="outline" className="ax-verdict-badge" data-verdict={s.verdict}>{VERDICT_LABELS[s.verdict]}</Badge></td>
      <td>{OWNER_LABELS[s.owner]}</td><td>{s.note}</td>
    </tr>;
  }) : <tr><td colSpan={4}>기재된 단계 없음</td></tr>}</tbody></table></div>
  </section>;
}
function AxToBe({ diagnosis: d }: { diagnosis: AxDiagnosis }) {
  const icons = { 시스템: Settings2, AI: Bot, 사용자: UserRound } as const;
  const norm = (t: string) => t.replace(/\s+/g, "");
  // 단계별 판단 표에서 같은 단계의 판단 근거로 이미 제공된 설명은 TO-BE에서 반복하지 않는다.
  // 표에 없는 설명은 TO-BE에만 있는 정보이므로 그대로 유지한다 (원본 데이터는 변경하지 않음).
  // 단계명 자체와 같은 설명도 제목의 반복이라 표시하지 않는다.
  const descriptionFor = (s: AxDiagnosis["toBe"][number]): string => {
    const desc = s.description.trim();
    if (!desc) return "";
    if (norm(desc) === norm(s.step)) return "";
    const match = d.stepAssessments.find(a => a.step === s.step)
      ?? d.stepAssessments.find(a => { const an = norm(a.step), sn = norm(s.step); return !!an && !!sn && (an.includes(sn) || sn.includes(an)); });
    if (match?.note.trim()) {
      const dn = norm(desc), nn = norm(match.note);
      if (dn === nn || dn.includes(nn) || nn.includes(dn)) return "";
    }
    return desc;
  };
  // TO-BE 단계에는 미확정 기술 확인 안내를 표시하지 않는다. 확인 사항 자체는
  // 진단 카드·02 구현 전 확인사항·실행 로드맵에서 그대로 확인할 수 있으며, 원본
  // 진단 데이터(technicalChecks·toBe)는 이 컴포넌트에서 변경하지 않는다.
  return <section className="ax-section ax-panel ax-tobe-card"><header className="ax-process-head"><h3>TO-BE · 역할과 흐름 (목표 프로세스)</h3><small>자동화 도입 후 예상 업무 흐름 · 구현 완료 아님</small></header>
    {d.toBe.length ? <ol className="ax-tobe-flow">{d.toBe.map((s, i) => { const Icon = icons[s.owner]; const desc = descriptionFor(s); return <li className="ax-tobe-item" data-owner={s.owner} key={i}>
      <span className="ax-tobe-icon"><Icon aria-hidden="true" /></span><strong>{s.step}</strong><span>{OWNER_LABELS[s.owner]}</span>{desc ? <p>{desc}</p> : null}
      {i < d.toBe.length - 1 ? <ArrowRight className="ax-tobe-arrow" aria-hidden="true" /> : null}
    </li>; })}</ol> : <p className="ax-muted">기재된 목표 업무 단계 없음</p>}
  </section>;
}
export function AxCopyButton({ text, label, iconOnly = false }: { text: string; label: string; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function copy() {
    if (timer.current) clearTimeout(timer.current);
    setCopied(false);
    let success = false;
    try {
      await navigator.clipboard.writeText(text);
      success = true;
    } catch {
      const holder = document.createElement("textarea");
      holder.value = text;
      holder.setAttribute("readonly", "");
      holder.style.position = "fixed";
      holder.style.opacity = "0";
      document.body.append(holder);
      holder.select();
      try { success = document.execCommand("copy"); } catch { success = false; } finally { holder.remove(); }
    }
    setFailed(!success);
    if (success) {
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 1_600);
    }
  }
  return <>
    <span className="sr-only" aria-live="polite">{copied ? "복사 완료" : ""}</span>
    <Button type="button" variant={iconOnly ? "ghost" : "default"} size={iconOnly ? "icon-xs" : "default"} className={iconOnly ? "ax-guide-copy-button" : "ax-copy-button"} data-copied={copied ? "true" : undefined} aria-label={label} onClick={() => void copy()}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{iconOnly ? null : "복사"}</Button>
    {failed ? <p className="ax-copy-error" role="status">복사하지 못했습니다. 직접 선택해 복사해주세요.</p> : null}
  </>;
}

// Guide strings use backticks to mark commands without introducing HTML into data.
// Bare https:// URLs are rendered as accessible external links.
const URL_PATTERN = /(https:\/\/[^\s·,)]+)/gu;
function AxGuideText({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("`")) return <code className="ax-cmd" key={i}>{part.slice(1, -1)}</code>;
    const segments = part.split(URL_PATTERN);
    return segments.map((segment, j) => {
      URL_PATTERN.lastIndex = 0;
      return URL_PATTERN.test(segment)
        ? <a key={`${i}-${j}`} href={segment} target="_blank" rel="noopener noreferrer" className="ax-guide-link">{segment}</a>
        : <span key={`${i}-${j}`}>{segment}</span>;
    });
  })}</>;
}
function AxGuideBlockView({ block, listStyle }: { block: AxGuideBlock; listStyle?: "bullets" }) {
  if (block.kind === "code") {
    const label = block.label ?? "PowerShell";
    const ariaLabel = label === "PowerShell" ? "PowerShell 명령" : label === ".gitignore" ? ".gitignore 예시" : "예시";
    return <>
      <div className="ax-guide-code-wrap"><pre className={block.singleLine ? "ax-guide-code ax-guide-code--single-line" : "ax-guide-code"} aria-label={ariaLabel}><span className="ax-guide-code-label" aria-hidden="true">{label}</span><code>{block.prose ? guideProseDisplayText(block.lines) : guideCodeDisplayText(block.lines)}</code></pre><AxCopyButton key={block.lines.join("\n")} text={block.lines.join("\n")} label={`${ariaLabel} 복사`} iconOnly /></div>
      {block.notes?.length ? <ul className="ax-guide-code-notes ax-guide-list" role="list">{block.notes.map((note, i) => <li key={i}><span className="ax-guide-marker" aria-hidden="true">•</span><span className="ax-guide-text">{note}</span></li>)}</ul> : null}
    </>;
  }
  if (block.kind === "steps") {
    const checklist = block.items.every(item => item.startsWith("□ "));
    const items = block.items.map((item, i) => <li key={i}><span className="ax-guide-marker" aria-hidden="true">{checklist ? "□" : listStyle === "bullets" ? "•" : String(i + 1).padStart(2, "0")}</span><span className="ax-guide-text"><AxGuideText text={checklist ? item.slice(2) : item} /></span></li>);
    return checklist || listStyle === "bullets" ? <ul className="ax-guide-list" role="list">{items}</ul> : <ol className="ax-guide-list" role="list">{items}</ol>;
  }
  if (block.kind === "table") {
    return <div className="ax-guide-table-wrap" role="region" aria-label="비교표" tabIndex={0}>
      <table className="ax-guide-table">
        <thead><tr>{block.headers.map((header, i) => <th key={i} scope="col"><AxGuideText text={header} /></th>)}</tr></thead>
        <tbody>{block.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => j === 0 ? <th key={j} scope="row"><AxGuideText text={cell} /></th> : <td key={j}><AxGuideText text={cell} /></td>)}</tr>)}</tbody>
      </table>
    </div>;
  }
  if (block.kind === "git-flow") return <AxGitFlowView block={block} />;
  return <p><AxGuideText text={block.text} /></p>;
}
function AxGuideSectionView({ section, completion = false, warning = false, collapsed = section.collapsed }: { section: AxGuideSection; completion?: boolean; warning?: boolean; collapsed?: boolean }) {
  const content = <>
    {section.when ? <p className="ax-guide-when"><AxGuideText text={section.when} /></p> : null}
    {section.blocks.map((block, i) => <AxGuideBlockView key={i} block={block} listStyle={section.listStyle} />)}
  </>;
  const brandLogo = section.brand === "vercel"
    ? <img src="/brand/vercel-logo.svg" alt="" aria-hidden="true" className="ax-guide-brand-logo" />
    : section.brand === "cloudflare"
    ? <img src="/brand/cloudflare-logo.svg" alt="" aria-hidden="true" className="ax-guide-brand-logo" />
    : null;
  return <section className={`ax-guide-section${completion ? " ax-guide-completion" : ""}${warning ? " ax-guide-warning" : ""}${section.className ? ` ${section.className}` : ""}`}>
    {collapsed ? <Accordion className="ax-guide-terms"><AccordionItem value="terms">
      <AccordionTrigger className="ax-guide-terms-trigger"><span className="ax-guide-section-title">{brandLogo}{section.title}</span></AccordionTrigger>
      <AccordionPanel className="ax-guide-terms-panel">{content}</AccordionPanel>
    </AccordionItem></Accordion> : <><h5>{brandLogo}{completion ? <><CheckCircle2 aria-hidden="true" />완료 확인 · </> : warning ? <AlertTriangle aria-hidden="true" /> : null}{section.title}</h5>{content}</>}
  </section>;
}

const GIT_FLOW_STEP_ICONS = [Folder, GitBranch, FilePlus2, ClipboardList, CloudUpload, GitPullRequest, CircleCheck, GitMerge, Rocket, Monitor] as const;
const GIT_FLOW_GROUP_ICONS = [FileText, FileCode2, CloudUpload, Settings2, Rocket] as const;
/** Reference-faithful Git·GitHub work-flow diagram: 10 ordered cards, 5 group boxes, one notes box. Presentation only; guide data and logic are unchanged. */
function AxGitFlowView({ block }: { block: AxGitFlowBlock }) {
  return <div className="ax-git-flow">
    <div className="ax-git-flow-head">
      <div><p>{block.subtitle}</p></div>
    </div>
    <div className="ax-git-flow-track" role="list" aria-label="Git·GitHub 작업 순서">
      {block.steps.map((step, i) => {
        const Icon = GIT_FLOW_STEP_ICONS[i] ?? Folder;
        return <Fragment key={step.no}>
          <article className="ax-git-flow-card" data-tone={step.tone} role="listitem" aria-label={`${step.no} ${step.title}`}>
            <span className="ax-git-flow-no" aria-hidden="true">{step.no}</span>
            <span className="ax-git-flow-icon" aria-hidden="true"><Icon /></span>
            <h6>{step.title}</h6>
            <p>{step.description}</p>
            <span className="ax-git-flow-cmd">{step.command.map((line, j) => <span key={j}>{line}</span>)}</span>
          </article>
          {i < block.steps.length - 1 ? <ArrowRight aria-hidden="true" className="ax-git-flow-arrow" /> : null}
        </Fragment>;
      })}
    </div>
    <ul className="ax-git-flow-groups" role="list">
      {block.groups.map((group, i) => {
        const Icon = GIT_FLOW_GROUP_ICONS[i] ?? FileText;
        return <li key={group.range} className="ax-git-flow-group" data-tone={group.tone}>
          <div className="ax-git-flow-group-head"><Icon aria-hidden="true" /><h6>{group.range} {group.title}</h6></div>
          <ul role="list">{group.points.map((point, j) => <li key={j}>{point}</li>)}</ul>
        </li>;
      })}
    </ul>
    <div className="ax-git-flow-notes">
      <h6><Info aria-hidden="true" />추가 안내</h6>
      <ul role="list">{block.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>
    </div>
  </div>;
}

const SETUP_COURSES = [
  { title: "처음 한 번 준비", description: "필요한 프로그램 설치 후 정상 동작 확인", Icon: Download, first: 1, last: 1 },
  { title: "프로젝트 작업", description: "프로젝트 준비 → 지시문 전달 → 1차 MVP 구현·테스트", Icon: Folder, first: 2, last: 4 },
  { title: "GitHub·배포", description: "플랫폼·저장 조건 확인 → 배포 → 운영 기능 검증", Icon: CloudUpload, first: 5, last: 8 },
] as const;
const SETUP_ICONS = [Download, Folder, Clipboard, Terminal, CloudUpload, Database, GitBranch, Globe] as const;
const SETUP_COMPLETIONS = new Set(["GitHub 로그인 확인", "현재 위치 확인", "작업 시작 전 AI가 먼저 확인할 것", "테스트·빌드 확인", "실제 기능 확인", "GitHub에서 확인할 것", "실제 서비스 확인"]);
const SETUP_WARNINGS = new Set(["기존 .gitignore 확인", ".env와 .env.example", "이미 추적 중인 파일", "올리기 전 체크리스트", "git push가 곧 Production은 아닙니다", "먼저 현재 배포 환경 확인", "오류가 나면", "CI가 실패하면", "문제가 생기면", "되돌리기(Rollback)"]);
const SETUP_DETAILS: Record<string, true> = {};

function AxSetupGuide({ tool, instructionsId, onGoToInstructions }: { tool: AxToolId; instructionsId: string; onGoToInstructions: () => void }) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [intro, ...steps] = setupGuide(tool);
  const [firstTime, repeatWork, glossary] = intro.sections;
  const title = (value: string) => value.replace(/^STEP \d+ · /, "");
  function goToStep(index: number) {
    const heading = root.current?.querySelector<HTMLElement>(`[data-setup-step="${index + 1}"] > h4`);
    heading?.scrollIntoView({ behavior: "instant", block: "start" });
    heading?.focus({ preventScroll: true });
  }
  return <div className="ax-setup-tutorial" ref={root}>
    <header className="ax-tutorial-intro">
      <h3>설치부터 배포까지 따라 하기</h3>
      <p>{intro.purpose}</p>
      <ol className="ax-tutorial-flow" aria-label="진행 흐름">{SETUP_COURSES.map(({ title: name, Icon }) => <li key={name}><Icon aria-hidden="true" /><span>{name}</span></li>)}</ol>
    </header>
    <nav className="ax-tutorial-toc" aria-label="설치·시작 단계 목차">
      {steps.map((step, index) => <Button key={index} type="button" variant="ghost" size="sm" aria-controls={`${id}-step-${index + 1}`} onClick={() => goToStep(index)}><span>STEP {String(index + 1).padStart(2, "0")}</span><span className="ax-tutorial-toc-title">{title(step.title)}</span></Button>)}
    </nav>
    <div className="ax-tutorial-context">
      <section className="ax-tutorial-preflight" aria-labelledby={`${id}-preflight`}>
        <h4 id={`${id}-preflight`}><Info aria-hidden="true" />시작 전 알아두세요</h4>
        {[firstTime, repeatWork].map(section => <div className="ax-tutorial-preflight-group" key={section.title}>
          <h5>{section.title}</h5>
          {section.blocks.map((block, index) => <AxGuideBlockView block={block} key={index} />)}
        </div>)}
      </section>
      <section className="ax-tutorial-glossary" aria-label={glossary.title}>
        <Accordion className="ax-guide-terms"><AccordionItem value="terms">
          <AccordionTrigger className="ax-tutorial-terms-trigger" aria-label={glossary.title}>
            <span className="ax-tutorial-terms-title"><img src="/brand/github-mark.svg" alt="" aria-hidden="true" className="ax-tutorial-terms-logo" />{glossary.title}</span>
            <span className="ax-tutorial-terms-action" aria-hidden="true"><span>펼치기</span><span>접기</span></span>
          </AccordionTrigger>
          <AccordionPanel className="ax-tutorial-terms-panel">
            {glossary.blocks.map((block, blockIndex) => block.kind === "git-flow" ? <AxGitFlowView key={blockIndex} block={block} /> : block.kind === "steps" ? <dl key={blockIndex}>{block.items.map(term => {
              const split = term.indexOf(":");
              const name = term.slice(0, split);
              return <div key={term}><dt>{name === "환경변수(Environment Variable)" ? <><span>환경변수</span><span className="ax-tutorial-term-translation">(Environment Variable)</span></> : name}</dt><dd>{term.slice(split + 2)}</dd></div>;
            })}</dl> : block.kind === "text" ? <p key={blockIndex} className="ax-tutorial-terms-note">{block.text}</p> : null)}
          </AccordionPanel>
        </AccordionItem></Accordion>
      </section>
    </div>
    {SETUP_COURSES.map(course => <section className="ax-tutorial-course" aria-label={course.title} key={course.title}>
      <header className="ax-tutorial-course-head"><course.Icon aria-hidden="true" /><div><h3>{course.title}</h3><p>{course.description}</p></div></header>
      {steps.slice(course.first - 1, course.last).map((step, offset) => {
        const index = course.first - 1 + offset;
        const Icon = SETUP_ICONS[index];
        return <section className="ax-guide-step" data-setup-step={index + 1} aria-labelledby={`${id}-step-${index + 1}`} key={step.title}>
          <h4 id={`${id}-step-${index + 1}`} tabIndex={-1}><span className="ax-tutorial-step-no">STEP {String(index + 1).padStart(2, "0")}<Icon aria-hidden="true" /></span><span className="ax-guide-step-title"><span>{title(step.title)}</span></span></h4>
          {step.purpose ? <p className="ax-guide-purpose">{step.purpose}</p> : null}
          <p className="ax-tutorial-action-label"><Terminal aria-hidden="true" />실행 방법</p>
          {step.sections.map(section => <AxGuideSectionView key={section.title} section={section} completion={SETUP_COMPLETIONS.has(section.title)} warning={SETUP_WARNINGS.has(section.title)} collapsed={section.collapsed || (section.title in SETUP_DETAILS)} />)}
          {index === 2 ? <Button type="button" variant="default" className="ax-guide-step-cta" onClick={onGoToInstructions} aria-controls={instructionsId}>올인원 지시문으로 이동</Button> : null}
        </section>;
      })}
    </section>)}
  </div>;
}

/** One heading pattern: optional filled number badge, title and an inline muted purpose line. */
function AxPlanHeading({ no, title, description, id }: { no?: string; title: string; description?: string; id?: string }) {
  return <div className="ax-plan-title"><h4 id={id} tabIndex={id ? -1 : undefined}>{no ? <><span className="ax-plan-no">{no}</span> </> : null}{title}</h4>{description ? <p className="ax-plan-desc">{description}</p> : null}</div>;
}
/** ① 구현 전 확인: 검토 영역 공통 아코디언(기본 접힘)에 제목 + 미해결 건수만 표시한다.
 * 펼치면 배지 건수와 같은 집계 기준의 실제 미해결 항목을 짧은 목록으로 보여준다
 * (차단 사유 + 미완료 기술 확인 + 미완료 추가 확인 + 기준 충돌). 항목을 펼쳐 보는
 * 것만으로 완료 처리하지 않으며, 확인 위치는 안내 문구로만 표시하고 개별 이동
 * 버튼은 만들지 않는다. 의미상 중복을 확정할 수 없는 항목은 임의로 합치거나
 * 숨기지 않으므로, 목록 길이는 항상 배지 건수와 같다.
 * 항목별 이동 대상 판정(resolvePrecheckTarget)은 단위 테스트가 유지하므로 삭제하지 않는다. */
export type PrecheckListItem = { title: string; detail: string; target: PrecheckTarget };
export function precheckListItems(summary: AxPlanSummary): PrecheckListItem[] {
  const pending = <T extends { tone: AxCheckTone }>(items: T[]) => items.filter(item => item.tone === "required" || item.tone === "blocked" || item.tone === "held");
  const items: PrecheckListItem[] = [];
  for (const reason of summary.blockReasons) items.push({ title: reason, detail: "진행 보류 사유", target: resolvePrecheckTarget({ topic: reason, origin: "block" }) });
  for (const check of pending(summary.checks)) items.push({ title: check.topic, detail: check.note || "확인 필요", target: resolvePrecheckTarget({ topic: check.topic, note: check.note, tone: check.tone, origin: "check" }) });
  for (const check of pending(summary.additionalChecks)) items.push({ title: check.item, detail: check.content, target: resolvePrecheckTarget({ topic: check.item, note: check.content, tone: check.tone, origin: "extra" }) });
  for (const text of summary.conflictingCriteria ?? []) items.push({ title: text, detail: "성공·실패 기준 충돌 — 확인 필요", target: resolvePrecheckTarget({ topic: text, origin: "conflict" }) });
  for (const text of summary.numericConflictCriteria ?? []) items.push({ title: text, detail: "수치·허용 기준 상충 — 확인 필요", target: resolvePrecheckTarget({ topic: text, origin: "conflict" }) });
  return items;
}
function AxPrecheckSection({ summary }: { summary: AxPlanSummary }) {
  const [open, setOpen] = useState(false);
  const items = precheckListItems(summary);
  const count = items.length;
  const blocked = summary.blockReasons.length > 0;
  return <AxReviewAccordion className="ax-precheck" headClassName="ax-precheck-head" label="구현 전 확인" icon={ClipboardList} meta={<span>{blocked ? "진행 보류" : "미해결"} {count}건</span>} open={open} onOpenChange={setOpen}>
    {count ? <ul className="ax-precheck-items">{items.map((item, i) => {
      const location = item.target.kind === "none" ? "" : precheckTargetLabel(item.target) + (item.target.kind === "decision" && item.target.id ? ` ${item.target.id}` : "");
      return <li key={i} className="ax-precheck-row"><strong>{item.title}</strong><span>{item.detail}</span>{location ? <small>확인 위치: {location}</small> : null}</li>;
    })}</ul> : <p className="ax-muted ax-precheck-empty">필수 확인사항 없음</p>}
  </AxReviewAccordion>;
}
/**
 * Display-only folding of a step method label: the unconfirmed-method boilerplate
 * (구체적 근거 미확인 · 규칙·형식 확인 필요 · 확인 전 보류 · 독립 단계 진행 가능) repeats
 * verbatim on every unconfirmed step, so cards keep only the first line and show the
 * shared guidance once per card/phase. Multi-line labels with step-specific evidence
 * (근거 충돌·확인된 기준) keep their title and evidence lines. The label source
 * (guide.ts) and the all-in-one instruction are untouched.
 */
export function foldMethodLabel(text: string): { text: string; unconfirmed: boolean } {
  if (!text.includes("\n")) return { text, unconfirmed: false };
  const lines = text.split("\n");
  if (lines[0].includes("처리 방식 미확정")) return { text: lines[0], unconfirmed: true };
  return { text: lines.slice(0, 2).join(" "), unconfirmed: false };
}
/**
 * Display items for the 01 구현 범위 card: method boilerplate is folded per item, and a
 * trailing qualifier that repeats identically on several items is shown once as a
 * shared note instead of after every item. Step-specific conditions stay on their item.
 */
export function foldScopeItems(items: string[]): { items: string[]; notes: string[]; unconfirmed: boolean } {
  let unconfirmed = false;
  const folded = items.map(item => {
    const result = foldMethodLabel(item);
    if (result.unconfirmed) unconfirmed = true;
    return result.text;
  });
  const tailOf = (value: string) => /\(([^()]*)\)\s*$/u.exec(value)?.[1];
  const counts = new Map<string, number>();
  for (const item of folded) {
    const tail = tailOf(item);
    if (tail) counts.set(tail, (counts.get(tail) ?? 0) + 1);
  }
  const shared = [...counts].filter(([, count]) => count >= 2).map(([tail]) => tail);
  const stripped = shared.length
    ? folded.map(item => {
      const tail = tailOf(item);
      return tail && shared.includes(tail) ? item.replace(/\s*\([^()]*\)\s*$/u, "") : item;
    })
    : folded;
  return { items: [...new Set(stripped)], notes: shared, unconfirmed };
}
/**
 * Display-only dedupe for the 담당자 수행 유지 card: items describing the same act,
 * condition and owner in different words (예: "담당자가 최종 수치를 검토한다"와 "최종 수치
 * 검토", "가격 수집 오류 시 수동 보완"과 "가격 데이터 수집 오류 시 수동 보완") are shown once.
 * Token sets must match exactly, or differ only by the filler word "데이터" — different
 * requirements (최종 검토 vs 최종 승인, 일반 처리 vs 오류 시 보완) are never merged.
 * Original data, HITL results and the instruction keep every item.
 */
export function dedupeHumanItems(items: string[]): string[] {
  const tokensOf = (item: string): Set<string> => {
    const clean = item.replace(/\(담당자 수행\)\s*$/u, "");
    return new Set(clean.split(/[\s·/]+/u).map(raw => {
      let token = raw.replace(/^담당자[가는]?/u, "");
      token = token.replace(/(합니다|한다)$/u, "");
      if (token.length >= 3) token = token.replace(/(을|를|이|가|은|는|와|과)$/u, "");
      return token;
    }).filter(token => token && token !== "담당자"));
  };
  const kept: { item: string; tokens: Set<string> }[] = [];
  for (const item of items) {
    const tokens = tokensOf(item);
    const duplicate = kept.some(({ tokens: existing }) => {
      if (existing.size === tokens.size) return [...tokens].every(token => existing.has(token));
      const [smaller, larger] = existing.size < tokens.size ? [existing, tokens] : [tokens, existing];
      if (smaller.size < 3) return false;
      const diff = [...larger].filter(token => !smaller.has(token));
      return diff.length === 1 && diff[0] === "데이터" && [...smaller].every(token => larger.has(token));
    });
    if (!duplicate) kept.push({ item, tokens });
  }
  return kept.map(({ item }) => item);
}
/** Keys of reviews that count as 검토 완료: confirmed AND still valid against the current
 * originals (existing HITL validation in hitl.ts — link, type, source and hash all match). */
export function validConfirmedKeySet(items: ReviewableItem[], reviews: HitlReview[]): Set<string> {
  return new Set(getValidConfirmedReviews({ reviews } as AxTaskV2, items).map(review => review.target.key));
}
/** Row status for a review table: an invalid confirmed record (원본 변경·연결 불일치) is
 * 재확인 필요, never 검토 완료. Labels match the HITL status wording in HitlReview. */
export function reviewDisplayState(item: ReviewableItem, review: HitlReview | undefined, validKeys: Set<string>): { status: "confirmed" | "stale" | "editing" | "pending"; label: string } {
  if (review && validKeys.has(item.key)) return { status: "confirmed", label: "검토 완료" };
  if (!review) return { status: "pending", label: "검토 전" };
  if (review.status === "stale" || review.status === "confirmed") return { status: "stale", label: "재확인 필요" };
  if (review.status === "editing") return { status: "editing", label: "보완 중" };
  return { status: "pending", label: "검토 전" };
}
/** ② 구현 범위·완료 기준: 한 줄 요약 행으로만 표시한다 (#373의 2열 요약 카드를
 * 교체하는 추가 간소화). 범위 행은 실제 범위 판정 결과의 건수만 표시하고, 완료
 * 기준 행은 현재 구현 범위와 직접 연결된 핵심 기준을 최대 3개까지 표시하고
 * 나머지는 건수로 요약한다. 핵심 기준 우선순위는 성공 기준 → 실패 기준 →
 * 테스트 기준 → 승인 기준이다 (단순 배열 앞부분이 아니다). 기준별 확정·미확정
 * 구분이 요약 데이터에 없으므로 확정 건수를 임의로 계산하지 않고, 공통 미확인
 * 안내가 있으면 그대로 표시한다. 원본 범위·전체 기준은 검토 기능과 올인원
 * 지시문에 그대로 유지된다. */
export function scopeSummaryRows(summary: AxPlanSummary): {
  implementCount: number; humanCount: number; excludedCount: number; unconfirmedScope: boolean;
  coreCriteria: string[]; additionalCriteriaCount: number; criteriaNotices: string[];
} {
  const orderedCriteriaRows = [
    { items: summary.success, notice: summary.criteriaNotice },
    { items: summary.failure, notice: summary.criteriaNotice },
    { items: summary.tests, notice: summary.testsNotice },
    { items: summary.approvals, notice: undefined },
  ].filter(row => row.items.length);
  const orderedCriteria = orderedCriteriaRows.flatMap(row => row.items);
  return {
    implementCount: foldScopeItems(summary.include).items.length,
    humanCount: dedupeHumanItems(summary.humanKept).length,
    excludedCount: summary.excluded.length,
    unconfirmedScope: foldScopeItems(summary.include).unconfirmed,
    coreCriteria: orderedCriteria.slice(0, 3),
    additionalCriteriaCount: Math.max(0, orderedCriteria.length - 3),
    criteriaNotices: [...new Set(orderedCriteriaRows.map(row => row.notice).filter((notice): notice is string => !!notice))],
  };
}
function AxScopeSummary({ summary }: { summary: AxPlanSummary }) {
  const rows = scopeSummaryRows(summary);
  const hasScope = rows.implementCount > 0 || rows.humanCount > 0 || rows.excludedCount > 0 || rows.unconfirmedScope;
  const hasCriteria = rows.coreCriteria.length > 0 || rows.additionalCriteriaCount > 0;
  if (!hasScope && !hasCriteria) return null;
  return <section className="ax-scope-summary" aria-label="구현 범위·완료 기준">
    {hasScope ? <div className="ax-scope-row" data-scope-group="scope">
      <h4>구현 범위</h4>
      <p>구현 대상 {rows.implementCount}개 · 담당자 수행 {rows.humanCount}개 · 보류·제외 {rows.excludedCount}개</p>
      {rows.unconfirmedScope ? <p className="ax-muted">미확정 처리 방식과 필수 기준은 해당 단계에서 확인이 필요합니다.</p> : null}
    </div> : null}
    {hasCriteria ? <div className="ax-scope-row" data-scope-group="criteria">
      <h4>완료 기준</h4>
      <p>{[...rows.coreCriteria, ...(rows.additionalCriteriaCount ? [`추가 기준 ${rows.additionalCriteriaCount}개`] : [])].join(" · ")}</p>
      {rows.criteriaNotices.map((notice, i) => <p key={i} className="ax-muted">{notice}</p>)}
    </div> : null}
  </section>;
}
function AxPrompt({ prompt, name, copySuffix = "올인원 지시문" }: { prompt: string; name: string; copySuffix?: string }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  return <>
    <pre id={contentId} className="ax-prompt" hidden={!expanded} data-expanded={expanded ? "true" : "false"}>{prompt}</pre>
    <div className="ax-prompt-actions">
      <Button type="button" variant="outline" className="ax-prompt-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>{expanded ? "전체 접기" : "전체 보기"}</Button>
      <AxCopyButton text={prompt} label={`${name}용 ${copySuffix} 복사`} />
    </div>
  </>;
}
export function AxExecutionPackage({ plan, target, taskName, taskContext, prerequisites, diagnosis, hitlReviews, genericRules }: {
  plan: AxPlan;
  target: AxToolId;
  taskName: string;
  taskContext: string;
  prerequisites: string[];
  diagnosis: AxDiagnosis;
  hitlReviews?: import("@/lib/ax/types").HitlReview[];
  genericRules?: import("@/lib/ax/types").GenericRule[];
}) {
  const [showFindings, setShowFindings] = useState(false);
  const name = TOOL_GUIDES[target].name;
  // P1: 본문은 래퍼가 반환한 지시문 그대로 렌더링하고, 전달 검사는 본문 아래
  // 한 줄 요약 + 기본 접힘 상태의 finding 목록으로만 표시한다 (본문 텍스트 변경 없음).
  const { prompt, delivery } = checkAllInOnePromptDelivery(plan, target, {
    taskName,
    prerequisites,
    diagnosis,
    context: taskContext,
    hitlReviews,
    hitlTool: target === "codex" ? "codex" : "claude",
    genericRules,
  });
  return <div className="ax-package">
    <AxPrompt key={prompt} prompt={prompt} name={name} />
    <div className="ax-delivery-check">
      <p className="ax-muted">전달 검사: 확정 {delivery.confirmedTotal}건 중 전달 {delivery.deliveredCount}건 · 문제 {delivery.findings.length}건</p>
      {delivery.findings.length ? <>
        <div className="ax-actions"><Button type="button" variant="outline" size="sm" aria-expanded={showFindings} onClick={() => setShowFindings(value => !value)}>{showFindings ? "전달 문제 접기" : `전달 문제 ${delivery.findings.length}건 보기`}</Button></div>
        {showFindings ? <ul role="list">{delivery.findings.map((finding, i) => <li key={i}>{finding.message}</li>)}</ul> : null}
      </> : null}
    </div>
  </div>;
}

/** 구현 계획 검토와 올인원 지시문·설치 가이드가 공유하는 코딩 도구 선택.
 * 명시적 선택이 우선하고, 선택이 없으면 계획이 존재하는 도구(Codex 우선)를 사용한다.
 * 도구 변경은 생성된 계획과 검토 데이터를 삭제하지 않으며, 각 도구의 검토 확정 상태는
 * 도구별 검토 키(planCodex:/planClaude:)로 분리 유지된다. */
export function resolveActiveTool(selectedTool: AxToolId | null, plans: { codex?: AxPlan; claude?: AxPlan }): AxToolId {
  return selectedTool ?? (plans.codex ? "codex" : "claude");
}
/** 검증 결과 입력 폼의 한 줄 입력란. 기존 등록·검토 폼과 같은 Textarea 패턴이다. */
function AxFixField({ label, hint, value, onChange, rows, maxLength }: {
  label: string; hint?: string; value: string; onChange: (value: string) => void; rows: number; maxLength: number;
}) {
  return <label className="ax-field">{label}<Textarea rows={rows} maxLength={maxLength} value={value} onChange={e => onChange(e.target.value)} />{hint ? <small className="ax-muted">{hint}</small> : null}</label>;
}

type AxFixDraftFailure = { feature: string; expected: string; actual: string; error: string; reproduction: string };
const emptyAxFixDraftFailure = (): AxFixDraftFailure => ({ feature: "", expected: "", actual: "", error: "", reproduction: "" });

/** 검증 결과 입력 + 수정·보완 지시문 보기·복사 섹션.
 * 결과·로드맵 화면에서는 렌더링되지 않는다: 올인원 지시문 하단의 검증 결과 기록 진입
 * 버튼(AxVerificationEntry)과 그 배선은 제거됐다. 저장된 verificationResults 데이터·스키마와
 * 지시문 생성(buildFixPrompt)은 그대로 보존되며, 다시 렌더링할 때는 저장 핸들러를
 * onSaveVerificationResults로 다시 연결해야 한다. 보기·복사는 올인원 지시문과
 * 같은 AxPrompt + AxCopyButton 패턴을 재사용하고, 지시문 본문은 렌더 시
 * buildFixPrompt()로 생성한다 (저장하지 않음).
 * Gate blocked면 올인원 지시문과 동일하게 생성하지 않고 차단 안내만 표시한다. */
export function AxFixPromptSection({ diagnosis, plan, taskName, taskContext, prerequisites, hitlReviews, hitlTool, genericRules, gate, verificationResults, onSaveVerificationResults }: {
  diagnosis: AxDiagnosis;
  plan: AxPlan | undefined;
  taskName: string;
  taskContext: string;
  prerequisites: string[];
  hitlReviews?: HitlReview[];
  hitlTool: AxToolId;
  genericRules?: import("@/lib/ax/types").GenericRule[];
  gate: "ready" | "conditional" | "blocked";
  verificationResults?: VerificationResult[];
  onSaveVerificationResults?: (round: VerificationResult) => void;
}) {
  const [failures, setFailures] = useState<AxFixDraftFailure[]>([emptyAxFixDraftFailure()]);
  const [keptText, setKeptText] = useState("");
  const [implementationNote, setImplementationNote] = useState("");
  const [environment, setEnvironment] = useState("");
  const [rulesNote, setRulesNote] = useState("");
  const [unconfirmedText, setUnconfirmedText] = useState("");
  const [testRunFailure, setTestRunFailure] = useState("");
  const [formError, setFormError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const splitLines = (value: string) => value.split("\n").map(line => line.trim()).filter(Boolean);
  const patchFailure = (index: number, patch: Partial<AxFixDraftFailure>) =>
    setFailures(current => current.map((failure, i) => i === index ? { ...failure, ...patch } : failure));
  const validFailures = failures.map(failure => ({
    feature: failure.feature.trim(),
    expected: failure.expected.trim() || undefined,
    actual: failure.actual.trim() || undefined,
    error: failure.error.trim() || undefined,
    reproduction: failure.reproduction.trim() || undefined,
  })).filter(failure => failure.feature);
  const previousFailureNames = [...new Set((verificationResults ?? []).flatMap(round => round.failures.map(failure => failure.feature)))];
  const preview = gate === "blocked" || !validFailures.length ? "" : buildFixPrompt(plan, {
    taskName, prerequisites, diagnosis, context: taskContext, hitlReviews, hitlTool, genericRules,
  }, {
    failures: validFailures,
    keptFeatures: splitLines(keptText),
    implementationNote: implementationNote.trim() || undefined,
    rulesNote: rulesNote.trim() || undefined,
    unconfirmedRules: splitLines(unconfirmedText),
    testRunFailure: testRunFailure.trim() || undefined,
    previousFailureNames,
  });
  function saveRound() {
    if (!validFailures.length) { setFormError("실패한 기능을 1건 이상 입력하세요."); return; }
    if (!onSaveVerificationResults) { setFormError("검증 결과를 저장할 수 없습니다. 다시 시도하세요."); return; }
    const text = (value: string | undefined) => value?.trim() ? value.trim() : undefined;
    onSaveVerificationResults({
      reportedAt: new Date().toISOString(),
      failures: validFailures.map(failure => ({
        feature: failure.feature,
        ...(failure.expected ? { expected: failure.expected } : {}),
        ...(failure.actual ? { actual: failure.actual } : {}),
        ...(failure.error ? { error: failure.error } : {}),
        ...(failure.reproduction ? { reproduction: failure.reproduction } : {}),
      })),
      ...(splitLines(keptText).length ? { keptFeatures: splitLines(keptText) } : {}),
      ...(text(implementationNote) ? { implementationNote: text(implementationNote) } : {}),
      ...(text(environment) ? { environment: text(environment) } : {}),
      ...(text(rulesNote) ? { rulesNote: text(rulesNote) } : {}),
      ...(splitLines(unconfirmedText).length ? { unconfirmedRules: splitLines(unconfirmedText) } : {}),
      ...(text(testRunFailure) ? { testRunFailure: text(testRunFailure) } : {}),
    });
    setFormError("");
    setSavedMessage("검증 결과를 저장했습니다. 보고 일시가 라운드 구분자로 기록됩니다.");
  }
  return <section className="ax-plan-block" aria-label="검증 결과와 수정·보완 지시문">
    <div className="ax-plan-title"><h4>검증 결과 · 수정·보완 지시문</h4><p className="ax-plan-desc">STEP 08 검증 결과를 입력하면 실패 항목만 다루는 수정 지시문을 만듭니다. 정상 기능은 수정하지 않습니다.</p></div>
    {gate === "blocked" ? <p role="status" className="ax-notice">현재 진단에서는 수정·보완 지시문 생성 불가</p> : <>
      {failures.map((failure, i) => <div className="ax-fix-failure" key={i}>
        <div className="ax-fix-failure-head"><strong>실패 {i + 1}</strong>{failures.length > 1 ? <Button type="button" variant="outline" size="sm" onClick={() => setFailures(current => current.filter((_, j) => j !== i))}>삭제</Button> : null}</div>
        <AxFixField label="실패 기능" value={failure.feature} onChange={value => patchFailure(i, { feature: value })} rows={1} maxLength={500} />
        <AxFixField label="기대 결과" value={failure.expected} onChange={value => patchFailure(i, { expected: value })} rows={2} maxLength={2000} />
        <AxFixField label="실제 결과" value={failure.actual} onChange={value => patchFailure(i, { actual: value })} rows={2} maxLength={2000} />
        <AxFixField label="오류 내용" hint="개인정보·키·토큰은 [REDACTED]로 가리고 필요한 부분만 입력하세요. 로그 전체를 복사하지 마세요." value={failure.error} onChange={value => patchFailure(i, { error: value })} rows={2} maxLength={2000} />
        <AxFixField label="재현 절차" value={failure.reproduction} onChange={value => patchFailure(i, { reproduction: value })} rows={2} maxLength={2000} />
      </div>)}
      <div className="ax-actions"><Button type="button" variant="outline" onClick={() => setFailures(current => [...current, emptyAxFixDraftFailure()])}>실패 항목 추가</Button></div>
      <AxFixField label="유지할 정상 기능 (한 줄에 1건)" value={keptText} onChange={setKeptText} rows={2} maxLength={5000} />
      <AxFixField label="현재 구현 프로그램 목적·코드·버전" value={implementationNote} onChange={setImplementationNote} rows={2} maxLength={2000} />
      <AxFixField label="검증 환경 (선택, 예: 로컬·스테이징·운영 주소)" value={environment} onChange={setEnvironment} rows={1} maxLength={500} />
      <AxFixField label="적용된 업무 규칙" value={rulesNote} onChange={setRulesNote} rows={2} maxLength={2000} />
      <AxFixField label="미확정 업무 규칙 (한 줄에 1건, 사용자 확인 필요 항목)" value={unconfirmedText} onChange={setUnconfirmedText} rows={2} maxLength={5000} />
      <AxFixField label="테스트 실행 실패 사유 (실행 자체가 안 된 경우)" value={testRunFailure} onChange={setTestRunFailure} rows={2} maxLength={2000} />
      {formError ? <p role="status" className="ax-copy-error">{formError}</p> : null}
      {savedMessage ? <p role="status" className="ax-muted">{savedMessage}</p> : null}
      <div className="ax-actions"><Button type="button" onClick={saveRound}>검증 결과 저장</Button></div>
      {verificationResults?.length ? <div className="ax-fix-rounds">
        <h5>저장된 검증 라운드</h5>
        <ul role="list">{verificationResults.map((round, i) => <li key={`${round.reportedAt}-${i}`}>{new Date(round.reportedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} · 실패 {round.failures.length}건 — {round.failures.map(failure => failure.feature).join(" / ")}</li>)}</ul>
        <p className="ax-muted">이전 라운드 실패 항목이 이번 입력과 겹치면 지시문에서 반복 실패 확인 대상으로 표시됩니다.</p>
      </div> : null}
      {preview ? <div className="ax-fix-preview"><AxPrompt key={preview} prompt={preview} name="수정·보완" copySuffix="지시문" /></div> : <p className="ax-muted">실패 기능을 1건 이상 입력하면 수정·보완 지시문 미리보기가 표시됩니다.</p>}
    </>}
  </section>;
}

export function AxPlanSection({ diagnosis, taskName, taskContext, busy, onGenerate, reviewProps, genericRules, activeTool: controlledTool, onToolChange }: {

  diagnosis: AxDiagnosis;
  taskName: string;
  taskContext: string;
  busy: string | null;
  onGenerate: (target: AxToolId) => void;
  reviewProps?: AxProcessReviewProps;
  genericRules?: import("@/lib/ax/types").GenericRule[];
  /** 제어 모드: 부모가 도구 선택을 소유하면 ①·②·올인원 지시문이 같은 도구의 검토를 따른다.
   * 미제공 시 기존 내부 상태 동작을 유지한다. */
  activeTool?: AxToolId;
  onToolChange?: (tool: AxToolId) => void;
}) {
  const profile = executionProfile(diagnosis);
  const gate = profile.gate;
  const prerequisites = gate === "blocked" ? [] : profile.prerequisites;
  const plans = { codex: diagnosis.planCodex, claude: diagnosis.planClaude };
  const [internalSelected, setInternalSelected] = useState<AxToolId | null>(null);
  const setSelectedTool = onToolChange ?? setInternalSelected;
  const activeTool = controlledTool ?? resolveActiveTool(internalSelected, plans);
  const activePlan = plans[activeTool];
  // 01~03 요약도 올인원 지시문과 같은 확정 검토를 반영한다. Gate blocked에서도 동일하게
  // 전달해 진단 검토가 요약에 일관되게 적용되고, 계획 검토는 계획이 없을 때
  // 매칭되지 않으므로 혼합되지 않는다.
  const summary = planSummary(diagnosis, gate !== "blocked" ? activePlan : undefined, [taskName, taskContext].join("\n"),
    { hitlReviews: reviewProps?.reviews, hitlTool: activeTool });
  const instructionsId = useId();
  const instructionsRef = useRef<HTMLElement>(null);
  function goToInstructions() {
    const heading = instructionsRef.current?.querySelector<HTMLElement>("h4");
    heading?.scrollIntoView({ behavior: "instant", block: "start" });
    heading?.focus({ preventScroll: true });
  }
  const generateButton = (target: AxToolId) => <Button key={target} type="button" variant="outline" className="ax-plan-generate" disabled={!!busy || gate === "blocked"} onClick={() => onGenerate(target)}><FileCode2 aria-hidden="true" />{busy === target ? target === "codex" ? "Codex 계획 생성 중…" : "Claude 계획 생성 중…" : `${TOOL_GUIDES[target].name}용 구현 계획 생성`}</Button>;
  return <section className="ax-surface" id="ax-plan-section" aria-label="자동화 구현 계획">
    <div className="ax-plan-head"><h3>자동화 구현 계획</h3></div>
    <AxPrecheckSection summary={summary} />
    <AxScopeSummary summary={summary} />
    {gate === "blocked" ? <>
      <div className="ax-actions">{generateButton("codex")}{generateButton("claude")}</div>
    </> : <>
      {!plans.codex && !plans.claude ? <div className="ax-actions">{generateButton("codex")}{generateButton("claude")}</div> : null}
    </>}
    {reviewProps && (plans.codex || plans.claude) ? <AxPlanReview plans={plans} reviewProps={reviewProps} activeTool={activeTool} onToolChange={setSelectedTool} /> : null}
    <section ref={instructionsRef} id={`${instructionsId}-section`} className="ax-plan-instructions" aria-labelledby={instructionsId}>
      {gate === "blocked" ? <><AxPlanHeading id={instructionsId} title="올인원 지시문" description="선택한 코딩 에이전트를 위한 통합 지시문을 생성합니다." /><p role="status" className="ax-notice">현재 진단에서는 구현 계획 생성 불가</p></> : <>
        {plans.codex || plans.claude ?
          <Tabs className="ax-tool-tabs" value={activeTool} onValueChange={value => { if (value === "codex" || value === "claude") setSelectedTool(value); }}>
            <div className="ax-plan-instructions-head">
              <AxPlanHeading id={instructionsId} title="올인원 지시문" description="선택한 코딩 에이전트를 위한 통합 지시문을 생성합니다." />
              <div className="ax-plan-toolbar">
                <TabsList aria-label="AI 코딩 도구 선택"><TabsTab value="codex">Codex</TabsTab><TabsTab value="claude">Claude Code</TabsTab></TabsList>
              </div>
            </div>
            {(["codex", "claude"] as const).map(target => <TabsPanel key={target} value={target}>{target === activeTool ? plans[target] ? <><p className="ax-plan-tool-hint">{TOOL_GUIDES[target].name}에서 현재 프로젝트를 열고 올인원 지시문 붙여넣기</p><AxExecutionPackage plan={plans[target]} target={target} taskName={taskName} taskContext={taskContext} prerequisites={prerequisites} diagnosis={diagnosis} hitlReviews={reviewProps?.reviews} genericRules={genericRules} /></> : <><p className="ax-plan-generate-hint">{TOOL_GUIDES[target].name}용 구현 계획 생성 후 올인원 지시문 확인</p>{generateButton(target)}</> : null}</TabsPanel>)}
          </Tabs> : <><AxPlanHeading id={instructionsId} title="올인원 지시문" description="선택한 코딩 에이전트를 위한 통합 지시문을 생성합니다." /><p className="ax-muted">도구별 구현 계획 생성 후 올인원 지시문 확인</p></>}
      </>}
    </section>
    {gate !== "blocked" && (plans.codex || plans.claude) ? <section className="ax-plan-guide" aria-label="설치·시작 가이드">
      <Accordion className="ax-guide">
        <AccordionItem value="setup" className="ax-guide-item">
          <AccordionTrigger className="ax-guide-trigger" aria-label="설치·시작 가이드">
            <span className="inline-flex items-center gap-2"><Terminal aria-hidden="true" className="size-4" />설치·시작 가이드</span>
          </AccordionTrigger>
          <AccordionPanel className="ax-guide-panel">
            <AxSetupGuide tool={activeTool} instructionsId={`${instructionsId}-section`} onGoToInstructions={goToInstructions} />
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </section> : null}
  </section>;
}

/** 구현 계획 검토 섹션 (Codex/Claude Code별) - 테이블형 UI
 * 도구 선택은 AxPlanSection의 공통 상태와 공유한다: 올인원 지시문·설치 가이드와 양방향 연동된다.
 * 각 도구의 검토 항목은 도구별 검토 키(planCodex:/planClaude:)로 분리되므로 도구 전환 후에도
 * 기존 확정 결과가 유지되고, 확정하지 않은 검토 결과가 다른 도구에 임의 반영되지 않는다. */
/** Display-only: 검토 표 행을 미완료 우선으로 나눈다. 완료 판정(validKeys)은
 * 기존 HITL 유효성 검증을 그대로 쓴다. */
export function partitionReviewItems<T>(items: T[], validKeys: ReadonlySet<string>, keyOf: (item: T) => string): { pending: T[]; completed: T[] } {
  return {
    pending: items.filter(item => !validKeys.has(keyOf(item))),
    completed: items.filter(item => validKeys.has(keyOf(item))),
  };
}
function AxPlanReview({ plans, reviewProps, activeTool, onToolChange }: {
  plans: { codex?: AxPlan; claude?: AxPlan };
  reviewProps: AxProcessReviewProps;
  activeTool: AxToolId;
  onToolChange: (tool: AxToolId) => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  // 공통 검토 아코디언(AxReviewAccordion): 단계별 자동화 판단·위험·확인사항 검토와 같은 형태다.
  // 기본 동작은 검토 필요 0건 접힘·1건 이상 펼침이며, 사용자의 수동 선택이 우선하고
  // 저장·상태 갱신으로 임의로 닫히지 않는다. 현재 도구의 항목 패널이 열려 입력 중이면
  // 펼침을 강제하고 접기를 막는다 (다른 두 검토 영역과 같은 입력 보호).

  const items = (() => {
    const result: { tool: "codex" | "claude"; item: ReviewableItem }[] = [];
    if (plans.codex && (activeTool === "codex" || !plans.claude)) {
      for (const item of extractPlanReviewableItems(plans.codex, "codex")) {
        result.push({ tool: "codex", item });
      }
    }
    if (plans.claude && (activeTool === "claude" || !plans.codex)) {
      for (const item of extractPlanReviewableItems(plans.claude, "claude")) {
        result.push({ tool: "claude", item });
      }
    }
    return result;
  })();

  if (!items.length) return null;

  // 검토 완료 = confirmed이면서 현재 원본과 유효하게 연결된 기록만 (hitl.ts 유효성 검증 재사용).
  // pending·editing·stale·해시 불일치 기록은 검토 필요로 집계한다.
  const validKeys = validConfirmedKeySet(items.map(({ item }) => item), reviewProps.reviews);
  const completedCount = items.filter(({ item }) => validKeys.has(item.key)).length;
  const { pending: pendingItems, completed: completedItems } = partitionReviewItems(items, validKeys, ({ item }) => item.key);
  const panelOpen = openKey !== null && items.some(({ item }) => item.key === openKey);
  const open = panelOpen || (manualOpen ?? pendingItems.length > 0);
  const renderRow = ({ item }: { item: ReviewableItem }) => {
    const review = findReview({ reviews: reviewProps.reviews } as AxTaskV2, item.key);
    const isOpen = openKey === item.key;
    const typeLabel = item.type === "planItem" ? "구현 항목" : "완료 기준";
    const badgeClass = item.type === "planItem" ? "ax-hitl-type-badge-plan" : "ax-hitl-type-badge-criterion";
    const displayState = reviewDisplayState(item, review, validKeys);
    return <Fragment key={item.key}>
      <tr key={item.key}>
        <td className="col-type">
          <span className={`ax-hitl-type-badge ${badgeClass}`}>{typeLabel}</span>
        </td>
        <td className="col-content">{item.text}</td>
        <td className="col-status">
          <span className="ax-hitl-status-dot" data-status={displayState.status}>{displayState.label}</span>
        </td>
        <td className="col-action">
          <Button type="button" variant="outline" size="sm" onClick={() => setOpenKey(isOpen ? null : item.key)}>
            {isOpen ? "닫기" : review ? "보기" : "검토"}
          </Button>
        </td>
      </tr>
      {isOpen ? <tr key={`${item.key}-panel`}>
        <td colSpan={4} style={{ padding: 0, borderBottom: "1px solid var(--line-soft)" }}>
          <div style={{ padding: "16px 20px" }}>
            <HitlReviewPanel
              key={item.key}
              item={item}
              review={editingKey === item.key ? { ...review!, status: "editing" as const } : review}
              onSave={(r) => { const result = reviewProps.onSaveReview(r); if (result.saved) setEditingKey(null); }}
              onCancel={() => { setEditingKey(null); setOpenKey(null); }}
              onEdit={() => setEditingKey(item.key)}
            />
          </div>
        </td>
      </tr> : null}
    </Fragment>;
  };

  return <AxReviewAccordion id="ax-plan-review" label="구현 계획 검토" icon={ClipboardCheck} meta={<ReviewCounts total={items.length} completed={completedCount} />} open={open} onOpenChange={setManualOpen} locked={panelOpen}>
    {plans.codex && plans.claude ? <div className="ax-hitl-plan-tabs" role="tablist" style={{ padding: "12px 20px 0" }}>
      <Button type="button" variant={activeTool === "codex" ? "default" : "outline"} size="sm" onClick={() => onToolChange("codex")}>Codex</Button>
      <Button type="button" variant={activeTool === "claude" ? "default" : "outline"} size="sm" onClick={() => onToolChange("claude")}>Claude Code</Button>
    </div> : null}
    <div style={{ overflowX: "auto" }}>
      <table className="ax-hitl-table">
        <thead>
          <tr>
            <th className="col-type">구분</th>
            <th className="col-content">검토 내용</th>
            <th className="col-status">상태</th>
            <th className="col-action">작업</th>
          </tr>
        </thead>
        <tbody>
          {pendingItems.map(renderRow)}
          {completedItems.map(renderRow)}
        </tbody>
      </table>
    </div>
  </AxReviewAccordion>;
}
