"use client";

import { Button } from "@/components/ui/button";
import { levelMeta } from "@/lib/learn/curriculum";
import { findQuestion } from "@/lib/learn/questions";
import type { LearnLevelNo, QuizAttempt } from "@/lib/learn/types";

interface LearnResultProps {
  attempt: QuizAttempt;
  onRetry: () => void;
  onNext: () => void;
  onDashboard: () => void;
  onReviewWrong: () => void;
}

export function LearnResult({ attempt, onRetry, onNext, onDashboard, onReviewWrong }: LearnResultProps) {
  const meta = levelMeta(attempt.level);
  const correct = attempt.graded.filter((g) => g.correct).length;
  const wrong = attempt.graded.length - correct;
  const nextLevel = (attempt.level + 1) as LearnLevelNo;

  return (
    <div>
      <h2>LEVEL {attempt.level} 평가 결과</h2>
      <div className="learn-surface">
        <div className="learn-result-score">{attempt.score}점</div>
        <p className={attempt.passed ? "learn-result-pass" : "learn-result-fail"}>
          {attempt.passed ? `통과! (기준 ${meta.passScore}점)` : `미통과 (기준 ${meta.passScore}점)`}
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
        return (
          <section key={g.questionId} className="learn-note-item">
            <p className="learn-question-meta">
              {i + 1}번 문항 · {q.category}
            </p>
            <p className="learn-note-prompt">
              <strong>
                {i + 1}번. {g.correct ? "정답" : "오답"}
              </strong>
            </p>
            <p>{q.prompt}</p>
            {q.choices ? (
              <ul className="learn-note-choices">
                {q.choices.map((c) => {
                  const isCorrect = q.correctChoiceIds?.includes(c.id);
                  const isSelected = answer?.kind === "choices" && answer.selectedChoiceIds.includes(c.id);
                  return (
                    <li key={c.id} className={isCorrect ? "is-correct" : isSelected ? "is-mine" : undefined}>
                      <span className="learn-choice-id">{c.id.toUpperCase()}</span>
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
          </section>
        );
      })}
    </div>
  );
}
