"use client";

import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { axes, factorEffectiveValue, factorHasAdjustment } from "@/lib/ax/policy";
import { FACTOR_LABELS } from "@/lib/ax/schema";
import type { AxDiagnosis, FactorKey } from "@/lib/ax/types";

const AXIS_GROUPS = [
  { key: "value", label: "자동화 가치 · Y축", factors: ["repetition", "regularity", "dataStructure"], average: true },
  { key: "feasibility", label: "기술 실현 가능성 · X축", factors: ["regularity", "dataStructure", "systemAccess"], average: true },
  { key: "judgment", label: "담당자 판단 필요도", factors: ["humanJudgment"], average: false },
  { key: "risk", label: "운영 위험", factors: ["operationalRisk"], average: false },
] as const satisfies readonly { key: "value" | "feasibility" | "judgment" | "risk"; label: string; factors: readonly FactorKey[]; average: boolean }[];

export function AxScoreEvidence({ diagnosis }: { diagnosis: AxDiagnosis }) {
  const scores = axes(diagnosis);
  return <Accordion className="ax-score-evidence">
    <AccordionItem value="score-evidence">
      <AccordionTrigger>점수 근거 확인</AccordionTrigger>
      <AccordionPanel>
        <section className="ax-score-content" aria-label="점수 근거">
          <h3>산정 기준</h3>
          <p className="ax-muted">최종 적용값으로 계산합니다. AI 평가 근거는 원래 제안값에 대한 설명이며, 사용자 보정값의 근거는 아닙니다.</p>
          <div className="ax-score-groups">
            {AXIS_GROUPS.map(group => {
              const factors = group.factors.map(key => diagnosis.factors.find(factor => factor.key === key)!);
              return <section className="ax-score-group" key={group.key}>
                <div className="ax-score-heading"><h4>{group.label}</h4><Badge variant="secondary" className="ax-score-badge">{scores[group.key]}점</Badge></div>
                <p className="ax-score-formula">{group.average
                  ? `(${factors.map(factor => `${FACTOR_LABELS[factor.key]} ${factorEffectiveValue(factor)}`).join(" + ")}) ÷ 3 → 반올림 ${scores[group.key]}점`
                  : `${FACTOR_LABELS[factors[0].key]} 최종 적용값 ${scores[group.key]}점`}</p>
                <dl className="ax-score-factors">
                  {factors.map(factor => <div className="ax-score-factor" key={factor.key}>
                    <dt>{FACTOR_LABELS[factor.key]}</dt>
                    <dd><div className="ax-score-values"><span>최종 적용 <strong className="ax-score-applied">{factorEffectiveValue(factor)}점</strong></span>{factorHasAdjustment(factor) ? <span>AI 제안 {factor.aiValue}점 · 사용자 보정</span> : null}</div><p><span className="ax-muted">AI 평가 근거 · </span>{factor.rationale.trim() || "확인 필요"}</p></dd>
                  </div>)}
                </dl>
              </section>;
            })}
          </div>
        </section>
      </AccordionPanel>
    </AccordionItem>
  </Accordion>;
}
