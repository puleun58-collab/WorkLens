import type { AxDiagnosis, AxPlan, AxTask } from "@/lib/ax/types";
import { automationLevel, axes, nextAction } from "@/lib/ax/policy";
import { PLAN_LABELS } from "@/lib/ax/schema";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/ui/accordion";
export function AxList({ items }: { items: string[] }) {
  return items.length ? <ul>{items.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p className="ax-muted">기재된 내용 없음</p>;
}
export function AxSummary({ task }: { task: AxTask }) {
  if (!task.diagnosis) return null;
  const a = axes(task.diagnosis), l = automationLevel(task.diagnosis), action = nextAction(task.diagnosis);
  return <div className="ax-summary">
    <Badge variant="outline">{l.label}{l.provisional ? " · 잠정" : ""}</Badge>
    <p>자동화 가치 {a.value} · 기술 실현 가능성 {a.feasibility} · 사람 판단 {a.judgment} · 운영 위험 {a.risk}</p>
    <p><strong>{action.label}</strong> — {action.detail}</p>
  </div>;
}
export function AxProcess({ diagnosis: d }: { diagnosis: AxDiagnosis }) {
  return <>
    <section className="ax-section"><h3>AS-IS · 현재 업무</h3>
      <dl className="ax-definition"><dt>목적</dt><dd>{d.asIs.purpose}</dd><dt>시작 조건</dt><dd>{d.asIs.trigger}</dd><dt>입력</dt><dd><AxList items={d.asIs.inputs} /></dd><dt>업무 단계</dt><dd><AxList items={d.asIs.steps} /></dd><dt>출력</dt><dd><AxList items={d.asIs.outputs} /></dd><dt>예외</dt><dd><AxList items={d.asIs.exceptions} /></dd><dt>사람 판단</dt><dd><AxList items={d.asIs.humanDecisions} /></dd><dt>시스템</dt><dd><AxList items={d.asIs.systems} /></dd></dl>
    </section>
    <section className="ax-section"><h3>단계별 판정</h3><div className="ax-table-wrap"><table><thead><tr><th>단계</th><th>판정</th><th>담당</th><th>근거</th></tr></thead><tbody>{d.stepAssessments.map((s, i) => <tr key={i}><td>{s.step}</td><td>{s.verdict}</td><td>{s.owner}</td><td>{s.note}</td></tr>)}</tbody></table></div></section>
    <AxToBe diagnosis={d} />
  </>;
}
function AxToBe({ diagnosis: d }: { diagnosis: AxDiagnosis }) {
  return <section className="ax-section"><h3>TO-BE · 역할과 흐름</h3><ol>{d.toBe.map((s, i) => <li key={i}><strong>{s.step} · {s.owner}</strong><p>{s.description}</p></li>)}</ol></section>;
}
export function AxRoadmap({ diagnosis: d }: { diagnosis: AxDiagnosis }) {
  return <>
    <AxToBe diagnosis={d} />
    <section className="ax-section"><h3>자동화 범위</h3><div className="ax-columns">{(["자동화", "AI 보조", "사람 유지"] as const).map(v => <div key={v}><h4>{v}</h4><AxList items={d.stepAssessments.filter(s => s.verdict === v).map(s => `${s.step} — ${s.note}`)} /></div>)}</div><h4>사람 승인·검토 지점</h4><AxList items={d.humanInLoop} /></section>
    <section className="ax-section"><h3>확인 필요 사항</h3><ul>{d.technicalChecks.map((c, i) => <li key={i}><strong>{c.topic} · {c.status}</strong> — {c.note}</li>)}</ul><h4>위험</h4><AxList items={d.risks} /></section>
    <section className="ax-section"><h3>PoC · 검증 실험</h3><p>{d.poc.hypothesis}</p><dl className="ax-definition">{([['inScope', '포함'], ['outOfScope', '제외'], ['inputs', '입력'], ['outputs', '출력'], ['evaluation', '평가 방법'], ['success', '성공 기준'], ['failure', '실패 기준']] as const).map(([key, label]) => <div className="ax-definition-row" key={key}><dt>{label}</dt><dd><AxList items={d.poc[key]} /></dd></div>)}</dl></section>
    <section className="ax-section"><h3>Decision Gate · {d.decisionGate.verdict}</h3><AxList items={d.decisionGate.reasons} /><p className="ax-muted">AI 제안입니다. 실행 여부는 담당자가 확인합니다.</p></section>
    <section className="ax-section"><h3>로드맵</h3><ol>{d.roadmap.map((r, i) => <li key={i}><h4>{r.phase} · {r.title}</h4><AxList items={r.items} /></li>)}</ol></section>
    <section className="ax-section"><h3>운영·Fallback</h3><dl className="ax-definition"><dt>운영 책임</dt><dd>{d.operation.owner}</dd><dt>장애 대응 책임</dt><dd>{d.operation.failureOwner}</dd><dt>유지보수 부담</dt><dd>{{ low: "낮음", medium: "보통", high: "높음" }[d.operation.maintenanceBurden]}</dd><dt>수동 복귀</dt><dd>{d.operation.fallback}</dd></dl><AxList items={d.operation.notes} /></section>
  </>;
}
export function AxPlanReport({ plan, title }: { plan: AxPlan; title: string }) {
  return <section className="ax-section" aria-label={title}><h3>{title}</h3><p>{plan.repositoryFirst}</p><Accordion multiple>{Object.entries(PLAN_LABELS).map(([key, label]) => <AccordionItem key={key} value={key}><AccordionTrigger>{label}</AccordionTrigger><AccordionPanel><AxList items={plan[key as keyof typeof PLAN_LABELS]} /></AccordionPanel></AccordionItem>)}</Accordion></section>;
}
