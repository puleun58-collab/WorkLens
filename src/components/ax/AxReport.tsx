"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, FileCode2, Terminal } from "lucide-react";
import type { AxDiagnosis, AxPlan, AxTask } from "@/lib/ax/types";
import { automationLevel, axes, executionGate, executionProfile, factorEffectiveValue, GATE_LABELS, gateBlockReasons, gatePrerequisites, nextAction, type ExecutionProfile } from "@/lib/ax/policy";
import { FACTOR_KEYS } from "@/lib/ax/schema";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import { buildAllInOnePrompt, commonPlanView, planView, setupGuide, TOOL_GUIDES, type AxGuideBlock, type AxPlanView, type AxToolId } from "@/lib/ax/guide";

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
export function AxProcess({ diagnosis: d }: { diagnosis: AxDiagnosis }) {
  return <>
    <section className="ax-section ax-panel"><h3>AS-IS · 현재 업무</h3>
      <dl className="ax-definition"><dt>목적</dt><dd>{d.asIs.purpose}</dd><dt>시작 조건</dt><dd>{d.asIs.trigger}</dd><dt>입력</dt><dd><AxList items={d.asIs.inputs} /></dd><dt>업무 단계</dt><dd><AxList items={d.asIs.steps} /></dd><dt>출력</dt><dd><AxList items={d.asIs.outputs} /></dd><dt>예외</dt><dd><AxList items={d.asIs.exceptions} /></dd><dt>담당자 판단</dt><dd><AxList items={d.asIs.humanDecisions} /></dd><dt>시스템</dt><dd><AxList items={d.asIs.systems} /></dd></dl>
    </section>
    <section className="ax-section ax-panel"><h3>단계별 자동화 판단</h3><AxStepTable diagnosis={d} headers={["단계", "판정", "담당", "근거"]} /></section>
    <AxToBe diagnosis={d} />
  </>;
}
/** One step-assessment source for both the diagnosis table and the result scope view. */
function AxStepTable({ diagnosis: d, headers }: { diagnosis: AxDiagnosis; headers: [string, string, string, string] }) {
  return <div className="ax-table-wrap"><table className="ax-step-table"><thead><tr>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{d.stepAssessments.map((s, i) => <tr key={i}><td>{s.step}</td><td>{VERDICT_LABELS[s.verdict]}</td><td>{OWNER_LABELS[s.owner]}</td><td>{s.note}</td></tr>)}</tbody></table></div>;
}
function AxToBe({ diagnosis: d }: { diagnosis: AxDiagnosis }) {
  return <section className="ax-section ax-panel"><h3>TO-BE · 역할과 흐름</h3><ol className="ax-tobe-list">{d.toBe.map((s, i) => <li key={i}><strong>{s.step} · {OWNER_LABELS[s.owner]}</strong><p>{s.description}</p></li>)}</ol></section>;
}
/** Prerequisites come from the gate policy; a ready gate shows the confirmed technical checks instead. */
function AxChecks({ diagnosis: d, profile }: { diagnosis: AxDiagnosis; profile: ExecutionProfile }) {
  const rows = profile.prerequisites.length
    ? profile.prerequisites.map(item => { const [topic, ...note] = item.split(" — "); return { topic, detail: note.length ? `확인 필요 · ${note.join(" — ")}` : "확인 필요" }; })
    : d.technicalChecks.map(c => ({ topic: c.topic, detail: `${c.status}${c.note ? ` · ${c.note}` : ""}` }));
  return <section className="ax-section ax-panel"><h3>진행 전 확인사항</h3>{rows.length ? <ul className="ax-check-list">{rows.map((row, i) => <li key={i}><strong>{row.topic}</strong><span>{row.detail}</span></li>)}</ul> : <p className="ax-muted">선행 확인사항 없음</p>}{d.risks.length ? <div className="ax-risk-block"><h4>주의사항·위험요소</h4><ul className="ax-risk-list">{d.risks.map((risk, i) => <li key={i}>{risk}</li>)}</ul></div> : null}</section>;
}
/** Roadmap timeline shared by the dark Step 4 panel and the report; content always comes from the execution profile. */
export function AxRoadmapPhases({ profile, timeline = false }: { profile: ExecutionProfile; timeline?: boolean }) {
  return timeline
    ? <ol className="ax-timeline">{profile.roadmap.map((r, i) => <li key={i}><span className="ax-timeline-node">{i + 1}</span><div><h4>Phase {r.phase} · {r.title}</h4></div></li>)}</ol>
    : <ol>{profile.roadmap.map((r, i) => <li key={i}><h4>{r.phase} · {r.title}</h4><AxList items={r.items} /></li>)}</ol>;
}
export function AxRoadmap({ diagnosis: d, roadmapSection = true }: { diagnosis: AxDiagnosis; roadmapSection?: boolean }) {
  const profile = executionProfile(d);
  return <>
    <AxToBe diagnosis={d} />
    {roadmapSection ? <>
      <section className="ax-section ax-panel"><h3>자동화 적용 범위</h3><AxStepTable diagnosis={d} headers={["업무 단계", "처리 방식", "담당", "이유"]} /></section>
      <AxChecks diagnosis={d} profile={profile} />
      <section className="ax-section ax-panel"><h3>사전 검증(PoC)</h3><dl className="ax-definition">{([['inScope', '포함'], ['outOfScope', '제외'], ['inputs', '입력'], ['outputs', '출력'], ['evaluation', '평가 방법'], ['success', '성공 기준'], ['failure', '실패 기준']] as const).map(([key, label]) => <div className="ax-definition-row" key={key}><dt>{label}</dt><dd><AxList items={profile.poc[key]} /></dd></div>)}</dl></section>
    </> : <section className="ax-section ax-panel"><h3>자동화 판단 근거</h3><AxStepTable diagnosis={d} headers={["업무 단계", "판단", "담당", "근거"]} /></section>}
    {roadmapSection ? <section className="ax-section ax-panel"><h3>{profile.roadmapTitle}</h3><AxRoadmapPhases profile={profile} /></section> : null}
  </>;
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

export function AxCopyButton({ text, label }: { text: string; label: string }) {
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
    <span className="sr-only" aria-live="polite">{copied ? "복사했습니다." : ""}</span>
    <Button type="button" className="ax-copy-button" data-copied={copied ? "true" : undefined} aria-label={label} onClick={() => void copy()}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}복사</Button>
    {failed ? <p className="ax-copy-error" role="status">복사하지 못했습니다. 직접 선택해 복사해주세요.</p> : null}
  </>;
}

// Guide strings use backticks to mark commands without introducing HTML into data.
function AxGuideText({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`)/g).map((part, i) => part.startsWith("`") ? <code className="ax-cmd" key={i}>{part.slice(1, -1)}</code> : part)}</>;
}
function AxGuideBlockView({ block }: { block: AxGuideBlock }) {
  if (block.kind === "code") {
    const label = block.label ?? "PowerShell";
    const ariaLabel = label === "PowerShell" ? "PowerShell 명령" : label === ".gitignore" ? ".gitignore 예시" : "예시";
    return <>
      <pre className="ax-guide-code" aria-label={ariaLabel}><span className="ax-guide-code-label" aria-hidden="true">{label}</span><code>{block.lines.join("\n")}</code></pre>
      {block.notes ? <ul className="ax-guide-code-notes">{block.notes.map((note, i) => <li key={i}>{note}</li>)}</ul> : null}
    </>;
  }
  if (block.kind === "steps") return <ol className="ax-guide-list">{block.items.map((item, i) => <li key={i}><AxGuideText text={item} /></li>)}</ol>;
  return <p><AxGuideText text={block.text} /></p>;
}
function AxSetupGuide({ tool }: { tool: AxToolId }) {
  return <>{setupGuide(tool).map(step => <div className="ax-guide-step" key={step.title}>
    <h4>{step.title}</h4>
    {step.sections.map(section => <section className="ax-guide-section" key={section.title}>
      <h5>{section.title}</h5>
      {section.when ? <p className="ax-guide-when"><AxGuideText text={section.when} /></p> : null}
      {section.blocks.map((block, i) => <AxGuideBlockView key={i} block={block} />)}
    </section>)}
  </div>)}</>;
}

function AxPlanList({ items }: { items: string[] }) {
  return <ul className="ax-plan-list" role="list">{items.map((item, i) => <li key={i}><span className="ax-plan-text">{item}</span></li>)}</ul>;
}
/** Human review of the plan: 한눈에 보기 then six document sections; long secondary detail stays collapsed. */
function AxPlanOverview({ view, summary = true }: { view: AxPlanView; summary?: boolean }) {
  const scope: [string, string[]][] = [["포함", view.include], ["사람이 계속 확인", view.humanKept], ["제외", view.excluded]];
  return <div className="ax-plan-view">
    {summary ? <section className="ax-plan-glance" aria-label="한눈에 보기"><h4>한눈에 보기</h4>
      <dl>{view.glance.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
    </section> : null}
    {view.goals.length ? <section className="ax-plan-block"><h4>구현 목표</h4><AxPlanList items={view.goals} /></section> : null}
    {scope.some(([, items]) => items.length) ? <section className="ax-plan-block"><h4>구현 범위</h4>
      {scope.map(([label, items]) => items.length ? <div className="ax-plan-group" key={label}><h5>{label}</h5><AxPlanList items={items} /></div> : null)}
    </section> : null}
    {view.steps.length || view.poc.length ? <section className="ax-plan-block"><h4>구현 순서</h4>
      {view.poc.length ? <div className="ax-plan-group"><h5>먼저 사전 검증</h5><AxPlanList items={view.poc} /></div> : null}
      {view.steps.length ? <ol className="ax-plan-steps">{view.steps.map((step, i) => <li key={i}><span className="ax-plan-step-no" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span><span className="ax-plan-text">{step.replace(/^\s*(?:\d+[.)]|[①-⑳])\s*/u, "")}</span></li>)}</ol> : null}
    </section> : null}
    {view.data.length ? <section className="ax-plan-block"><h4>데이터·연동</h4>
      {view.data.map(row => <div className="ax-plan-group" key={row.label}><h5>{row.label}</h5><AxPlanList items={row.items} /></div>)}
    </section> : null}
    {view.prerequisites.length || view.exceptions.length || view.details.length ? <section className="ax-plan-block"><h4>예외·안전</h4>
      {view.prerequisites.length ? <div className="ax-plan-group"><h5>선행 확인 <span className="ax-plan-status">확인 필요</span></h5><AxPlanList items={view.prerequisites} /></div> : null}
      {view.exceptions.length ? <div className="ax-plan-group"><h5>예외 처리</h5><AxPlanList items={view.exceptions} /></div> : null}
      {view.details.length ? <AxPlanDetails details={view.details} /> : null}
    </section> : null}
    {view.tests.length || view.acceptance.length ? <section className="ax-plan-block"><h4>검증·완료 조건</h4>
      {view.tests.length ? <div className="ax-plan-group"><h5>검증</h5><AxPlanList items={view.tests.slice(0, 4)} />{view.tests.length > 4 ? <AxPlanDetails details={[{ title: "검증 상세 보기", items: view.tests.slice(4) }]} /> : null}</div> : null}
      {view.acceptance.length ? <div className="ax-plan-group"><h5>완료 조건</h5><AxPlanList items={view.acceptance} /></div> : null}
    </section> : null}
  </div>;
}
function AxPlanDetails({ details }: { details: AxPlanView["details"] }) {
  return <Accordion className="ax-plan-details" multiple>{details.map(detail => <AccordionItem key={detail.title} value={detail.title} className="ax-plan-detail">
    <AccordionTrigger className="ax-plan-detail-trigger"><span className="ax-plan-detail-title">{detail.title}</span><span className="ax-plan-detail-count">{detail.items.length}건</span></AccordionTrigger>
    <AccordionPanel className="ax-plan-detail-panel"><AxPlanList items={detail.items} /></AccordionPanel>
  </AccordionItem>)}</Accordion>;
}
export function AxExecutionPackage({ plan, target, taskName, taskContext, prerequisites, diagnosis }: { plan: AxPlan; target: AxToolId; taskName: string; taskContext: string; prerequisites: string[]; diagnosis: AxDiagnosis }) {
  const name = TOOL_GUIDES[target].name;
  const context = [taskName, taskContext].join("\n");
  const prompt = buildAllInOnePrompt(plan, target, { taskName, prerequisites, diagnosis, context: taskContext });
  return <div className="ax-package">
    <div className="ax-tool-plan"><h4>{name} 구현 상세</h4><AxPlanOverview view={planView(plan, { diagnosis, prerequisites, context })} summary={false} /></div>
    <h4 className="ax-package-title">{name}용 올인원 지시문</h4>
    <pre className="ax-prompt">{prompt}</pre>
    <div className="ax-prompt-actions"><AxCopyButton key={prompt} text={prompt} label={`${name}용 지시문 복사`} /></div>
  </div>;
}

export function AxPlanSection({ diagnosis, taskName, taskContext, busy, onGenerate }: { diagnosis: AxDiagnosis; taskName: string; taskContext: string; busy: string | null; onGenerate: (target: AxToolId) => void }) {
  const gate = executionGate(diagnosis);
  const blockReasons = gate === "blocked" ? gateBlockReasons(diagnosis) : [];
  const prerequisites = gate === "blocked" ? [] : gatePrerequisites(diagnosis);
  const plans = { codex: diagnosis.planCodex, claude: diagnosis.planClaude };
  const [selectedTool, setSelectedTool] = useState<AxToolId | null>(null);
  const activeTool = selectedTool ?? (plans.codex ? "codex" : "claude");
  const generateButton = (target: AxToolId) => <Button key={target} type="button" variant="outline" className="ax-plan-generate" disabled={!!busy || gate === "blocked"} onClick={() => onGenerate(target)}><FileCode2 aria-hidden="true" />{busy === target ? target === "codex" ? "Codex 계획 생성 중…" : "Claude 계획 생성 중…" : `${TOOL_GUIDES[target].name}용 구현 계획 생성`}</Button>;
  return <section className="ax-surface" aria-label="자동화 구현 계획">
    <div className="ax-plan-head">
      <h3>자동화 구현 계획</h3>
      {gate !== "blocked" && (plans.codex || plans.claude) ? <span className="ax-plan-tool-hint">{TOOL_GUIDES[activeTool].name}에서 현재 프로젝트를 열고 아래 지시문을 붙여넣으세요.</span> : null}
    </div>
    {gate === "blocked" ? <>
      <p role="status" className="ax-notice">현재 진단에서는 구현 계획을 생성할 수 없습니다.</p>
      {blockReasons.length ? <AxList items={blockReasons} /> : null}
      <div className="ax-actions">{generateButton("codex")}{generateButton("claude")}</div>
    </> : <>
      <div className="ax-common-plan"><h4>공통 실행 방향</h4><AxPlanOverview view={commonPlanView(diagnosis)} /></div>
      {!plans.codex && !plans.claude ? <div className="ax-actions">{generateButton("codex")}{generateButton("claude")}</div> :
        <Tabs className="ax-tool-tabs" value={activeTool} onValueChange={value => { if (value === "codex" || value === "claude") setSelectedTool(value); }}>
          <div className="ax-plan-toolbar">
            <TabsList aria-label="AI 코딩 도구 선택"><TabsTab value="codex">Codex</TabsTab><TabsTab value="claude">Claude Code</TabsTab></TabsList>
            <Accordion className="ax-guide">
              <AccordionItem value="setup" className="ax-guide-item"><AccordionTrigger className="ax-guide-trigger"><span className="inline-flex items-center gap-2"><Terminal aria-hidden="true" className="size-4" />설치·시작 가이드</span></AccordionTrigger><AccordionPanel className="ax-guide-panel">
                <AxSetupGuide tool={activeTool} />
              </AccordionPanel></AccordionItem>
            </Accordion>
          </div>
          {(["codex", "claude"] as const).map(target => <TabsPanel key={target} value={target}>{plans[target] ? <AxExecutionPackage plan={plans[target]} target={target} taskName={taskName} taskContext={taskContext} prerequisites={prerequisites} diagnosis={diagnosis} /> : <><p>{TOOL_GUIDES[target].name}용 구현 계획을 생성하면 올인원 지시문을 확인할 수 있습니다.</p>{generateButton(target)}</>}</TabsPanel>)}
        </Tabs>}
    </>}
  </section>;
}
