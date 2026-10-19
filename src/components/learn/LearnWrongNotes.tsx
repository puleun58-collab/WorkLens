"use client";

import { Button } from "@/components/ui/button";
import { findQuestion } from "@/lib/learn/questions";
import type { LearnLevelNo, LearnProgress } from "@/lib/learn/types";

interface LearnWrongNotesProps {
  progress: LearnProgress;
  onMarkReviewed: (questionId: string) => void;
  onBack: () => void;
  onOpenLesson: (level: LearnLevelNo) => void;
}

export function LearnWrongNotes({ progress, onMarkReviewed, onBack, onOpenLesson }: LearnWrongNotesProps) {
  // 최신 오답 순으로 정렬
  const notes = [...progress.wrongAnswers].reverse();

  return (
    <div>
      <Button type="button" variant="ghost" size="sm" onClick={onBack}>
        ← 학습센터로
      </Button>
      <h2>오답 노트</h2>
      <p className="learn-muted">
        틀린 문제를 복습하세요. 복습한다고 점수나 단계 해제 상태가 바뀌지는 않습니다.
        같은 개념을 반복해서 틀리면 관련 학습 내용을 다시 보는 것이 좋습니다.
      </p>

      {notes.length === 0 ? (
        <div className="learn-surface">
          <p>아직 오답이 없습니다. 퀴즈에 응시해 보세요.</p>
        </div>
      ) : (
        notes.map((w, i) => {
          const q = findQuestion(w.questionId);
          if (!q) return null;
          return (
            <div key={`${w.questionId}-${w.attemptId}-${i}`} className="learn-review-item is-wrong">
              <p>
                <small className="learn-muted">
                  LEVEL {w.level} · {w.category || q.category} · 복습 {w.reviewCount}회
                </small>
              </p>
              <p>
                <strong>{q.prompt}</strong>
              </p>
              {q.choices ? (
                <ul>
                  {q.choices.map((c) => (
                    <li key={c.id}>
                      {c.id.toUpperCase()}. {c.text}
                      {q.correctChoiceIds?.includes(c.id) ? " ✓ (정답)" : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
              {q.type === "ox" ? <p>정답: {q.oxAnswer ? "O" : "X"}</p> : null}
              <div className="learn-explanation">
                <strong>해설:</strong> {q.explanation}
              </div>
              <div className="learn-actions">
                <Button type="button" variant="outline" size="sm" onClick={() => onOpenLesson(q.level)}>
                  관련 학습 보기 (LEVEL {q.level})
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => onMarkReviewed(w.questionId)}>
                  복습 완료 표시
                </Button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
