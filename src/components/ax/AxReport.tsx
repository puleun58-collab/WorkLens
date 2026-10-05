"use client";

import { useEffect, useRef, useState } from "react";
import type { AxDiagnosis, AxPlan, AxTask } from "@/lib/ax/types";
import { automationLevel, axes, executionGate, GATE_LABELS, gateBlockReasons, gatePrerequisites, nextAction } from "@/lib/ax/policy";
import { FACTOR_KEYS, FACTOR_LABELS, PLAN_LABELS } from "@/lib/ax/schema";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import { buildAllInOnePrompt, environmentGuide, installGuide, projectPrepGuide, runGuide, postImplementationGuide, githubGuide, resolveDeploymentGuide, TOOL_GUIDES, type AxToolId } from "@/lib/ax/guide";

const VERDICT_LABELS = { 자동화: "자동화", "AI 보조": "AI 보조", "사람 유지": "담당자 수행" } as const;

export function AxList({ items }: { items: string[] }) {
  return items.length ? <ul>{items.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p className="ax-muted">기재된 내용 없음</p>;
}
export function AxSummary({ task }: { task: AxTask }) {
  if (!task.diagnosis) return null;
  const a = axes(task.diagnosis), l = automationLevel(task.diagnosis), action = nextAction(task.diagnosis), gate = executionGate(task.diagnosis);
  return <div className="ax-summary">
    <Badge variant="outline" className="ax-level-badge">{l.label.replace(/^L\d+ /, "")} · Level {l.level}{l.provisional ? " · 잠정" : ""}</Badge>
    <p className="ax-gate-line"><span>실행 가능성</span><span className="ax-gate-badge" data-gate={gate}>{GATE_LABELS[gate]}</span>{gate === "conditional" ? <span className="ax-muted">선행 확인 필요</span> : null}</p>
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
    <section className="ax-section ax-panel"><h3>실행 판단 · {GATE_LABELS[executionGate(d)]}</h3><AxList items={d.decisionGate.reasons} /><p className="ax-muted">진단 결과를 참고해 최종 실행 여부를 담당자가 확인합니다.</p></section>
    {roadmapSection ? <section className="ax-section ax-panel"><h3>실행 로드맵</h3><ol>{d.roadmap.map((r, i) => <li key={i}><h4>{r.phase} · {r.title}</h4><AxList items={r.items} /></li>)}</ol></section> : null}
    <section className="ax-section ax-panel"><h3>운영·복구 계획</h3><dl className="ax-definition"><dt>운영 담당</dt><dd>{d.operation.owner}</dd><dt>장애 대응 담당</dt><dd>{d.operation.failureOwner}</dd><dt>유지보수 난이도</dt><dd>{{ low: "낮음", medium: "보통", high: "높음" }[d.operation.maintenanceBurden]}</dd></dl><div className="ax-fallback-block"><h4>수동 처리 전환</h4><p>{d.operation.fallback}</p></div>{d.operation.notes.length ? <><h4>운영 시 참고사항</h4><AxList items={d.operation.notes} /></> : null}</section>
  </>;
}
export function AxPlanDetails({ plan }: { plan: AxPlan }) {
  return <Accordion multiple>{Object.entries(PLAN_LABELS).map(([key, label]) => <AccordionItem key={key} value={key}><AccordionTrigger>{label}</AccordionTrigger><AccordionPanel><AxList items={plan[key as keyof typeof PLAN_LABELS]} /></AccordionPanel></AccordionItem>)}</Accordion>;
}
export function AxPlanReport({ plan, title }: { plan: AxPlan; title: string }) {
  return <section className="ax-section ax-panel" aria-label={title}><h3>{title}</h3><p>{plan.repositoryFirst}</p><AxPlanDetails plan={plan} /></section>;
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const holder = document.createElement("textarea");
      holder.value = text;
      holder.setAttribute("readonly", "");
      holder.style.position = "fixed";
      holder.style.opacity = "0";
      document.body.append(holder);
      holder.select();
      try { if (!document.execCommand("copy")) return; } finally { holder.remove(); }
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1_600);
  }
  return <Button type="button" aria-label={label} onClick={() => void copy()}><span aria-live="polite">{copied ? "복사했습니다" : label}</span></Button>;
}

// Guide strings use backticks to mark commands without introducing HTML into data.
function AxGuideSteps({ steps }: { steps: string[] }) {
  return <ol>{steps.map((step, i) => <li key={i}>{step.split(/(`[^`]+`)/g).map((part, j) => part.startsWith("`") ? <code className="ax-cmd" key={j}>{part.slice(1, -1)}</code> : part)}</li>)}</ol>;
}

export function AxExecutionPackage({ plan, target, prerequisites }: { plan: AxPlan; target: AxToolId; prerequisites: string[] }) {
  const name = TOOL_GUIDES[target].name;
  const prompt = buildAllInOnePrompt(plan, target, { prerequisites });
  return <div className="ax-package">
    <p>{name}에서 현재 프로젝트를 열고 아래 지시문을 그대로 붙여넣으면 됩니다. AI가 현재 프로젝트의 구조와 설정을 먼저 확인한 뒤 작업합니다.</p>
    <Accordion className="ax-guide">
      <AccordionItem value="setup"><AccordionTrigger>처음 사용하는 경우 — 개발 환경 준비부터 실행까지</AccordionTrigger><AccordionPanel>
        <h4>STEP 0 · 개발 환경 준비</h4><AxGuideSteps steps={environmentGuide(target)} />
        <h4>{name} 설치</h4><AxGuideSteps steps={installGuide(target)} />
        <h4>프로젝트 준비</h4>{projectPrepGuide().cases.map(item => <div key={item.id}><h4>{item.title}</h4><AxGuideSteps steps={item.steps} /></div>)}
        <h4>도구 실행</h4><AxGuideSteps steps={runGuide(target)} />
      </AccordionPanel></AccordionItem>
    </Accordion>
    <h4>{name}용 올인원 지시문</h4><pre className="ax-prompt">{prompt}</pre>
    <AxCopyButton text={prompt} label={`${name}용 지시문 복사`} />
    <Accordion multiple className="ax-guide">
      <AccordionItem value="verify"><AccordionTrigger>구현 후 확인 · GitHub 반영</AccordionTrigger><AccordionPanel>
        <h4>구현 후 확인</h4><AxGuideSteps steps={postImplementationGuide()} />
        <h4>GitHub 반영</h4><AxGuideSteps steps={githubGuide()} />
      </AccordionPanel></AccordionItem>
      <AccordionItem value="deploy"><AccordionTrigger>배포 방법</AccordionTrigger><AccordionPanel>
        <p>배포 방식은 현재 프로젝트에서 확인합니다. 아래 방식 중 임의로 선택하지 마세요.</p>
        <AxGuideSteps steps={resolveDeploymentGuide({}).steps} />
        <ul>
          <li>CI: Push/merge → CI 배포 상태 → Production URL 확인</li>
          <li>Vercel: 기존 GitHub 연동 자동 배포 우선 → Production URL 확인</li>
          <li>Cloudflare: 기존 Wrangler·package script·GitHub Actions 중 실제 방식 사용, 기존 script 우선</li>
          <li>수동 배포: 저장소에 있는 배포 script와 운영 지침 사용</li>
          <li>웹 배포 없음: 실행 환경 구성 → 운영 적용 → 핵심 기능 검증</li>
        </ul>
      </AccordionPanel></AccordionItem>
      <AccordionItem value="details"><AccordionTrigger>상세 구현 계획 보기</AccordionTrigger><AccordionPanel><AxPlanDetails plan={plan} /></AccordionPanel></AccordionItem>
    </Accordion>
  </div>;
}

export function AxPlanSection({ diagnosis, busy, onGenerate }: { diagnosis: AxDiagnosis; busy: string | null; onGenerate: (target: AxToolId) => void }) {
  const gate = executionGate(diagnosis);
  const blockReasons = gate === "blocked" ? gateBlockReasons(diagnosis) : [];
  const prerequisites = gatePrerequisites(diagnosis).filter(item => !blockReasons.includes(item));
  const plans = { codex: diagnosis.planCodex, claude: diagnosis.planClaude };
  const generateButton = (target: AxToolId) => <Button key={target} type="button" variant="outline" disabled={!!busy || gate === "blocked"} onClick={() => onGenerate(target)}>{busy === target ? target === "codex" ? "Codex 계획 생성 중…" : "Claude 계획 생성 중…" : `${TOOL_GUIDES[target].name}용 구현 계획 생성`}</Button>;
  const prerequisiteList = (items: string[]) => <ul className="ax-prereq-list">{items.map((item, i) => <li key={i}>{item}</li>)}</ul>;
  return <section className="ax-surface" aria-label="자동화 구현 계획">
    <div className="ax-plan-head"><h3>자동화 구현 계획</h3><span className="ax-gate-badge" data-gate={gate}>{GATE_LABELS[gate]}</span></div>
    {gate === "blocked" ? <>
      <p role="status" className="ax-notice">선행 조건을 해결한 후 구현 계획을 생성할 수 있습니다.</p>
      <h4>구현 전 필수 조건</h4>{prerequisiteList(blockReasons)}
      {prerequisites.length ? <><h4>먼저 확인할 사항</h4>{prerequisiteList(prerequisites)}</> : null}
      <div className="ax-actions">{generateButton("codex")}{generateButton("claude")}</div>
    </> : <>
      {gate === "conditional" ? <><p className="ax-notice">먼저 확인할 사항을 검토한 뒤 구현 계획을 진행하세요.</p><h4>먼저 확인할 사항</h4>{prerequisiteList(gatePrerequisites(diagnosis))}</> : null}
      {!plans.codex && !plans.claude ? <div className="ax-actions">{generateButton("codex")}{generateButton("claude")}</div> :
        <Tabs className="ax-tool-tabs" defaultValue={plans.codex ? "codex" : "claude"}>
          <TabsList aria-label="AI 코딩 도구 선택"><TabsTab value="codex">Codex</TabsTab><TabsTab value="claude">Claude Code</TabsTab></TabsList>
          {(["codex", "claude"] as const).map(target => <TabsPanel key={target} value={target}>{plans[target] ? <AxExecutionPackage plan={plans[target]} target={target} prerequisites={prerequisites} /> : <><p>{TOOL_GUIDES[target].name}용 구현 계획을 생성하면 올인원 지시문을 확인할 수 있습니다.</p>{generateButton(target)}</>}</TabsPanel>)}
        </Tabs>}
    </>}
  </section>;
}
