"use client";

import { useEffect, useMemo, useState } from "react";
import { publishLearnScreen } from "@/client/learn-screen";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { levelMeta } from "@/lib/learn/curriculum";
import { checkTerminalSuccess, deserializeTerminalState } from "@/lib/learn/terminal";
import type { LearnLevelNo, LearnQuestion, LearnerAnswer, TerminalStateSnapshot } from "@/lib/learn/types";
import { VirtualTerminal } from "./VirtualTerminal";

interface LearnQuizProps {
  level: LearnLevelNo;
  attemptId: string;
  questions: LearnQuestion[];
  /** 복원된 응시의 기존 답변·문항 위치 (새 응시는 빈 값) */
  initialAnswers?: Record<string, LearnerAnswer>;
  initialIndex?: number;
  /** 복원된 응시의 문항별 가상 터미널 실습 중간 상태 */
  initialTerminalStates?: Record<string, TerminalStateSnapshot>;
  /** 답변·문항 위치·터미널 상태가 바뀔 때 진행 중 응시 저장용으로 보고한다 */
  onProgressChange?: (
    answers: Record<string, LearnerAnswer>,
    currentIndex: number,
    terminalStates: Record<string, TerminalStateSnapshot>,
  ) => void;
  /** 제출 저장 확정 대기 중 여부 */
  submitting?: boolean;
  /** 제출 저장 실패 안내 — 답변이 유지된 상태에서 재시도할 수 있다 */
  submitError?: string | null;
  onRetrySubmit?: () => void;
  onSubmit: (answers: Record<string, LearnerAnswer>) => void;
  onCancel: () => void;
}

export function LearnQuiz({ level, questions, initialAnswers, initialIndex, initialTerminalStates, onProgressChange, submitting, submitError, onRetrySubmit, onSubmit, onCancel }: LearnQuizProps) {
  const meta = levelMeta(level);
  const [idx, setIdx] = useState(() => Math.min(Math.max(initialIndex ?? 0, 0), Math.max(questions.length - 1, 0)));
  const [answers, setAnswers] = useState<Record<string, LearnerAnswer>>(() => {
    const base = { ...(initialAnswers ?? {}) };
    // 복원된 터미널 실습 상태는 저장된 성공 여부를 그대로 믿지 않고, 복원된 실제
    // 상태가 현재 문항의 성공 조건을 충족하는지 다시 검증해 답변에 반영한다.
    if (initialTerminalStates) {
      for (const item of questions) {
        if (item.type !== "terminal-task" || !item.terminalTask) continue;
        const snapshot = initialTerminalStates[item.id];
        if (!snapshot) continue;
        const restored = deserializeTerminalState(snapshot);
        if (!restored) continue;
        const { passed } = checkTerminalSuccess(restored.state, item.terminalTask.successChecks);
        base[item.id] = { kind: "terminal", passed };
      }
    }
    return base;
  });
  const [terminalStates, setTerminalStates] = useState<Record<string, TerminalStateSnapshot>>(
    () => initialTerminalStates ?? {},
  );
  const [confirming, setConfirming] = useState(false);
  const [exitConfirming, setExitConfirming] = useState(false);
  const q = questions[idx];

  // 렌즈봇 화면 인식용 현재 문항 발행 (정답 보호는 서버에서 근거 범위로 제어한다)
  useEffect(() => {
    if (q) publishLearnScreen({ questionId: q.id });
  }, [q]);

  // 진행 중 응시 저장 — 답변·위치·터미널 상태가 바뀔 때만 보고한다 (렌더링마다 저장하지 않음)
  useEffect(() => {
    onProgressChange?.(answers, idx, terminalStates);
  }, [answers, idx, terminalStates, onProgressChange]);

  // 제출 확인 창은 제출 중에도 닫지 않는다 — 저장 실패 시 같은 창에서 오류와 재시도를 보여준다
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
              key={q.id}
              scenario={q.terminalTask.scenario}
              instructions={q.terminalTask.instructions}
              successChecks={q.terminalTask.successChecks}
              hint={q.terminalTask.hint}
              initialSnapshot={terminalStates[q.id] ?? null}
              onSnapshotChange={(snapshot) =>
                setTerminalStates((s) => ({ ...s, [q.id]: snapshot }))
              }
              onResult={(passed) => setAnswer({ kind: "terminal", passed })}
            />
          </>
        ) : null}
      </div>

      <div className="learn-quiz-nav">
        <Button type="button" variant="outline" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>
          <ArrowLeft /> 이전
        </Button>
        <span className="learn-quiz-nav-right">
          <Button type="button" variant="outline" onClick={() => setExitConfirming(true)}>
            종료
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
        </span>
      </div>

      {exitConfirming ? (
        <div className="learn-question-card" role="alertdialog" aria-label="종료 확인" style={{ marginTop: 16 }}>
          <h3>퀴즈를 종료할까요?</h3>
          <p>진행 중인 퀴즈가 종료되며, 제출하지 않은 답변은 채점되지 않습니다.</p>
          <div className="learn-actions">
            <Button type="button" variant="default" onClick={() => setExitConfirming(false)}>
              계속 풀기
            </Button>
            <Button type="button" variant="outline" onClick={onCancel}>
              종료하기
            </Button>
          </div>
        </div>
      ) : null}

      {confirming ? (
        <div className="learn-question-card" role="alertdialog" aria-label="제출 확인" style={{ marginTop: 16 }}>
          {submitError ? (
            <>
              <p role="alert">{submitError}</p>
              <div className="learn-actions">
                <Button type="button" variant="default" onClick={onRetrySubmit} disabled={submitting}>
                  {submitting ? "저장 중…" : "다시 저장하기"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={submitting}>
                  계속 풀기
                </Button>
              </div>
            </>
          ) : (
            <>
              {unanswered.length > 0 ? (
                <p>
                  아직 답변하지 않은 문항이 <strong>{unanswered.length}개</strong> 있습니다. 미응답 문항은 오답 처리됩니다.
                </p>
              ) : (
                <p>모든 문항에 답변했습니다. 제출하시겠습니까?</p>
              )}
              <div className="learn-actions">
                <Button type="button" variant="default" onClick={() => onSubmit(answers)} disabled={submitting}>
                  {submitting ? "저장 중…" : "제출하고 채점하기"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={submitting}>
                  계속 풀기
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
