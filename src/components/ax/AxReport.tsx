"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, Ban, BookOpen, Bot, BrainCircuit, ChartNoAxesColumnIncreasing, Check, CheckCircle2, CircleAlert, CircleCheck, CircleX, Clipboard, ClipboardCheck, ClipboardList, Clock, CloudUpload, Copy, Database, Download, FileCode2, FileOutput, FileSpreadsheet, FileText, Flag, FlaskConical, Folder, GitBranch, Globe, Info, ListChecks, MonitorCog, Play, Plug, Search, Settings2, ShieldAlert, ShieldCheck, Target, Terminal, TriangleAlert, UserRound } from "lucide-react";
import type { AxDiagnosis, AxPlan, AxTask, AxTaskV2, HitlReview } from "@/lib/ax/types";
import { automationLevel, axes, executionGate, executionProfile, factorEffectiveValue, GATE_LABELS, gateBlockReasons, LEVEL_DESCRIPTIONS, levelDisplayLabel, nextAction, prerequisiteTopicKey, type ExecutionProfile } from "@/lib/ax/policy";
import { FACTOR_LABELS } from "@/lib/ax/schema";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { HitlReviewPanel, HitlStatusBadge } from "./HitlReview";
import { extractReviewableItems, extractPlanReviewableItems, findReview, getValidConfirmedReviews, type ReviewableItem } from "@/lib/ax/hitl";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import { buildAgentInstructionModel, buildAllInOnePrompt, filterRoadmapItems, guideCodeDisplayText, planSummary, scopeItemLabel, setupGuide, stepDetailEntries, stepMethodLabel, TOOL_GUIDES, type AgentInstructionModel, type AxCheckTone, type AxGuideBlock, type AxGuideSection, type AxPlanSummary, type AxToolId } from "@/lib/ax/guide";

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
/** Shared 4-card factor score display used by the diagnosis and matrix views. Colors follow the reference: blue for value/feasibility, orange for judgment, red for risk. */
export function AxScoreCards({ diagnosis, variant }: { diagnosis: AxDiagnosis; variant?: "matrix" }) {
  const a = axes(diagnosis);
  const cards = [
    { label: "자동화 가치", value: a.value, color: "var(--primary)", Icon: ChartNoAxesColumnIncreasing },
    { label: "기술 실현 가능성", value: a.feasibility, color: "var(--primary)", Icon: Settings2 },
    { label: "담당자 판단 필요도", value: a.judgment, color: "#ea580c", Icon: UserRound },
    { label: "운영 위험", value: a.risk, color: "#dc2626", Icon: ShieldCheck },
  ];
  return <div className={`ax-score-cards${variant === "matrix" ? " ax-score-cards-matrix" : ""}`} role="list" aria-label="진단 점수">
    {cards.map(({ label, value, color, Icon }) => <div className="ax-score-card" role="listitem" key={label}>
      {variant === "matrix" ? <span className="ax-score-card-icon" aria-hidden="true"><Icon size={20} /></span> : null}
      <span className="ax-score-card-label">{label}</span>
      <span className="ax-score-card-value"><strong>{value}</strong><span aria-hidden="true"> / 5</span><span className="sr-only">{label} 5점 만점에 {value}점</span></span>
      <span className="ax-score-card-bar" aria-hidden="true"><span style={{ width: `${value / 5 * 100}%`, background: color }} /></span>
    </div>)}
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

const SCOPE_LABELS = { implement: "이번 구현", "after-check": "확인 후 구현", verify: "검토·검증만", future: "향후 확장", human: "담당자 유지" } as const;
/** Display copy for the fixed phase titles `executionProfile` emits; `poc` marks the phase judged by the diagnosis' PoC success criteria. */
const PHASE_COPY: Record<string, { description: string; poc?: true }> = {
  "선행 확인": { description: "진행 범위를 정하기 위한 필수 정보 확인" },
  "제한 PoC": { description: "선행 확인 후 샘플 범위에서 처리 방식 검증", poc: true },
  "결과 확인·다음 단계 판단": { description: "검증 결과를 반영해 재진단 또는 다음 단계 결정" },
  "차단 사유 확인": { description: "진행 보류 사유와 근거 확인" },
  "조건 해결": { description: "차단 사유별 해결 방안 확인" },
  "검증": { description: "해결된 조건을 샘플 데이터로 확인" },
  "재진단": { description: "확인 결과를 반영해 다시 진단" },
  "데이터 형식 확인": { description: "입력 자료의 구조와 필수 항목 확인" },
  "업무 규칙 정리": { description: "판단 기준과 예외 기준 정리" },
  "사전 검증": { description: "처리 가능성 검토·검증 (운영 구현 없음)", poc: true },
  "입력·규칙 확인": { description: "입력 자료와 업무 규칙 확인" },
  "AI 보조 기능 검증": { description: "AI 후보·초안 생성 기능 검증", poc: true },
  "담당자 검토": { description: "담당자 검토·승인 흐름 유지" },
  "제한 적용·결과 평가": { description: "담당자 검토를 유지한 채 일부 건에 적용" },
  "입력·규칙 검증": { description: "입력 자료와 처리 규칙 검증" },
  "부분 자동화 구현": { description: "규칙 기반 처리와 AI 보조 구현" },
  "예외·실패 검증": { description: "예외 분리와 실패 처리 검증" },
  "파일럿": { description: "제한 범위에서 결과 확인", poc: true },
  "운영 적용": { description: "운영 담당과 운영 기준 적용" },
  "자동화 흐름 구현": { description: "자동 처리와 AI 보조 흐름 구현" },
  "실패 복구·Fallback": { description: "실패 시 복구와 수동 전환 확인" },
  "단계적 도입": { description: "일부 범위 적용 후 확대" },
  "운영·모니터링": { description: "운영 담당과 모니터링 기준 적용" },
};
const PHASE_STATUS = {
  check: { label: "확인 필요", Icon: CircleAlert }, conditional: { label: "조건부 진행", Icon: Clock },
  ready: { label: "진행 가능", Icon: CircleCheck }, blocked: { label: "진행 보류", Icon: Ban }, future: { label: "향후 단계", Icon: CircleCheck },
} as const;
/** Phase cards of the policy roadmap. Status follows the gate only: a ready roadmap is wholly within the permitted scope; otherwise the first phase is current, a conditional gate's second phase waits on it and the rest are future. */
function AxRoadmapPhases({ model, profile }: { model: AgentInstructionModel; profile: ExecutionProfile }) {
  const success = [...new Set(model.scoped.criteria.filter(item => item.source === "diagnosis.poc.success").map(item => item.text))];
  const outputs = [...new Set(model.scoped.outputs.map(item => item.text))];
  const last = profile.roadmap.length - 1;
  return <div className="ax-execution-phases">
    <header className="ax-phases-head">
      <div><h4>{profile.roadmapTitle} · 단계별 진행 계획</h4><p>현재 진단 결과를 기반으로 한 단계별 실행 계획과 전환 조건입니다.</p></div>
      <span className="ax-phases-badge"><Info aria-hidden="true" />진단 기반 계획</span>
    </header>
    <ol className="ax-phase-cards" data-count={profile.roadmap.length}>{profile.roadmap.map((phase, i) => {
      const copy = PHASE_COPY[phase.title];
      const status = PHASE_STATUS[profile.gate === "ready" ? "ready" : i === 0 ? profile.gate === "blocked" ? "blocked" : "check"
        : i === 1 && profile.gate === "conditional" ? "conditional" : "future"];
      const Icon = i === 0 ? FileText : i === last ? ChartNoAxesColumnIncreasing : FlaskConical;
      // Concise card wording: policy step lines drop the parenthetical restriction (kept in the timeline above and the instruction).
      // The unconfirmed-method boilerplate repeats verbatim per step, so it is folded to its
      // first line here and shown once per phase as a shared note below the item list.
      let phaseUnconfirmed = false;
      const items = [...new Set(phase.items.map(item => {
        const label = scopeItemLabel(model, item);
        const short = label === item ? item : label.replace(/\s*\([^()]*\)\s*$/u, "");
        const folded = foldMethodLabel(short);
        if (folded.unconfirmed) phaseUnconfirmed = true;
        const base = copy?.poc ? folded.text.replace(/^샘플 범위: /u, "") : folded.text;
        const linked = model.classified.find(entry => (entry.role === "tests" || entry.role === "conditions") && entry.originals.some(text => text === item));
        const qualifier = linked?.scope === "future" ? linked.role === "tests" ? "향후 검증" : "향후 단계 조건"
          : linked?.scope === "confirm" ? "적용 단계 확인 필요" : "";
        return `${base}${qualifier ? ` (${qualifier})` : ""}`;
      }))];
      // 확정 HITL 결정 반영: 제외 항목은 현재 작업에서 빠지고, 보류 항목은
      // 현재 작업에서 빠진 뒤 보류 상태·사유·재개 조건과 함께 별도 안내한다.
      const roadmapFiltered = filterRoadmapItems(model, items);
      const heldItems = roadmapFiltered.held;
      const footer = i === last ? { title: "최종 산출물", Icon: FileText, text: outputs.length ? outputs.join(" · ") : "산출물 기준 확인 필요" }
        : { title: "다음 단계 조건", Icon: Flag, text: i === 0 && profile.gate === "conditional" ? "다음 작업이 의존하는 필수 조건과 미연결 조건의 적용 범위를 확인해야 합니다. 독립 작업은 근거 확인 후 진행합니다."
          : i === 0 && profile.gate === "blocked" ? "차단 사유가 해결되고 재진단에서 진행 보류가 해제되어야 합니다."
          : copy?.poc && success.length ? success.join(" · ") : "전환 기준 확인 필요" };
      return <li className="ax-execution-phase" data-position={i === 0 ? "first" : i === last ? "last" : "middle"} key={i}>
        <div className="ax-phase-head">
          <span className="ax-phase-icon" aria-hidden="true"><Icon /></span>
          <div className="ax-phase-title">
            <div className="ax-phase-topline"><span className="ax-phase-no">Phase {phase.phase}</span><span className="ax-phase-status" data-status={status.label}><status.Icon aria-hidden="true" />{status.label}</span></div>
            <strong>{phase.title}</strong>{copy ? <p>{copy.description}</p> : null}
          </div>
        </div>
        <div className="ax-phase-body"><h5>주요 작업</h5><ul role="list">{roadmapFiltered.current.map((item, j) => <li key={j}>{item}</li>)}</ul>{heldItems.length ? <p className="ax-phase-note">보류된 작업: {heldItems.map(entry => `${entry.text}${entry.reason ? ` (보류: ${entry.reason}` : ""}${entry.resumeCondition ? ` · 재개 조건: ${entry.resumeCondition}` : ""}${entry.reason ? ")" : ""}`).join(" · ")}</p> : null}{phaseUnconfirmed ? <p className="ax-phase-note">처리 방식과 필수 기준을 확인한 후 허용된 범위에서 진행합니다.</p> : null}</div>
        <div className="ax-phase-footer"><footer.Icon aria-hidden="true" /><div><strong>{footer.title}</strong><p>{footer.text}</p></div></div>
        {i < last ? <span className="ax-phase-arrow" aria-hidden="true"><ArrowRight /></span> : null}
      </li>;
    })}</ol>
    <p className="ax-phases-note"><Info aria-hidden="true" />단계별 진행 여부는 확인 조건과 담당자 검토 결과에 따라 결정됩니다. ‘향후 단계’는 현재 실행 범위가 아닙니다.</p>
  </div>;
}

export function AxExecutionTimeline({ diagnosis: d, plan, hitlReviews, hitlTool }: { diagnosis: AxDiagnosis; plan?: AxPlan; hitlReviews?: HitlReview[]; hitlTool?: AxToolId }) {
  const model = buildAgentInstructionModel(plan, { diagnosis: d, hitlReviews, hitlTool });
  const profile = model.profile ?? executionProfile(d);
  return <section className="ax-section ax-panel ax-execution-timeline" aria-label="실행 로드맵">
    <header className="ax-result-head"><h3>실행 로드맵</h3><small>Level {profile.level} 기준 · {GATE_LABELS[profile.gate]}</small></header>
    <p className="ax-execution-intro">{profile.gate === "blocked" ? "진행 보류 · 차단 사유를 해결하고 재진단하기 전까지 구현하지 않습니다."
      : profile.level === 0 ? "Level 0 · 현재 단계는 처리 가능성 검토·검증만 진행합니다."
      : profile.gate === "conditional" ? "선행 조건 확인 후 범위를 결정합니다. 아래 항목은 지금 구현 가능한 작업이 아닙니다."
      : "현재 진단에서 허용된 처리 범위와 담당자를 표시합니다."}</p>
    {profile.roadmap.length ? <AxRoadmapPhases model={model} profile={profile} /> : null}
    {profile.stepScope.length ? <Accordion className="ax-execution-steps" keepMounted><AccordionItem value="steps" className="border-b-0">
      <AccordionTrigger className="ax-execution-steps-trigger"><span className="ax-execution-steps-label">업무 단계 상세<span className="ax-muted">{profile.stepScope.length}단계 · 담당자·처리 방식·구현 범위</span></span></AccordionTrigger>
      <AccordionPanel><ol className="ax-execution-list">{stepDetailEntries(model, profile).map((entry, i) => {
        const { step, modelIndex, disposition } = entry;
        return <li className="ax-execution-item" data-scope={step.scope} data-owner={step.owner} key={i}>
          <span className="ax-execution-node">{i + 1}</span>
          <div className="ax-execution-content"><strong>{step.step} · {OWNER_LABELS[step.owner]}</strong>
            {step.note ? <p>{step.note}</p> : null}
            {disposition ? <p>{disposition.action === "exclude" ? "HITL 제외" : "HITL 보류"}{disposition.reason ? `: ${disposition.reason}` : ""}{disposition.resumeCondition ? ` · 재개 조건: ${disposition.resumeCondition}` : ""}</p>
              : step.treatment && modelIndex !== null ? <small>{step.scope === "future" ? "향후 범위: " : "처리 방식: "}{stepMethodLabel(model, modelIndex)}</small> : null}
          </div>
          <Badge variant="outline" className="ax-scope-badge" data-scope={step.scope}>{disposition ? disposition.action === "exclude" ? "제외" : "보류" : SCOPE_LABELS[step.scope]}</Badge>
        </li>;
      })}</ol></AccordionPanel>
    </AccordionItem></Accordion> : <p className="ax-muted">진단된 업무 단계 없음</p>}
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
      <div className="ax-process-steps"><h4>현재 업무 단계 ({d.asIs.steps.length}단계)</h4>
        {d.asIs.steps.length ? <ol className="ax-process-flow">{d.asIs.steps.map((step, i) => <li className="ax-process-node" key={i}>
          <span className="ax-process-node-number">{String(i + 1).padStart(2, "0")}</span><span>{step}</span>
          {i < d.asIs.steps.length - 1 ? <ArrowRight className="ax-process-arrow" aria-hidden="true" /> : null}
        </li>)}</ol> : <p className="ax-muted">기재된 내용 없음</p>}
      </div>
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

/** 검토 건수 표시: 전체·검토 완료는 항상 보여 접힌 상태에서도 상태를 알 수 있게 하고,
 * 검토 필요가 0건이면 해당 구간은 숨긴다 (매트릭스 상단 집계와 같은 0건 생략 원칙). */
function ReviewCounts({ total, completed }: { total: number; completed: number }) {
  const needs = total - completed;
  return <div className="ax-hitl-table-counts">
    <span>전체 {total}</span>
    <span>·</span>
    <span>검토 완료 {completed}</span>
    {needs ? <><span>·</span><span>검토 필요 {needs}</span></> : null}
  </div>;
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

  return <section className="ax-section" aria-label="위험·확인사항 검토">
    <Accordion value={tableOpen ? ["review"] : []} onValueChange={values => { if (!panelOpen) setUserOpen(values.includes("review")); }} keepMounted>
    <AccordionItem value="review" className="border-b-0">
    <div className="ax-hitl-table-card">
      <AccordionTrigger className="ax-hitl-table-trigger py-0 items-center" disabled={panelOpen}>
        <span className="ax-hitl-table-header">
          <span className="ax-hitl-table-title">
            <span className="ax-hitl-table-icon" data-tone="warning"><ShieldAlert size={19} aria-hidden="true" /></span>
            <h3>위험·확인사항 검토</h3>
          </span>
          <ReviewCounts total={items.length} completed={completedCount} />
        </span>
      </AccordionTrigger>
      <AccordionPanel className="ax-hitl-table-panel pb-0">
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
      </AccordionPanel>
    </div>
    </AccordionItem>
    </Accordion>
  </section>;
}
function AxStepTable({ diagnosis: d, headers, reviewProps }: { diagnosis: AxDiagnosis; headers: [string, string, string, string]; reviewProps?: AxProcessReviewProps }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
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

    return <section className="ax-section" aria-label="단계별 자동화 판단">
      <Accordion value={tableOpen ? ["review"] : []} onValueChange={values => { if (!panelOpen) setUserOpen(values.includes("review")); }} keepMounted>
      <AccordionItem value="review" className="border-b-0">
      <div className="ax-hitl-table-card">
        <AccordionTrigger className="ax-hitl-table-trigger py-0 items-center" disabled={panelOpen}>
          <span className="ax-hitl-table-header">
            <span className="ax-hitl-table-title">
              <span className="ax-hitl-table-icon" data-tone="primary"><ListChecks size={19} aria-hidden="true" /></span>
              <h3>단계별 자동화 판단</h3>
            </span>
            <ReviewCounts total={stepItems.length} completed={completedCount} />
          </span>
        </AccordionTrigger>
        <AccordionPanel className="ax-hitl-table-panel pb-0">
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
        </AccordionPanel>
      </div>
      </AccordionItem>
      </Accordion>
    </section>;
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
/** Tokens too generic to link a check topic to a single TO-BE step on their own. */
const TOBE_CHECK_STOPWORDS = new Set(["데이터", "정보", "확인", "여부", "관련", "사항", "방식", "경우", "진행", "필요", "시스템", "자동", "수동", "대상", "업무", "사용", "제공", "처리", "기준", "현재", "적용"]);
/** Display-only linkage between TO-BE steps and still-unconfirmed technical checks.
 * A step is linked only when a specific token of an unconfirmed check topic (stopwords
 * excluded) literally appears in the step name or its original description — both strings
 * come from the diagnosis itself, so no condition is invented and no step is bulk-marked.
 * Confirmed checks never mark a step. Returns step index → linked check topics. */
export function toBeStepCheckTopics(d: AxDiagnosis): Map<number, string[]> {
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, "");
  const linked = new Map<number, string[]>();
  for (const check of d.technicalChecks) {
    if (check.status === "확인됨") continue;
    const topic = check.topic.trim();
    if (!topic) continue;
    const tokens = topic.split(/[\s·/()]+/).map(t => t.trim().toLowerCase()).filter(t => t.length >= 2 && !TOBE_CHECK_STOPWORDS.has(t));
    if (!tokens.length) continue;
    d.toBe.forEach((s, i) => {
      const haystack = norm(`${s.step} ${s.description}`);
      if (tokens.some(token => haystack.includes(token))) {
        const topics = linked.get(i) ?? [];
        if (!topics.includes(topic)) topics.push(topic);
        linked.set(i, topics);
      }
    });
  }
  return linked;
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
  const checkTopics = toBeStepCheckTopics(d);
  return <section className="ax-section ax-panel ax-tobe-card"><header className="ax-process-head"><h3>TO-BE · 역할과 흐름 (목표 프로세스)</h3><small>자동화 도입 후 예상 업무 흐름 · 구현 완료 아님</small></header>
    {d.toBe.length ? <ol className="ax-tobe-flow">{d.toBe.map((s, i) => { const Icon = icons[s.owner]; const desc = descriptionFor(s); const topics = checkTopics.get(i); return <li className="ax-tobe-item" data-owner={s.owner} key={i}>
      <span className="ax-tobe-icon"><Icon aria-hidden="true" /></span><strong>{s.step}</strong><span>{OWNER_LABELS[s.owner]}</span>{desc ? <p>{desc}</p> : null}
      {topics?.length ? <span className="ax-tobe-check"><CircleAlert size={12} aria-hidden="true" />확인 필요: {topics.join(" · ")}</span> : null}
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
      <div className="ax-guide-code-wrap"><pre className={block.singleLine ? "ax-guide-code ax-guide-code--single-line" : "ax-guide-code"} aria-label={ariaLabel}><span className="ax-guide-code-label" aria-hidden="true">{label}</span><code>{guideCodeDisplayText(block.lines)}</code></pre><AxCopyButton key={block.lines.join("\n")} text={block.lines.join("\n")} label={`${ariaLabel} 복사`} iconOnly /></div>
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
            <span className="ax-tutorial-terms-title"><BookOpen aria-hidden="true" />{glossary.title}</span>
            <span className="ax-tutorial-terms-action" aria-hidden="true"><span>펼치기</span><span>접기</span></span>
          </AccordionTrigger>
          <AccordionPanel className="ax-tutorial-terms-panel">
            {glossary.blocks.map((block, blockIndex) => block.kind === "steps" ? <dl key={blockIndex}>{block.items.map(term => {
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
          {index === 2 ? <Button type="button" variant="default" className="ax-guide-step-cta" onClick={onGoToInstructions} aria-controls={instructionsId}>04 올인원 지시문으로 이동</Button> : null}
        </section>;
      })}
    </section>)}
  </div>;
}

/** One heading pattern for 01~04: filled number badge, title and an inline muted purpose line. */
function AxPlanHeading({ no, title, description, id }: { no: string; title: string; description?: string; id?: string }) {
  return <div className="ax-plan-title"><h4 id={id} tabIndex={id ? -1 : undefined}><span className="ax-plan-no">{no}</span> {title}</h4>{description ? <p className="ax-plan-desc">{description}</p> : null}</div>;
}
/** Item markers classify the card; they never mean the work is done. */
function AxScopeCard({ tone, icon, title, description, items, notes }: { tone: "include" | "human" | "excluded"; icon: ReactNode; title: string; description: string; items: string[]; notes?: string[] }) {
  if (!items.length) return null;
  return <div className="ax-scope-card" data-tone={tone}>
    <div className="ax-scope-card-head"><span className="ax-scope-icon" aria-hidden="true">{icon}</span><div><h5>{title}</h5><p>{description}</p></div></div>
    <ul role="list">{items.map((item, i) => <li key={i}><CircleCheck aria-hidden="true" /><span>{item}</span></li>)}</ul>
    {notes?.length ? <div className="ax-scope-card-notes">{notes.map((note, i) => <p key={i}>{note}</p>)}</div> : null}
  </div>;
}
const CHECK_TONES: Record<AxCheckTone, { label: string; Icon: typeof CircleAlert }> = {
  required: { label: "확인 필요", Icon: CircleAlert }, future: { label: "향후 검토", Icon: Clock },
  done: { label: "확인 완료", Icon: CircleCheck }, blocked: { label: "불가", Icon: TriangleAlert },
  held: { label: "보류", Icon: Clock },
};
/** Topical icon for a prerequisite card; presentation only, never a data claim. */
function prereqIcon(topic: string) {
  const Icon = /(api|연동|인터페이스|시스템)/iu.test(topic) ? MonitorCog
    : /(인증|권한|보안|승인|결재)/u.test(topic) ? ShieldCheck
    : /(데이터|형식|파일|컬럼|db|스키마)/iu.test(topic) ? Database
    : ClipboardList;
  return <Icon aria-hidden="true" />;
}
function AxPrereqCard({ topic, note, tone, status, relation }: { topic: string; note: string; tone: AxCheckTone; status: string; relation?: string }) {
  const { label } = CHECK_TONES[tone];
  return <div className="ax-prereq-card" data-tone={tone} data-status={status}>
    <span className="ax-prereq-icon" aria-hidden="true">{prereqIcon(topic)}</span>
    <div className="ax-prereq-card-head"><h5>{topic}</h5><span className="ax-check-badge">{label}</span>{relation ? <span className="ax-check-badge">{relation}</span> : null}</div>
    {note ? <p>{note}</p> : null}
  </div>;
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
/** Trigger label for the collapsible 01~03 plan blocks: same number-badge pattern as AxPlanHeading, plus data-driven status badges that stay visible while collapsed. */
function AxPlanBlockHeading({ no, title, badges }: { no: string; title: string; badges?: ReactNode }) {
  return <span className="ax-plan-title"><span className="ax-plan-heading"><span className="ax-plan-no">{no}</span> {title}</span>{badges}</span>;
}
/** Diagnosis policy is authoritative: the summary shows only the permitted scope, open conditions and completion checks. */
function AxPlanOverview({ profile, summary }: { profile: ExecutionProfile; summary: AxPlanSummary }) {
  const reviewOnly = profile.level === 0 || profile.gate === "blocked";
  const criteria = [
    { label: "검증 방법", Icon: Search, items: summary.tests, notice: summary.testsNotice },
    { label: "통과 조건", Icon: ClipboardCheck, items: summary.success, notice: summary.criteriaNotice },
    { label: "실패 기준", Icon: CircleX, items: summary.failure, notice: summary.criteriaNotice },
    // 최종 승인 criteria come only from explicit approval constraints in the original
    // data; a 담당자 수행 유지 item by itself is not an approval requirement.
    { label: "최종 승인", Icon: ShieldCheck, items: summary.approvals },
  ].filter(row => row.items.length);
  const includeDisplay = foldScopeItems(summary.include);
  const humanItems = dedupeHumanItems(summary.humanKept);
  const requiredCheckCount = summary.checks.filter(check => check.tone === "required" || check.tone === "blocked").length
    + summary.additionalChecks.filter(check => check.tone === "required" || check.tone === "blocked").length;
  return <Accordion multiple keepMounted className="ax-plan-view">
    <section className="ax-plan-block" aria-label="01 구현 범위"><AccordionItem value="scope" className="ax-plan-item border-b-0">
      <AccordionTrigger className="ax-plan-trigger"><AxPlanBlockHeading no="01" title="구현 범위" /></AccordionTrigger>
      <AccordionPanel className="pb-0"><div className="ax-plan-panel-body"><p className="ax-plan-desc">현재 구현·보조할 작업과 사람에게 남길 작업을 구분합니다.</p>
      <div className="ax-scope-cards">
        <AxScopeCard tone="include" icon={<FileText />} items={includeDisplay.items}
          notes={[...(includeDisplay.unconfirmed ? ["미확정 처리 방식과 필수 기준은 해당 단계에서 확인이 필요합니다."] : []), ...includeDisplay.notes]}
          title={reviewOnly ? "준비·검증" : profile.gate === "conditional" ? "선행 조건 확인 후 시범 적용" : "구현·보조 작업"}
          description={reviewOnly ? "자동화 구현 전 확인이 필요한 항목입니다." : profile.gate === "conditional" ? "필요한 조건을 확인한 뒤 일부 업무에서 시험할 항목입니다." : "현재 단계에서 구현·보조할 항목입니다."} />
        <AxScopeCard tone="human" icon={<UserRound />} title="담당자 수행 유지" description="현재는 담당자 판단이 필요한 작업입니다." items={humanItems} />
        <AxScopeCard tone="excluded" icon={<Ban />} title="현재 자동화 제외" description="자동 실행·운영 적용 등 현재 허용되지 않는 항목입니다. 구현·보조 대상의 자동 실행 제외를 포함합니다." items={summary.excluded} />
      </div>
      </div></AccordionPanel>
    </AccordionItem></section>
    <section className="ax-plan-block" aria-label="02 구현 전 확인사항"><AccordionItem value="checks" className="ax-plan-item border-b-0">
      <AccordionTrigger className="ax-plan-trigger"><AxPlanBlockHeading no="02" title="구현 전 확인사항" badges={<>{summary.blockReasons.length ? <span className="ax-check-badge" data-kind="block">진행 보류</span> : null}{requiredCheckCount ? <span className="ax-check-badge" data-kind="need">확인 필요 {requiredCheckCount}건</span> : null}</>} /></AccordionTrigger>
      <AccordionPanel className="pb-0"><div className="ax-plan-panel-body"><p className="ax-plan-desc">아래 항목은 자동화 구현 전에 확인해야 할 조건입니다. 실제 업무 환경과 자료를 기준으로 확인해 주세요.</p>
      {summary.blockReasons.length ? <div className="ax-prereq-blocked" data-tone="blocked">
        <span className="ax-prereq-icon" aria-hidden="true"><TriangleAlert /></span>
        <div><div className="ax-prereq-card-head"><h5>차단 사유</h5><span className="ax-check-badge">진행 보류</span></div>
          <ul role="list">{summary.blockReasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul></div>
      </div> : null}
      {summary.checks.length || summary.additionalChecks.length ? <div className="ax-prereq-cards">
        {summary.checks.map((check, i) => <AxPrereqCard key={`check-${i}`} topic={check.topic} note={check.note} tone={check.tone} status={check.status} />)}
        {summary.additionalChecks.map((row, i) => <AxPrereqCard key={`extra-${i}`} topic={row.item} note={row.content !== row.item ? row.content : ""} tone={row.tone} status={row.status} relation={row.relation} />)}
      </div> : null}
      {summary.data.length ? <div className="ax-plan-data-group">
        <h5>데이터·시스템 정보</h5>
        <dl className="ax-plan-data">{summary.data.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.items.join(" · ")}</dd></div>)}</dl>
      </div> : null}
      </div></AccordionPanel>
    </AccordionItem></section>
    <section className="ax-plan-block" aria-label="03 완료 기준"><AccordionItem value="done" className="ax-plan-item border-b-0">
      <AccordionTrigger className="ax-plan-trigger"><AxPlanBlockHeading no="03" title="완료 기준" badges={summary.approvals.length ? <span className="ax-check-badge" data-kind="need">담당자 승인 필요</span> : null} /></AccordionTrigger>
      <AccordionPanel className="pb-0"><div className="ax-plan-panel-body"><p className="ax-plan-desc">기능·예외·검증·담당자 승인 조건을 충족해야 합니다.</p>
      {criteria.length || summary.exceptions.length ? <div className="ax-done-grid" data-split={criteria.length && summary.exceptions.length ? "true" : undefined}>
        {criteria.length ? <dl className="ax-done-criteria">{criteria.map(({ label, Icon, items, notice }) => <div key={label}>
          <dt><Icon aria-hidden="true" />{label}</dt>
          <dd>{items.length === 1 && !notice ? items[0] : <>{items.length === 1 ? items[0] : <ul role="list">{items.map((item, i) => <li key={i}>{item}</li>)}</ul>}{notice ? <p className="ax-criteria-notice">{notice}</p> : null}</>}</dd>
        </div>)}</dl> : null}
        {summary.exceptions.length ? <div className="ax-risk-panel">
          <h5><TriangleAlert aria-hidden="true" />주요 예외·위험 사항</h5>
          <ul role="list">{summary.exceptions.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </div> : null}
      </div> : <p className="ax-muted">진단에 기재된 완료 기준 없음</p>}
      </div></AccordionPanel>
    </AccordionItem></section>
  </Accordion>;
}
function AxPrompt({ prompt, name }: { prompt: string; name: string }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  return <>
    <pre id={contentId} className="ax-prompt" hidden={!expanded} data-expanded={expanded ? "true" : "false"}>{prompt}</pre>
    <div className="ax-prompt-actions">
      <Button type="button" variant="outline" className="ax-prompt-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>{expanded ? "전체 접기" : "전체 보기"}</Button>
      <AxCopyButton text={prompt} label={`${name}용 올인원 지시문 복사`} />
    </div>
  </>;
}
export function AxExecutionPackage({ plan, target, taskName, taskContext, prerequisites, diagnosis, hitlReviews }: {
  plan: AxPlan;
  target: AxToolId;
  taskName: string;
  taskContext: string;
  prerequisites: string[];
  diagnosis: AxDiagnosis;
  hitlReviews?: import("@/lib/ax/types").HitlReview[];
}) {
  const name = TOOL_GUIDES[target].name;
  const prompt = buildAllInOnePrompt(plan, target, {
    taskName,
    prerequisites,
    diagnosis,
    context: taskContext,
    hitlReviews,
    hitlTool: target === "codex" ? "codex" : "claude",
  });
  return <div className="ax-package">
    <AxPrompt key={prompt} prompt={prompt} name={name} />
  </div>;
}

/** 구현 계획 검토와 04 올인원 지시문·설치 가이드가 공유하는 코딩 도구 선택.
 * 명시적 선택이 우선하고, 선택이 없으면 계획이 존재하는 도구(Codex 우선)를 사용한다.
 * 도구 변경은 생성된 계획과 검토 데이터를 삭제하지 않으며, 각 도구의 검토 확정 상태는
 * 도구별 검토 키(planCodex:/planClaude:)로 분리 유지된다. */
export function resolveActiveTool(selectedTool: AxToolId | null, plans: { codex?: AxPlan; claude?: AxPlan }): AxToolId {
  return selectedTool ?? (plans.codex ? "codex" : "claude");
}
export function AxPlanSection({ diagnosis, taskName, taskContext, busy, onGenerate, reviewProps, activeTool: controlledTool, onToolChange }: {
  diagnosis: AxDiagnosis;
  taskName: string;
  taskContext: string;
  busy: string | null;
  onGenerate: (target: AxToolId) => void;
  reviewProps?: AxProcessReviewProps;
  /** 제어 모드: 부모가 도구 선택을 소유하면 로드맵·01~03·04가 같은 도구의 검토를 따른다.
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
  // 01~03 요약도 04와 같은 확정 검토를 반영한다. Gate blocked에서도 동일하게
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
  const level = automationLevel(diagnosis);
  return <section className="ax-surface" aria-label="자동화 구현 계획">
    <div className="ax-plan-head"><h3>자동화 구현 계획</h3>
      <span className="ax-plan-task">{taskName}</span>
      <AxPlanLevelTag level={level} />
      <span className="ax-gate-badge" data-gate={gate}>{GATE_LABELS[gate]}</span>
    </div>
    <AxPlanOverview profile={profile} summary={summary} />
    {gate === "blocked" ? <>
      <div className="ax-actions">{generateButton("codex")}{generateButton("claude")}</div>
    </> : <>
      {!plans.codex && !plans.claude ? <div className="ax-actions">{generateButton("codex")}{generateButton("claude")}</div> : null}
    </>}
    {reviewProps && (plans.codex || plans.claude) ? <AxPlanReview plans={plans} reviewProps={reviewProps} activeTool={activeTool} onToolChange={setSelectedTool} /> : null}
    <section ref={instructionsRef} id={`${instructionsId}-section`} className="ax-plan-instructions" aria-labelledby={instructionsId}><AxPlanHeading id={instructionsId} no="04" title="올인원 지시문" />
      {gate === "blocked" ? <p role="status" className="ax-notice">현재 진단에서는 구현 계획 생성 불가</p> : <>
        {plans.codex || plans.claude ?
          <Tabs className="ax-tool-tabs" value={activeTool} onValueChange={value => { if (value === "codex" || value === "claude") setSelectedTool(value); }}>
            <div className="ax-plan-toolbar">
              <TabsList aria-label="AI 코딩 도구 선택"><TabsTab value="codex">Codex</TabsTab><TabsTab value="claude">Claude Code</TabsTab></TabsList>
            </div>
            {(["codex", "claude"] as const).map(target => <TabsPanel key={target} value={target}>{target === activeTool ? plans[target] ? <><p className="ax-plan-tool-hint">{TOOL_GUIDES[target].name}에서 현재 프로젝트를 열고 올인원 지시문 붙여넣기</p><AxExecutionPackage plan={plans[target]} target={target} taskName={taskName} taskContext={taskContext} prerequisites={prerequisites} diagnosis={diagnosis} hitlReviews={reviewProps?.reviews} /></> : <><p className="ax-plan-generate-hint">{TOOL_GUIDES[target].name}용 구현 계획 생성 후 올인원 지시문 확인</p>{generateButton(target)}</> : null}</TabsPanel>)}
          </Tabs> : <p className="ax-muted">도구별 구현 계획 생성 후 올인원 지시문 확인</p>}
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
 * 도구 선택은 AxPlanSection의 공통 상태와 공유한다: 04 올인원 지시문·설치 가이드와 양방향 연동된다.
 * 각 도구의 검토 항목은 도구별 검토 키(planCodex:/planClaude:)로 분리되므로 도구 전환 후에도
 * 기존 확정 결과가 유지되고, 확정하지 않은 검토 결과가 다른 도구에 임의 반영되지 않는다. */
function AxPlanReview({ plans, reviewProps, activeTool, onToolChange }: {
  plans: { codex?: AxPlan; claude?: AxPlan };
  reviewProps: AxProcessReviewProps;
  activeTool: AxToolId;
  onToolChange: (tool: AxToolId) => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);

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

  return <section className="ax-section" aria-label="구현 계획 검토">
    <div className="ax-hitl-table-card">
      <div className="ax-hitl-table-header">
        <div className="ax-hitl-table-title">
          <span className="ax-hitl-table-icon" data-tone="primary"><ClipboardCheck size={19} aria-hidden="true" /></span>
          <h3>구현 계획 검토</h3>
        </div>
        <div className="ax-hitl-table-counts">
          <span>전체 {items.length}</span>
          <span>·</span>
          <span>검토 완료 {completedCount}</span>
          <span>·</span>
          <span>검토 필요 {items.length - completedCount}</span>
        </div>
      </div>
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
            {items.map(({ tool, item }) => {
              const review = findReview({ reviews: reviewProps.reviews } as AxTaskV2, item.key);
              const isOpen = openKey === item.key;
              const typeLabel = item.type === "planItem" ? "구현 항목" : "완료 기준";
              const badgeClass = item.type === "planItem" ? "ax-hitl-type-badge-plan" : "ax-hitl-type-badge-criterion";
              const displayState = reviewDisplayState(item, review, validKeys);
              return <>
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
              </>;
            })}
          </tbody>
        </table>
      </div>
    </div>
  </section>;
}
