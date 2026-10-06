"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Terminal } from "lucide-react";
import type { AxDiagnosis, AxPlan, AxTask } from "@/lib/ax/types";
import { automationLevel, axes, executionGate, GATE_LABELS, gateBlockReasons, gatePrerequisites, nextAction } from "@/lib/ax/policy";
import { FACTOR_KEYS, FACTOR_LABELS } from "@/lib/ax/schema";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import { buildAllInOnePrompt, environmentGuide, installGuide, projectPrepGuide, runGuide, TOOL_GUIDES, type AxToolId } from "@/lib/ax/guide";

const VERDICT_LABELS = { 자동화: "자동화", "AI 보조": "AI 보조", "사람 유지": "담당자 수행" } as const;

export function AxList({ items }: { items: string[] }) {
  return items.length ? <ul>{items.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p className="ax-muted">기재된 내용 없음</p>;
}
export function AxSummary({ task, showGate = true }: { task: AxTask; showGate?: boolean }) {
  if (!task.diagnosis) return null;
  const a = axes(task.diagnosis), l = automationLevel(task.diagnosis), action = nextAction(task.diagnosis), gate = executionGate(task.diagnosis);
  return <div className="ax-summary">
    <Badge variant="outline" className="ax-level-badge">{l.label.replace(/^L\d+ /, "")} · Level {l.level}{l.provisional ? " · 잠정" : ""}</Badge>
    {showGate ? <p className="ax-gate-line"><span>실행 가능성</span><span className="ax-gate-badge" data-gate={gate}>{GATE_LABELS[gate]}</span>{gate === "conditional" ? <span className="ax-muted">선행 확인 필요</span> : null}</p> : null}
    <p>자동화 가치 {a.value} · 기술 실현 가능성 {a.feasibility} · 담당자 판단 {a.judgment} · 운영 위험 {a.risk}</p>
    <p><strong>{action.label}</strong> — {action.detail}</p>
  </div>;
}
export function AxProcess({ diagnosis: d }: { diagnosis: AxDiagnosis }) {
  return <>
    <section className="ax-section ax-panel"><h3>AS-IS · 현재 업무</h3>
      <dl className="ax-definition"><dt>목적</dt><dd>{d.asIs.purpose}</dd><dt>시작 조건</dt><dd>{d.asIs.trigger}</dd><dt>입력</dt><dd><AxList items={d.asIs.inputs} /></dd><dt>업무 단계</dt><dd><AxList items={d.asIs.steps} /></dd><dt>출력</dt><dd><AxList items={d.asIs.outputs} /></dd><dt>예외</dt><dd><AxList items={d.asIs.exceptions} /></dd><dt>담당자 판단</dt><dd><AxList items={d.asIs.humanDecisions} /></dd><dt>시스템</dt><dd><AxList items={d.asIs.systems} /></dd></dl>
    </section>
    <section className="ax-section ax-panel"><h3>단계별 자동화 판단</h3><div className="ax-table-wrap"><table><thead><tr><th>단계</th><th>판정</th><th>담당</th><th>근거</th></tr></thead><tbody>{d.stepAssessments.map((s, i) => <tr key={i}><td>{s.step}</td><td>{VERDICT_LABELS[s.verdict]}</td><td>{s.owner}</td><td>{s.note}</td></tr>)}</tbody></table></div></section>
    <AxToBe diagnosis={d} />
  </>;
}
function AxToBe({ diagnosis: d }: { diagnosis: AxDiagnosis }) {
  return <section className="ax-section ax-panel"><h3>TO-BE · 역할과 흐름</h3><ol>{d.toBe.map((s, i) => <li key={i}><strong>{s.step} · {s.owner}</strong><p>{s.description}</p></li>)}</ol></section>;
}
export function AxRoadmap({ diagnosis: d, roadmapSection = true }: { diagnosis: AxDiagnosis; roadmapSection?: boolean }) {
  return <>
    <AxToBe diagnosis={d} />
    <section className="ax-section ax-panel"><h3>자동화 적용 범위</h3><div className="ax-columns">{(["자동화", "AI 보조", "사람 유지"] as const).map(v => <div key={v}><h4>{VERDICT_LABELS[v]}</h4><AxList items={d.stepAssessments.filter(s => s.verdict === v).map(s => `${s.step} — ${s.note}`)} /></div>)}</div><h4>승인·검토가 필요한 단계</h4><AxList items={d.humanInLoop} /></section>
    <section className="ax-section ax-panel"><h3>진행 전 확인사항</h3><ul>{d.technicalChecks.map((c, i) => <li key={i}><strong>{c.topic} · {c.status}</strong> — {c.note}</li>)}</ul><h4>주의사항·위험요소</h4><AxList items={d.risks} /></section>
    <section className="ax-section ax-panel"><h3>사전 검증(PoC)</h3><p>{d.poc.hypothesis}</p><dl className="ax-definition">{([['inScope', '포함'], ['outOfScope', '제외'], ['inputs', '입력'], ['outputs', '출력'], ['evaluation', '평가 방법'], ['success', '성공 기준'], ['failure', '실패 기준']] as const).map(([key, label]) => <div className="ax-definition-row" key={key}><dt>{label}</dt><dd><AxList items={d.poc[key]} /></dd></div>)}</dl></section>
    {roadmapSection ? <section className="ax-section ax-panel"><h3>실행 로드맵</h3><ol>{d.roadmap.map((r, i) => <li key={i}><h4>{r.phase} · {r.title}</h4><AxList items={r.items} /></li>)}</ol></section> : null}
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
    <polygon points={polygon(factors.map(f => (f.finalValue ?? f.aiValue) / 5 * 62))} fill="color-mix(in srgb, var(--primary) 16%, transparent)" stroke="var(--primary)" strokeWidth={1.5} />
    {FACTOR_KEYS.map((key, i) => { const p = point(i, 76); return <text key={key} x={p.x} y={p.y} dominantBaseline="middle" textAnchor={Math.abs(p.x - 110) < 1 ? "middle" : p.x > 110 ? "start" : "end"} fontSize={9.5} fill="var(--muted-foreground)">{FACTOR_LABELS[key].split(" ").map((word, j, words) => <tspan key={j} x={p.x} dy={j === 0 ? -(words.length - 1) * 5.5 : 11}>{word}{j < words.length - 1 ? " " : ""}</tspan>)}</text>; })}
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
function AxGuideSteps({ steps }: { steps: string[] }) {
  return <ol>{steps.map((step, i) => <li key={i}>{step.split(/(`[^`]+`)/g).map((part, j) => part.startsWith("`") ? <code className="ax-cmd" key={j}>{part.slice(1, -1)}</code> : part)}</li>)}</ol>;
}

export function AxExecutionPackage({ plan, target, taskName, prerequisites }: { plan: AxPlan; target: AxToolId; taskName: string; prerequisites: string[] }) {
  const name = TOOL_GUIDES[target].name;
  const prompt = buildAllInOnePrompt(plan, target, { taskName, prerequisites });
  return <div className="ax-package">
    <h4>{name}용 올인원 지시문</h4>
    <pre className="ax-prompt">{prompt}</pre>
    <div className="ax-prompt-actions"><AxCopyButton key={prompt} text={prompt} label={`${name}용 지시문 복사`} /></div>
  </div>;
}

export function AxPlanSection({ diagnosis, taskName, busy, onGenerate }: { diagnosis: AxDiagnosis; taskName: string; busy: string | null; onGenerate: (target: AxToolId) => void }) {
  const gate = executionGate(diagnosis);
  const blockReasons = gate === "blocked" ? gateBlockReasons(diagnosis) : [];
  const prerequisites = gate === "blocked" ? [] : gatePrerequisites(diagnosis);
  const plans = { codex: diagnosis.planCodex, claude: diagnosis.planClaude };
  const [selectedTool, setSelectedTool] = useState<AxToolId | null>(null);
  const activeTool = selectedTool ?? (plans.codex ? "codex" : "claude");
  const generateButton = (target: AxToolId) => <Button key={target} type="button" variant="outline" disabled={!!busy || gate === "blocked"} onClick={() => onGenerate(target)}>{busy === target ? target === "codex" ? "Codex 계획 생성 중…" : "Claude 계획 생성 중…" : `${TOOL_GUIDES[target].name}용 구현 계획 생성`}</Button>;
  return <section className="ax-surface" aria-label="자동화 구현 계획">
    <div className="ax-plan-head">
      <h3>자동화 구현 계획</h3>
      {gate !== "blocked" && (plans.codex || plans.claude) ? <span className="ax-plan-tool-hint">{TOOL_GUIDES[activeTool].name}에서 현재 프로젝트를 열고 아래 지시문을 붙여넣으세요.</span> : null}
    </div>
    {gate === "blocked" ? <>
      <p role="status" className="ax-notice">현재 진단에서는 구현 계획을 생성할 수 없습니다.</p>
      {blockReasons.length ? <p className="ax-muted">{blockReasons[0]}</p> : null}
      <div className="ax-actions">{generateButton("codex")}{generateButton("claude")}</div>
    </> : <>
      {!plans.codex && !plans.claude ? <div className="ax-actions">{generateButton("codex")}{generateButton("claude")}</div> :
        <Tabs className="ax-tool-tabs" value={activeTool} onValueChange={value => { if (value === "codex" || value === "claude") setSelectedTool(value); }}>
          <div className="ax-plan-toolbar">
            <TabsList aria-label="AI 코딩 도구 선택"><TabsTab value="codex">Codex</TabsTab><TabsTab value="claude">Claude Code</TabsTab></TabsList>
            <Accordion className="ax-guide">
              <AccordionItem value="setup" className="ax-guide-item"><AccordionTrigger className="ax-guide-trigger"><span className="inline-flex items-center gap-2"><Terminal aria-hidden="true" className="size-4" />설치·시작 가이드</span></AccordionTrigger><AccordionPanel className="ax-guide-panel">
                <h4>STEP 0 · 개발 환경 준비</h4><AxGuideSteps steps={environmentGuide(activeTool)} />
                <h4>{TOOL_GUIDES[activeTool].name} 설치</h4><AxGuideSteps steps={installGuide(activeTool)} />
                <h4>프로젝트 준비</h4>{projectPrepGuide().cases.map(item => <div key={item.id}><h4>{item.title}</h4><AxGuideSteps steps={item.steps} /></div>)}
                <h4>도구 실행</h4><AxGuideSteps steps={runGuide(activeTool)} />
              </AccordionPanel></AccordionItem>
            </Accordion>
          </div>
          {(["codex", "claude"] as const).map(target => <TabsPanel key={target} value={target}>{plans[target] ? <AxExecutionPackage plan={plans[target]} target={target} taskName={taskName} prerequisites={prerequisites} /> : <><p>{TOOL_GUIDES[target].name}용 구현 계획을 생성하면 올인원 지시문을 확인할 수 있습니다.</p>{generateButton(target)}</>}</TabsPanel>)}
        </Tabs>}
    </>}
  </section>;
}
