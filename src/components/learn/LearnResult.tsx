"use client";

import { Button } from "@/components/ui/button";
import { levelMeta } from "@/lib/learn/curriculum";
import { findQuestion, linkedUnitForQuestion, orderedChoicesForAttempt } from "@/lib/learn/questions";
import type { LearnLevelNo, QuizAttempt } from "@/lib/learn/types";

interface LearnResultProps {
  attempt: QuizAttempt;
  onRetry: () => void;
  onNext: () => void;
  onDashboard: () => void;
  onReviewWrong: () => void;
  onOpenLessonUnit: (level: LearnLevelNo, unitId?: string) => void;
  /** LEVEL 10 통과로 전체 학습이 완료된 경우에만 제공되는 학습 완료 확인 화면 이동 */
  onOpenCompletion?: () => void;
}

export function LearnResult({ attempt, onRetry, onNext, onDashboard, onReviewWrong, onOpenLessonUnit, onOpenCompletion }: LearnResultProps) {
  const meta = levelMeta(attempt.level);
  // 응시 당시 적용된 통과 기준을 우선 표시한다 (과거 기록은 당시 기준으로 판정됨)
  const passScore = attempt.passScore ?? meta.passScore;
  const correct = attempt.graded.filter((g) => g.correct).length;
  const wrong = attempt.graded.length - correct;
  const nextLevel = (attempt.level + 1) as LearnLevelNo;

  return (
    <div>
      <h2>LEVEL {attempt.level} 평가 결과</h2>
      <div className="learn-surface">
        <div className="learn-result-score">{attempt.score}점</div>
        <p className={attempt.passed ? "learn-result-pass" : "learn-result-fail"}>
          {attempt.passed ? `통과! (기준 ${passScore}점)` : `미통과 (기준 ${passScore}점)`}
        </p>
        <div className="learn-kv">
          <div className="learn-kv-item">
            <strong>{correct}</strong>
            <span>정답</span>
          </div>
          <div className="learn-kv-item">
            <strong>{wrong}</strong>
            <span>오답</span>
          </div>
          <div className="learn-kv-item">
            <strong>{attempt.graded.length}</strong>
            <span>전체 문항</span>
          </div>
        </div>
        <div className="learn-actions">
          {attempt.passed && onOpenCompletion ? (
            <Button type="button" variant="default" onClick={onOpenCompletion}>
              학습 완료 확인하기
            </Button>
          ) : null}
          {attempt.passed && nextLevel <= 10 ? (
            <Button type="button" variant="default" onClick={onNext}>
              다음 단계로
            </Button>
          ) : !attempt.passed ? (
            <Button type="button" variant="default" onClick={onRetry}>
              재응시하기
            </Button>
          ) : null}
          {attempt.passed ? (
            <Button type="button" variant="outline" onClick={onRetry}>
              재응시하기
            </Button>
          ) : null}
          {wrong > 0 ? (
            <Button type="button" variant="outline" onClick={onReviewWrong}>
              오답 노트 보기
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={onDashboard}>
            학습센터로
          </Button>
        </div>
      </div>

      <h3 style={{ marginTop: 24 }}>문항별 해설</h3>
      {attempt.graded.map((g, i) => {
        const q = findQuestion(g.questionId);
        if (!q) return null;
        const answer = attempt.answers[g.questionId];
        const choices = orderedChoicesForAttempt(q, attempt);
        const unit = g.correct ? undefined : linkedUnitForQuestion(q);
        return (
          <section key={g.questionId} className="learn-note-item">
            <p className="learn-question-meta">
              {i + 1}번 문항 · {q.category}
              {unit ? <> · 관련 학습: {unit.title}</> : null}
            </p>
            <p className="learn-note-prompt">
              <strong>
                {i + 1}번. {g.correct ? "정답" : "오답"}
              </strong>
            </p>
            <p>{q.prompt}</p>
            {choices ? (
              <ul className="learn-note-choices">
                {choices.map((c, choiceIdx) => {
                  const isCorrect = q.correctChoiceIds?.includes(c.id);
                  const isSelected = answer?.kind === "choices" && answer.selectedChoiceIds.includes(c.id);
                  return (
                    <li key={c.id} className={isCorrect ? "is-correct" : isSelected ? "is-mine" : undefined}>
                      <span className="learn-choice-id">{String.fromCharCode(65 + choiceIdx)}</span>
                      <span className="learn-note-choice-text">{c.text}</span>
                      {isCorrect ? <span className="learn-tag is-correct">정답</span> : null}
                      {isSelected ? <span className="learn-tag is-mine">내 답</span> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {q.type === "ox" ? (
              <p>
                정답: <strong>{q.oxAnswer ? "O" : "X"}</strong>
                {answer?.kind === "ox" ? (
                  <>
                    {" · "}내 답: <strong>{answer.answer ? "O" : "X"}</strong>
                  </>
                ) : null}
              </p>
            ) : null}
            <div className="learn-explanation">
              <strong>해설:</strong> {q.explanation}
            </div>
            {unit ? (
              <div className="learn-actions">
                <Button type="button" variant="outline" size="sm" onClick={() => onOpenLessonUnit(attempt.level, unit.id)}>
                  관련 내용 학습하기
                </Button>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
