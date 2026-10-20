"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { levelMeta } from "@/lib/learn/curriculum";
import type { LearnLevelNo, LearnQuestion, LearnerAnswer } from "@/lib/learn/types";
import { VirtualTerminal } from "./VirtualTerminal";

interface LearnQuizProps {
  level: LearnLevelNo;
  attemptId: string;
  questions: LearnQuestion[];
  onSubmit: (answers: Record<string, LearnerAnswer>) => void;
  onCancel: () => void;
}

export function LearnQuiz({ level, questions, onSubmit, onCancel }: LearnQuizProps) {
  const meta = levelMeta(level);
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, LearnerAnswer>>({});
  const [confirming, setConfirming] = useState(false);
  const q = questions[idx];

  const unanswered = useMemo(
    () => questions.filter((item) => !answers[item.id]).map((item) => item.id),
    [questions, answers],
  );

  const setAnswer = (answer: LearnerAnswer) => {
    if (!q) return;
    setAnswers((a) => ({ ...a, [q.id]: answer }));
  };

  const toggleChoice = (choiceId: string, multi: boolean) => {
    if (!q) return;
    const cur = answers[q.id];
    const selected = cur?.kind === "choices" ? cur.selectedChoiceIds : [];
    const next = multi
      ? selected.includes(choiceId)
        ? selected.filter((id) => id !== choiceId)
        : [...selected, choiceId]
      : [choiceId];
    setAnswer({ kind: "choices", selectedChoiceIds: next });
  };

  if (!q) return null;

  return (
    <div>
      <div className="learn-assess-head">
        <h2>LEVEL {level} 퀴즈</h2>
        <span className="learn-muted">
          <small>
            {meta.questionCount}문항 · {meta.passScore}점 이상 통과 · 답변 {questions.length - unanswered.length}/{questions.length}
          </small>
        </span>
      </div>
      <div className="learn-quiz-progress">
        <span className="learn-assess-progress-text">
          {idx + 1} / {questions.length} 문항
        </span>
        <div className="learn-progress-bar learn-assess-bar" style={{ flex: 1 }} role="progressbar" aria-valuenow={idx + 1} aria-valuemin={1} aria-valuemax={questions.length} aria-label="퀴즈 진행률">
          <div style={{ width: `${((idx + 1) / questions.length) * 100}%` }} />
        </div>
      </div>

      <div className="learn-question-dots" role="navigation" aria-label="문항 이동">
        {questions.map((item, i) => (
          <button
            key={item.id}
            type="button"
            className={`learn-qdot${answers[item.id] ? " is-answered" : ""}${i === idx ? " is-current" : ""}`}
            onClick={() => setIdx(i)}
            aria-label={`${i + 1}번 문항${answers[item.id] ? " (답변 완료)" : ""}`}
          >
            {i + 1}
          </button>
        ))}
      </div>

      <div className="learn-question-card">
        <p className="learn-question-meta">
          {idx + 1} / {questions.length} · {q.category} ·{" "}
          {q.difficulty === "concept" ? "개념 이해" : q.difficulty === "application" ? "응용" : "상황 판단"}
        </p>
        <h3 className="learn-question-prompt">{q.prompt}</h3>

        {(q.type === "single" || q.type === "multiple" || q.type === "command-result" || q.type === "error-cause" || q.type === "case-judgment") && q.choices ? (
          <div role="group" aria-label={q.type === "multiple" ? "복수 선택" : "단일 선택"}>
            {q.type === "multiple" ? <p className="learn-muted"><small>정답을 모두 고르세요.</small></p> : null}
            {q.choices.map((c, choiceIdx) => {
              const cur = answers[q.id];
              const selected = cur?.kind === "choices" && cur.selectedChoiceIds.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`learn-choice${selected ? " is-selected" : ""}`}
                  onClick={() => toggleChoice(c.id, q.type === "multiple")}
                  aria-pressed={selected}
                >
                  {/* 표시는 위치 기준 문자(A·B·C·D) — 선택지 순서가 섞여도 채점은 선택지 ID로 판정한다 */}
                  <span className="learn-choice-id">{String.fromCharCode(65 + choiceIdx)}</span>
                  <span>{c.text}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        {q.type === "ox" ? (
          <div className="learn-ox-row" role="group" aria-label="O X 선택">
            {([true, false] as const).map((v) => {
              const cur = answers[q.id];
              const selected = cur?.kind === "ox" && cur.answer === v;
              return (
                <button
                  key={String(v)}
                  type="button"
                  className={`learn-ox${selected ? " is-selected" : ""}`}
                  onClick={() => setAnswer({ kind: "ox", answer: v })}
                  aria-pressed={selected}
                >
                  {v ? "O" : "X"}
                </button>
              );
            })}
          </div>
        ) : null}

        {q.type === "terminal-task" && q.terminalTask ? (
          <>
            <p className="learn-muted">
              <small><strong>공식 평가</strong> — 이 실습 과제의 결과는 점수에 반영됩니다.</small>
            </p>
            <VirtualTerminal
              scenario={q.terminalTask.scenario}
              instructions={q.terminalTask.instructions}
              successChecks={q.terminalTask.successChecks}
              hint={q.terminalTask.hint}
              onResult={(passed) => setAnswer({ kind: "terminal", passed })}
            />
          </>
        ) : null}
      </div>

      <div className="learn-quiz-nav">
        <Button type="button" variant="outline" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>
          <ArrowLeft /> 이전
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          그만두기
        </Button>
        {idx < questions.length - 1 ? (
          <Button type="button" variant="default" onClick={() => setIdx(idx + 1)}>
            다음 <ArrowRight />
          </Button>
        ) : (
          <Button type="button" variant="default" onClick={() => setConfirming(true)}>
            제출하기
          </Button>
        )}
      </div>

      {confirming ? (
        <div className="learn-question-card" role="alertdialog" aria-label="제출 확인" style={{ marginTop: 16 }}>
          {unanswered.length > 0 ? (
            <p>
              아직 답변하지 않은 문항이 <strong>{unanswered.length}개</strong> 있습니다. 미응답 문항은 오답 처리됩니다.
            </p>
          ) : (
            <p>모든 문항에 답변했습니다. 제출하시겠습니까?</p>
          )}
          <div className="learn-actions">
            <Button type="button" variant="default" onClick={() => onSubmit(answers)}>
              제출하고 채점하기
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
              계속 풀기
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
