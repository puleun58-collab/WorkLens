"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, ArrowRight, BookOpen, Bot, BrainCircuit, Check, CheckCircle2, Clipboard, ClipboardList, CloudUpload, Copy, Database, Download, FileCode2, FileOutput, Folder, GitBranch, Globe, Info, MonitorCog, Play, Settings2, ShieldCheck, Target, Terminal, UserRound } from "lucide-react";
import type { AxDiagnosis, AxPlan, AxTask } from "@/lib/ax/types";
import { automationLevel, axes, executionGate, executionProfile, factorEffectiveValue, GATE_LABELS, nextAction, type ExecutionProfile } from "@/lib/ax/policy";
import { FACTOR_KEYS } from "@/lib/ax/schema";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import { buildAllInOnePrompt, planSummary, setupGuide, TOOL_GUIDES, type AxGuideBlock, type AxGuideSection, type AxPlanSummary, type AxToolId } from "@/lib/ax/guide";

const VERDICT_LABELS = { 자동화: "자동화", "AI 보조": "AI 보조", "사람 유지": "담당자 수행" } as const;
const OWNER_LABELS = { 시스템: "시스템", AI: "AI", 사용자: "담당자" } as const;
/** Long factor names break at a fixed point so every radar label uses the same one- or two-line rhythm. */
const RADAR_LABEL_LINES: Record<typeof FACTOR_KEYS[number], string[]> = {
  repetition: ["반복성"], regularity: ["규칙성"], dataStructure: ["데이터", "구조화"], systemAccess: ["시스템", "접근성"], humanJudgment: ["담당자 판단", "필요도"], operationalRisk: ["운영", "위험"],
};

export function AxList({ items }: { items: string[] }) {
  return items.length ? <ul>{items.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p className="ax-muted">기재된 내용 없음</p>;
}
export function AxSummary({ task, showGate = true }: { task: AxTask; showGate?: boolean }) {
  if (!task.diagnosis) return null;
  const a = axes(task.diagnosis), l = automationLevel(task.diagnosis), action = nextAction(task.diagnosis), gate = executionGate(task.diagnosis);
  // Only real prerequisite topics or blockers are named; the generic gate fallback sentence is not repeated next to the status.
  const checks = gate === "conditional" ? task.diagnosis.technicalChecks.filter(c => c.status !== "확인됨").map(c => c.topic) : [];
  const blocker = gate === "blocked" ? task.diagnosis.decisionGate.reasons[0] ?? task.diagnosis.technicalChecks.find(c => c.status === "불가")?.topic : undefined;
  return <div className="ax-summary">
    <Badge variant="outline" className="ax-level-badge">{l.label.replace(/^L\d+ /, "")} · Level {l.level}{l.provisional ? " · 잠정" : ""}</Badge>
    {showGate ? <p className="ax-gate-line"><span>실행 상태</span><span className="ax-gate-badge" data-gate={gate}>{GATE_LABELS[gate]}</span></p> : null}
    {showGate && (checks.length || blocker) ? <p className="ax-gate-checks"><span>{checks.length ? "확인 필요" : "보류 사유"}</span>{checks.length ? checks.join(" · ") : blocker}</p> : null}
    <p>자동화 가치 {a.value} · 기술 실현 가능성 {a.feasibility} · 담당자 판단 필요도 {a.judgment} · 운영 위험 {a.risk}</p>
    {showGate ? <p><strong>{action.label}</strong> — {action.detail}</p> : null}
  </div>;
}
export function AxResultSummary({ task }: { task: AxTask }) {
  const d = task.diagnosis;
  if (!d) return null;
  const level = automationLevel(d), profile = executionProfile(d), metrics = axes(d);
  const indicators = [
    { label: "자동화 가치", value: metrics.value },
    { label: "기술 실현 가능성", value: metrics.feasibility },
    { label: "담당자 판단 필요도", value: metrics.judgment },
    { label: "운영 위험", value: metrics.risk },
  ];
  const groups = [
    { verdict: "자동화", label: "자동화 적합 단계", icon: Settings2 },
    { verdict: "AI 보조", label: "AI 보조 단계", icon: BrainCircuit },
    { verdict: "사람 유지", label: "담당자 수행 단계", icon: UserRound },
  ] as const;
  return <section className="ax-section ax-panel ax-result-summary" aria-label="진단 요약">
    <header className="ax-result-head"><h3>진단 요약</h3><small>현재 상태와 핵심 결과</small></header>
    <div className="ax-result-band">
      <div className="ax-result-meta">
        <Badge variant="info" className="ax-result-level">{level.label.replace(/^L\d+ /u, "")} · Level {level.level}{level.provisional ? " · 잠정" : ""}</Badge>
        <span className="ax-gate-badge" data-gate={profile.gate}>{GATE_LABELS[profile.gate]}</span>
        {d.sourceNote ? <p>{d.sourceNote}</p> : null}
        <small>아래 단계별 건수는 진단상 목표 적합성으로, 현재 구현·배포 가능 범위가 아닙니다.</small>
      </div>
      <div className="ax-result-metrics" aria-label="진단 지표 · 1점부터 5점까지">{indicators.map(({ label, value }) => <div className="ax-result-metric" key={label}>
        <span>{label}</span><strong>{value} / 5</strong><span className="ax-result-meter" aria-hidden="true">{[1, 2, 3, 4, 5].map(n => <i key={n} data-on={n <= value ? "true" : "false"} />)}</span>
      </div>)}</div>
    </div>
    <div className="ax-result-counts">{groups.map(({ verdict, label, icon: Icon }) => <div className="ax-result-count" data-verdict={verdict} key={verdict}>
      <span className="ax-result-count-icon"><Icon aria-hidden="true" /></span><span>{label}</span>
      <strong>{d.stepAssessments.filter(step => step.verdict === verdict).length}개</strong>
    </div>)}</div>
  </section>;
}

const SCOPE_LABELS = { implement: "이번 구현", "after-check": "확인 후 구현", verify: "검토·검증만", future: "향후 확장", human: "담당자 유지" } as const;

export function AxExecutionTimeline({ diagnosis: d }: { diagnosis: AxDiagnosis }) {
  const profile = executionProfile(d);
  return <section className="ax-section ax-panel ax-execution-timeline" aria-label="실행 로드맵">
    <header className="ax-result-head"><h3>실행 로드맵</h3><small>Level {profile.level} 기준 · {GATE_LABELS[profile.gate]}</small></header>
    <p className="ax-execution-intro">{profile.gate === "blocked" ? "진행 보류 · 차단 사유를 해결하고 재진단하기 전까지 구현하지 않습니다."
      : profile.level === 0 ? "Level 0 · 현재 단계는 처리 가능성 검토·검증만 진행합니다."
      : profile.gate === "conditional" ? "선행 조건 확인 후 범위를 결정합니다. 아래 항목은 지금 구현 가능한 작업이 아닙니다."
      : "현재 진단에서 허용된 처리 범위와 담당자를 표시합니다."}</p>
    {profile.stepScope.length ? <ol className="ax-execution-list">{profile.stepScope.map((step, i) => <li className="ax-execution-item" data-scope={step.scope} data-owner={step.owner} key={i}>
      <span className="ax-execution-node">{i + 1}</span>
      <div className="ax-execution-content"><strong>{step.step} · {OWNER_LABELS[step.owner]}</strong>
        {step.note ? <p>{step.note}</p> : null}
        {step.treatment ? <small>{step.scope === "future" ? "향후 범위: " : "처리 방식: "}{step.treatment}</small> : null}
      </div>
      <Badge variant="outline" className="ax-scope-badge" data-scope={step.scope}>{SCOPE_LABELS[step.scope]}</Badge>
    </li>)}</ol> : <p className="ax-muted">진단된 업무 단계 없음</p>}
    {profile.roadmap.length ? <div className="ax-execution-phases"><h4>{profile.roadmapTitle} · 단계별 진행 계획</h4>
      <ol>{profile.roadmap.map((phase, i) => <li className="ax-execution-phase" key={i}>
        <strong>Phase {phase.phase} · {phase.title}</strong><AxList items={phase.items} />
      </li>)}</ol>
    </div> : null}
  </section>;
}
export function AxProcess({ diagnosis: d }: { diagnosis: AxDiagnosis }) {
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
      {d.asIs.systems.length ? <div className="ax-process-systems"><MonitorCog aria-hidden="true" /><div><h4>사용 시스템</h4><AxList items={d.asIs.systems} /></div></div> : null}
    </section>
    <section className="ax-section ax-panel"><h3>단계별 자동화 판단</h3><AxStepTable diagnosis={d} headers={["업무 단계", "판정", "담당", "판단 근거"]} /></section>
    <AxToBe diagnosis={d} />
  </>;
}
function AxStepTable({ diagnosis: d, headers }: { diagnosis: AxDiagnosis; headers: [string, string, string, string] }) {
  return <div className="ax-table-wrap"><table className="ax-step-table"><thead><tr>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{d.stepAssessments.length ? d.stepAssessments.map((s, i) => <tr key={i}>
    <td><span className="ax-step-number">{String(i + 1).padStart(2, "0")}</span>{s.step}</td>
    <td><Badge variant="outline" className="ax-verdict-badge" data-verdict={s.verdict}>{VERDICT_LABELS[s.verdict]}</Badge></td>
    <td>{OWNER_LABELS[s.owner]}</td><td>{s.note}</td>
  </tr>) : <tr><td colSpan={4}>기재된 단계 없음</td></tr>}</tbody></table></div>;
}
function AxToBe({ diagnosis: d }: { diagnosis: AxDiagnosis }) {
  const icons = { 시스템: Settings2, AI: Bot, 사용자: UserRound } as const;
  return <section className="ax-section ax-panel ax-tobe-card"><header className="ax-process-head"><h3>TO-BE · 역할과 흐름 (목표 프로세스)</h3><small>자동화 도입 후 예상 업무 흐름 · 구현 완료 아님</small></header>
    {d.toBe.length ? <ol className="ax-tobe-flow">{d.toBe.map((s, i) => { const Icon = icons[s.owner]; return <li className="ax-tobe-item" data-owner={s.owner} key={i}>
      <span className="ax-tobe-icon"><Icon aria-hidden="true" /></span><strong>{s.step}</strong><span>{OWNER_LABELS[s.owner]}</span><p>{s.description}</p>
      {i < d.toBe.length - 1 ? <ArrowRight className="ax-tobe-arrow" aria-hidden="true" /> : null}
    </li>; })}</ol> : <p className="ax-muted">기재된 목표 업무 단계 없음</p>}
  </section>;
}
export function AxRadar({ diagnosis }: { diagnosis: AxDiagnosis }) {
  const point = (index: number, radius: number) => {
    const angle = -Math.PI / 2 + index * Math.PI / 3;
    return { x: 110 + Math.cos(angle) * radius, y: 100 + Math.sin(angle) * radius };
  };
  const factors = FACTOR_KEYS.map(key => diagnosis.factors.find(f => f.key === key)!);
  const polygon = (radii: number[]) => radii.map((radius, i) => { const p = point(i, radius); return `${p.x},${p.y}`; }).join(" ");
  return <svg className="ax-radar" viewBox="0 0 220 200" role="img" aria-label="진단 항목 레이더">
    {[1, 2, 3, 4, 5].map(v => <polygon key={v} points={polygon(FACTOR_KEYS.map(() => v / 5 * 62))} fill="none" stroke="var(--border)" />)}
    {FACTOR_KEYS.map((key, i) => { const p = point(i, 62); return <line key={key} x1={110} y1={100} x2={p.x} y2={p.y} stroke="var(--border)" />; })}
    <polygon points={polygon(factors.map(f => factorEffectiveValue(f) / 5 * 62))} fill="color-mix(in srgb, var(--primary) 16%, transparent)" stroke="var(--primary)" strokeWidth={1.5} />
    {FACTOR_KEYS.map((key, i) => { const p = point(i, 76), lines = RADAR_LABEL_LINES[key]; return <text key={key} x={p.x} y={p.y} dominantBaseline="middle" textAnchor={Math.abs(p.x - 110) < 1 ? "middle" : p.x > 110 ? "start" : "end"} fontSize={9.5} fill="var(--muted-foreground)">{lines.map((line, j) => <tspan key={j} x={p.x} dy={j === 0 ? -(lines.length - 1) * 5.5 : 11}>{line}</tspan>)}</text>; })}
  </svg>;
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
function AxGuideText({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`)/g).map((part, i) => part.startsWith("`") ? <code className="ax-cmd" key={i}>{part.slice(1, -1)}</code> : part)}</>;
}
function AxGuideBlockView({ block, listStyle }: { block: AxGuideBlock; listStyle?: "bullets" }) {
  if (block.kind === "code") {
    const label = block.label ?? "PowerShell";
    const ariaLabel = label === "PowerShell" ? "PowerShell 명령" : label === ".gitignore" ? ".gitignore 예시" : "예시";
    return <>
      <div className="ax-guide-code-wrap"><pre className="ax-guide-code" aria-label={ariaLabel}><span className="ax-guide-code-label" aria-hidden="true">{label}</span><code>{block.lines.join("\n")}</code></pre><AxCopyButton key={block.lines.join("\n")} text={block.lines.join("\n")} label={`${ariaLabel} 복사`} iconOnly /></div>
      {block.notes?.length ? <ul className="ax-guide-code-notes ax-guide-list" role="list">{block.notes.map((note, i) => <li key={i}><span className="ax-guide-marker" aria-hidden="true">•</span><span className="ax-guide-text">{note}</span></li>)}</ul> : null}
    </>;
  }
  if (block.kind === "steps") {
    const checklist = block.items.every(item => item.startsWith("□ "));
    const items = block.items.map((item, i) => <li key={i}><span className="ax-guide-marker" aria-hidden="true">{checklist ? "□" : listStyle === "bullets" ? "•" : String(i + 1).padStart(2, "0")}</span><span className="ax-guide-text"><AxGuideText text={checklist ? item.slice(2) : item} /></span></li>);
    return checklist || listStyle === "bullets" ? <ul className="ax-guide-list" role="list">{items}</ul> : <ol className="ax-guide-list" role="list">{items}</ol>;
  }
  return <p><AxGuideText text={block.text} /></p>;
}
function AxGuideSectionView({ section, completion = false, warning = false, collapsed = section.collapsed }: { section: AxGuideSection; completion?: boolean; warning?: boolean; collapsed?: boolean }) {
  const content = <>
    {section.when ? <p className="ax-guide-when"><AxGuideText text={section.when} /></p> : null}
    {section.blocks.map((block, i) => <AxGuideBlockView key={i} block={block} listStyle={section.listStyle} />)}
  </>;
  return <section className={`ax-guide-section${completion ? " ax-guide-completion" : ""}${warning ? " ax-guide-warning" : ""}`}>
    <h5>{completion ? <><CheckCircle2 aria-hidden="true" />완료 확인 · </> : warning ? <AlertTriangle aria-hidden="true" /> : null}{section.title}</h5>
    {collapsed ? <Accordion className="ax-guide-terms"><AccordionItem value="terms">
      <AccordionTrigger className="ax-guide-terms-trigger">{section.collapsed ? "용어 설명 보기" : `${section.title} 자세히 보기`}</AccordionTrigger>
      <AccordionPanel className="ax-guide-terms-panel">{content}</AccordionPanel>
    </AccordionItem></Accordion> : content}
  </section>;
}

const SETUP_COURSES = [
  { title: "처음 한 번 준비", description: "설치 여부 확인 후 필요한 도구만 준비", Icon: Download, first: 1, last: 1 },
  { title: "프로젝트 작업", description: "프로젝트 열기 → AI 작업 → 실제 결과 확인", Icon: Folder, first: 2, last: 5 },
  { title: "GitHub·배포", description: "안전하게 저장 → 배포 → 실제 서비스 확인", Icon: CloudUpload, first: 6, last: 9 },
] as const;
const SETUP_ICONS = [Download, Folder, Terminal, Clipboard, CheckCircle2, ShieldCheck, GitBranch, CloudUpload, Globe] as const;
const SETUP_COMPLETIONS = new Set(["GitHub 인증 확인", "현재 위치 확인", "작업 시작 전 AI가 먼저 확인할 것", "테스트·빌드 확인", "실제 기능 확인", "GitHub에서 확인할 것", "실제 서비스 확인"]);
const SETUP_WARNINGS = new Set(["기존 .gitignore 확인", ".env와 .env.example", "이미 추적 중인 파일", "올리기 전 체크리스트", "git push가 곧 Production은 아닙니다", "먼저 현재 배포 환경 확인", "오류가 나면", "CI가 실패하면", "문제가 생기면", "되돌리기(Rollback)"]);
const SETUP_DETAILS: Record<string, true> = { "기본 명령": true };

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
      <Button type="button" variant="ghost" size="sm" aria-controls={instructionsId} onClick={onGoToInstructions}><span className="ax-tutorial-toc-title">지시문으로 이동</span></Button>
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
            <dl>{glossary.blocks.map(block => block.kind === "steps" ? block.items.map(term => {
              const split = term.indexOf(":");
              const name = term.slice(0, split);
              return <div key={term}><dt>{name === "환경변수(Environment Variable)" ? <><span>환경변수</span><span className="ax-tutorial-term-translation">(Environment Variable)</span></> : name}</dt><dd>{term.slice(split + 2)}</dd></div>;
            }) : null)}</dl>
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
          <p className="ax-guide-purpose">{step.purpose}</p>
          <p className="ax-tutorial-action-label"><Terminal aria-hidden="true" />실행 방법</p>
          {step.sections.map(section => <AxGuideSectionView key={section.title} section={section} completion={SETUP_COMPLETIONS.has(section.title)} warning={SETUP_WARNINGS.has(section.title)} collapsed={section.collapsed || (section.title in SETUP_DETAILS)} />)}
        </section>;
      })}
    </section>)}
  </div>;
}

function AxPlanList({ items }: { items: string[] }) {
  return <ul className="ax-plan-list" role="list">{items.map((item, i) => <li key={i}><span className="ax-plan-marker" aria-hidden="true">•</span><span className="ax-plan-text">{item}</span></li>)}</ul>;
}
function AxPlanGroup({ title, items, status }: { title: string; items: string[]; status?: string }) {
  if (!items.length) return null;
  return <div className="ax-plan-group"><h5>{title}{status ? <span className="ax-plan-status">{status}</span> : null}</h5><AxPlanList items={items} /></div>;
}
/** One heading pattern for 01~04: blue number, title, muted purpose line; sections are separated by dividers only. */
function AxPlanHeading({ no, title, description, id }: { no: string; title: string; description?: string; id?: string }) {
  return <><h4 id={id} tabIndex={id ? -1 : undefined}><span className="ax-plan-no">{no}</span> {title}</h4>{description ? <p className="ax-plan-desc">{description}</p> : null}</>;
}
/** Diagnosis policy is authoritative: the summary shows only the permitted scope, open conditions and completion checks. */
function AxPlanOverview({ diagnosis, profile, summary }: { diagnosis: AxDiagnosis; profile: ExecutionProfile; summary: AxPlanSummary }) {
  const shownChecks = new Set(diagnosis.technicalChecks.flatMap(check => [
    check.note ? `${check.topic} — ${check.note}` : check.topic,
    ...(check.status === "불가" ? [check.note ? `${check.topic} 불가 — ${check.note}` : `${check.topic} 불가`] : []),
  ]));
  const remainingPrerequisites = summary.prerequisites.filter(item => !shownChecks.has(item));
  return <div className="ax-plan-view">
    <section className="ax-plan-block" aria-label="01 구현 범위"><AxPlanHeading no="01" title="구현 범위" description="현재 구현·보조할 작업과 사람에게 남길 작업" />
      <AxPlanGroup title={profile.level === 0 || profile.gate === "blocked" ? "허용된 준비·검증" : profile.gate === "conditional" ? "조건 해결 후 샘플 범위" : "구현·보조 작업"} items={summary.include} />
      <AxPlanGroup title="담당자 수행 유지" items={summary.humanKept} />
      <AxPlanGroup title="현재 자동화 제외" items={summary.excluded} />
    </section>
    <section className="ax-plan-block" aria-label="02 시작 전 확인"><AxPlanHeading no="02" title="시작 전 확인" description="구현 전 해결해야 할 조건과 데이터 정보" />
      {diagnosis.technicalChecks.length ? <div className="ax-gate-cards">{diagnosis.technicalChecks.map((check, i) => <div className="ax-gate-card" data-status={check.status} key={i}>
        {check.status === "확인됨" ? <CheckCircle2 aria-hidden="true" /> : check.status === "불가" ? <AlertTriangle aria-hidden="true" /> : <AlertCircle aria-hidden="true" />}
        <div><h5>{check.topic}</h5><span>{check.status}</span>{check.note ? <p>{check.note}</p> : null}</div>
      </div>)}</div> : null}
      <AxPlanGroup title={profile.gate === "blocked" ? "차단 사유" : "선행 확인사항"} items={remainingPrerequisites} status={profile.gate === "conditional" ? "확인 필요" : undefined} />
      {summary.data.length ? <div className="ax-plan-group">
        <h5>데이터·시스템 정보</h5>
        <dl className="ax-plan-data">{summary.data.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.items.join(" · ")}</dd></div>)}</dl>
      </div> : null}
    </section>
    <section className="ax-plan-block" aria-label="03 완료 기준"><AxPlanHeading no="03" title="완료 기준" description="기능·예외·검증·담당자 승인 조건" />
      <AxPlanGroup title="성공·실패 기준" items={summary.acceptance} />
      <AxPlanGroup title="검증 방법" items={summary.tests} />
      <AxPlanGroup title="예외·위험 확인" items={summary.exceptions} />
      {summary.humanKept.length ? <p className="ax-plan-note">담당자 검토·승인 단계 유지</p> : null}
    </section>
  </div>;
}
function AxPrompt({ prompt, name }: { prompt: string; name: string }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  return <>
    <pre id={contentId} className="ax-prompt" hidden={!expanded} data-expanded={expanded ? "true" : "false"}>{prompt}</pre>
    <div className="ax-prompt-actions">
      <Button type="button" variant="outline" className="ax-prompt-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>{expanded ? "전체 접기" : "전체 보기"}</Button>
      <AxCopyButton text={prompt} label={`${name}용 지시문 복사`} />
    </div>
  </>;
}
export function AxExecutionPackage({ plan, target, taskName, taskContext, prerequisites, diagnosis }: { plan: AxPlan; target: AxToolId; taskName: string; taskContext: string; prerequisites: string[]; diagnosis: AxDiagnosis }) {
  const name = TOOL_GUIDES[target].name;
  const prompt = buildAllInOnePrompt(plan, target, { taskName, prerequisites, diagnosis, context: taskContext });
  return <div className="ax-package">
    <p className="ax-muted">{name}용 전체 지시문 · 접힌 상태에서도 원문 복사</p>
    <AxPrompt key={prompt} prompt={prompt} name={name} />
  </div>;
}

export function AxPlanSection({ diagnosis, taskName, taskContext, busy, onGenerate }: { diagnosis: AxDiagnosis; taskName: string; taskContext: string; busy: string | null; onGenerate: (target: AxToolId) => void }) {
  const profile = executionProfile(diagnosis);
  const gate = profile.gate;
  const prerequisites = gate === "blocked" ? [] : profile.prerequisites;
  const plans = { codex: diagnosis.planCodex, claude: diagnosis.planClaude };
  const [selectedTool, setSelectedTool] = useState<AxToolId | null>(null);
  const activeTool = selectedTool ?? (plans.codex ? "codex" : "claude");
  const activePlan = plans[activeTool];
  const summary = planSummary(diagnosis, gate !== "blocked" ? activePlan : undefined, [taskName, taskContext].join("\n"));
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
      <span className="ax-status-badge">{`Level ${profile.level} · ${level.label.replace(/^L\d+ /u, "")}${level.provisional ? " (잠정)" : ""}`}</span>
      <span className="ax-gate-badge" data-gate={gate}>{GATE_LABELS[gate]}</span>
    </div>
    <AxPlanOverview diagnosis={diagnosis} profile={profile} summary={summary} />
    {gate === "blocked" ? <>
      <div className="ax-actions">{generateButton("codex")}{generateButton("claude")}</div>
    </> : <>
      {!plans.codex && !plans.claude ? <div className="ax-actions">{generateButton("codex")}{generateButton("claude")}</div> : null}
    </>}
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
    <section ref={instructionsRef} id={`${instructionsId}-section`} className="ax-plan-instructions" aria-labelledby={instructionsId}><AxPlanHeading id={instructionsId} no="04" title="코딩 에이전트 지시문" />
      {gate === "blocked" ? <p role="status" className="ax-notice">현재 진단에서는 구현 계획 생성 불가</p> : <>
        {plans.codex || plans.claude ?
          <Tabs className="ax-tool-tabs" value={activeTool} onValueChange={value => { if (value === "codex" || value === "claude") setSelectedTool(value); }}>
            <div className="ax-plan-toolbar">
              <TabsList aria-label="AI 코딩 도구 선택"><TabsTab value="codex">Codex</TabsTab><TabsTab value="claude">Claude Code</TabsTab></TabsList>
            </div>
            {(["codex", "claude"] as const).map(target => <TabsPanel key={target} value={target}>{target === activeTool ? plans[target] ? <><p className="ax-plan-tool-hint">{TOOL_GUIDES[target].name}에서 현재 프로젝트를 열고 지시문 붙여넣기</p><AxExecutionPackage plan={plans[target]} target={target} taskName={taskName} taskContext={taskContext} prerequisites={prerequisites} diagnosis={diagnosis} /></> : <><p>{TOOL_GUIDES[target].name}용 구현 계획 생성 후 올인원 지시문 확인</p>{generateButton(target)}</> : null}</TabsPanel>)}
          </Tabs> : <p className="ax-muted">도구별 구현 계획 생성 후 지시문 확인</p>}
      </>}
    </section>
  </section>;
}
