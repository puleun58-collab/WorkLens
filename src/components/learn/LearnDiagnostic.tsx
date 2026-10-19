"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DIAGNOSTIC_AREAS, type DiagnosticAreaId } from "@/lib/learn/curriculum";
import type { LearnQuestion, LearnerAnswer } from "@/lib/learn/types";

interface LearnDiagnosticProps {
  questions: LearnQuestion[];
  onComplete: (weakAreaIds: string[]) => void;
  onSkip: () => void;
}

/**
 * 사전 진단 — 학습 방향 추천용. 점수로 단계를 건너뛰거나 해제하지 않는다.
 */
export function LearnDiagnostic({ questions, onComplete, onSkip }: LearnDiagnosticProps) {
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, LearnerAnswer>>({});
  const [done, setDone] = useState(false);
  const [weakAreas, setWeakAreas] = useState<string[]>([]);
  const q = questions[idx];

  const areaOf = (question: LearnQuestion): DiagnosticAreaId => {
    const map: Record<string, DiagnosticAreaId> = {
      "AI·AX 개념 이해": "concept",
      "업무 자동화 판단": "automation",
      "CLI·Git 기본 지식": "cli-git",
      "개발·배포 개념": "dev-deploy",
    };
    return map[question.category] ?? "concept";
  };

  const finish = () => {
    const byArea = new Map<DiagnosticAreaId, { correct: number; total: number }>();
    for (const item of questions) {
      const area = areaOf(item);
      const entry = byArea.get(area) ?? { correct: 0, total: 0 };
      entry.total += 1;
      const a = answers[item.id];
      const correct =
        a?.kind === "choices" &&
        a.selectedChoiceIds.length === (item.correctChoiceIds?.length ?? 0) &&
        (item.correctChoiceIds ?? []).every((id) => a.selectedChoiceIds.includes(id));
      if (correct) entry.correct += 1;
      byArea.set(area, entry);
    }
    const weak = [...byArea.entries()].filter(([, v]) => v.correct < v.total).map(([k]) => k);
    setWeakAreas(weak);
    setDone(true);
  };

  if (!q && !done) return null;

  if (done) {
    return (
      <div>
        <h2>사전 진단 결과</h2>
        <div className="learn-surface">
          {weakAreas.length === 0 ? (
            <p>모든 영역에서 잘 이해하고 계시네요. LEVEL 1부터 차근차근 시작해 보세요.</p>
          ) : (
            <>
              <p>다음 영역을 중점적으로 학습하는 것을 추천합니다.</p>
              <ul>
                {weakAreas.map((id) => (
                  <li key={id}>{DIAGNOSTIC_AREAS.find((a) => a.id === id)?.label}</li>
                ))}
              </ul>
            </>
          )}
          <p className="learn-muted">
            <small>사전 진단은 학습 방향 안내용이며, 단계 해제에는 영향을 주지 않습니다.</small>
          </p>
          <div className="learn-actions">
            <Button type="button" variant="default" onClick={() => onComplete(weakAreas)}>
              학습 시작하기
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2>사전 진단 (선택)</h2>
      <p className="learn-muted">
        현재 수준을 파악해 학습 방향을 추천합니다. 건너뛰어도 LEVEL 1부터 정상 학습할 수 있습니다.
      </p>
      <div className="learn-surface">
        <p>
          <small className="learn-muted">
            {idx + 1} / {questions.length} · {q.category}
          </small>
        </p>
        <h3>{q.prompt}</h3>
        {q.choices?.map((c) => {
          const cur = answers[q.id];
          const selected = cur?.kind === "choices" && cur.selectedChoiceIds.includes(c.id);
          return (
            <button
              key={c.id}
              type="button"
              className={`learn-choice${selected ? " is-selected" : ""}`}
              onClick={() => setAnswers((a) => ({ ...a, [q.id]: { kind: "choices", selectedChoiceIds: [c.id] } }))}
              aria-pressed={selected}
            >
              <span className="learn-choice-id">{c.id.toUpperCase()}</span>
              <span>{c.text}</span>
            </button>
          );
        })}
      </div>
      <div className="learn-quiz-nav">
        <Button type="button" variant="outline" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>
          이전
        </Button>
        <Button type="button" variant="ghost" onClick={onSkip}>
          건너뛰기
        </Button>
        {idx < questions.length - 1 ? (
          <Button type="button" variant="default" onClick={() => setIdx(idx + 1)}>
            다음
          </Button>
        ) : (
          <Button type="button" variant="default" onClick={finish}>
            결과 보기
          </Button>
        )}
      </div>
    </div>
  );
}
