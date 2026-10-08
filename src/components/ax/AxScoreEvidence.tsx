"use client";

import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/ui/accordion";
import { FACTOR_KEYS, FACTOR_LABELS } from "@/lib/ax/schema";
import { axes, factorEffectiveValue, factorHasAdjustment } from "@/lib/ax/policy";
import type { AxDiagnosis, FactorKey } from "@/lib/ax/types";

const MATRIX_AXES = [
  { key: "value", axis: "Y축", label: "자동화 가치", factors: ["repetition", "regularity", "dataStructure"] },
  { key: "feasibility", axis: "X축", label: "기술 실현 가능성", factors: ["regularity", "dataStructure", "systemAccess"] },
] as const satisfies readonly { key: "value" | "feasibility"; axis: string; label: string; factors: readonly FactorKey[] }[];

const EXTRA_FACTORS = [
  { key: "humanJudgment", score: "judgment" },
  { key: "operationalRisk", score: "risk" },
] as const;

export function AxScoreEvidence({ diagnosis }: { diagnosis: AxDiagnosis }) {
  const scores = axes(diagnosis);
  const factorByKey = Object.fromEntries(diagnosis.factors.map(factor => [factor.key, factor])) as Record<FactorKey, AxDiagnosis["factors"][number]>;
  return <Accordion className="ax-score-evidence">
    <AccordionItem value="score-evidence">
      <AccordionTrigger>점수 근거 확인</AccordionTrigger>
      <AccordionPanel>
        <section className="ax-score-content" aria-label="점수 근거">
          <h3>매트릭스 위치를 결정하는 점수</h3>
          <div className="ax-score-groups">
            {MATRIX_AXES.map(group => {
              const inputs = group.factors.map(key => factorByKey[key]);
              return <section className="ax-score-group" key={group.key}>
                <div className="ax-score-heading">
                  <div><span className="ax-score-axis">{group.axis}</span><h4>{group.label}</h4></div>
                  <div className="ax-score-result"><strong>{scores[group.key]}</strong><span>/ 5점</span></div>
                </div>
                <p className="ax-score-formula">({inputs.map(factor => `${FACTOR_LABELS[factor.key]} ${factorEffectiveValue(factor)}`).join(" + ")}) ÷ 3 → 반올림 {scores[group.key]}점</p>
              </section>;
            })}
          </div>
          <section className="ax-score-extra" aria-label="추가 판단 요소">
            <h3>추가 판단 요소</h3>
            <div className="ax-score-extra-list">
              {EXTRA_FACTORS.map(({ key, score }) => <div key={key}><span>{FACTOR_LABELS[key]}</span><strong>{scores[score]}점</strong></div>)}
            </div>
          </section>
          <Accordion className="ax-score-details">
            <AccordionItem value="factor-evidence">
              <AccordionTrigger className="ax-score-details-trigger">
                <span className="ax-score-details-closed">평가 근거 자세히 보기</span>
                <span className="ax-score-details-open">평가 근거 접기</span>
              </AccordionTrigger>
              <AccordionPanel className="ax-score-details-panel">
            <p className="ax-muted">최종 적용값으로 계산합니다. AI 평가 근거는 원래 제안값에 대한 설명이며, 사용자 보정값의 근거는 아닙니다.</p>
            <dl className="ax-score-factors">
              {FACTOR_KEYS.map(key => {
                const factor = factorByKey[key];
                return <div className="ax-score-factor" key={key}>
                  <dt>{FACTOR_LABELS[key]}</dt>
                  <dd><div className="ax-score-values"><span>최종 적용 <strong className="ax-score-applied">{factorEffectiveValue(factor)}점</strong></span>{factorHasAdjustment(factor) ? <span>AI 제안 {factor.aiValue}점 · 사용자 보정</span> : null}</div><p><span className="ax-muted">AI 평가 근거 · </span>{factor.rationale.trim() || "확인 필요"}</p></dd>
                </div>;
              })}
            </dl>
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
        </section>
      </AccordionPanel>
    </AccordionItem>
  </Accordion>;
}
