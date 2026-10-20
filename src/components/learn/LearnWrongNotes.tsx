"use client";

import { ArrowLeft, ArrowRight, FileCheck2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { findQuestion } from "@/lib/learn/questions";
import type { LearnLevelNo, LearnProgress, LearnerAnswer } from "@/lib/learn/types";

interface LearnWrongNotesProps {
  progress: LearnProgress;
  onMarkReviewed: (questionId: string) => void;
  onBack: () => void;
  onOpenLesson: (level: LearnLevelNo) => void;
}

function findAttemptAnswer(progress: LearnProgress, w: LearnProgress["wrongAnswers"][number]): LearnerAnswer | undefined {
  const level = progress.levels[w.level];
  const attempt = level?.attempts.find((a) => a.attemptId === w.attemptId);
  return attempt?.answers[w.questionId];
}

export function LearnWrongNotes({ progress, onMarkReviewed, onBack, onOpenLesson }: LearnWrongNotesProps) {
  // 최신 오답 순으로 정렬
  const notes = [...progress.wrongAnswers].reverse();

  return (
    <div className="learn-wrongnotes">
      <Button type="button" variant="ghost" size="sm" className="learn-back" onClick={onBack}>
        <ArrowLeft /> 학습센터로 돌아가기
      </Button>
      <h2>오답 노트</h2>
      <p className="learn-muted learn-diagnostic-intro">
        틀린 문제를 복습하세요. 복습한다고 점수나 단계 해제 상태가 바뀌지는 않습니다.
        같은 개념을 반복해서 틀리면 관련 학습 내용을 다시 보는 것이 좋습니다.
      </p>

      {notes.length === 0 ? (
        <div className="learn-empty">
          <span className="learn-empty-icon" aria-hidden="true">
            <FileCheck2 />
          </span>
          <p className="learn-empty-title">아직 복습할 오답이 없습니다</p>
          <p className="learn-muted">
            퀴즈에 응시한 후 틀린 문제가 있으면 이곳에 표시됩니다.
            학습을 진행하면서 오답 노트를 채워보세요.
          </p>
          <Button type="button" variant="default" onClick={onBack}>
            학습센터로 이동 <ArrowRight />
          </Button>
        </div>
      ) : (
        notes.map((w, i) => {
          const q = findQuestion(w.questionId);
          if (!q) return null;
          const answer = findAttemptAnswer(progress, w);
          const myChoices =
            answer?.kind === "choices" ? answer.selectedChoiceIds : [];
          return (
            <section key={`${w.questionId}-${w.attemptId}-${i}`} className="learn-note-item">
              <p className="learn-question-meta">
                LEVEL {w.level} · {w.category || q.category} · 복습 {w.reviewCount}회
              </p>
              <p className="learn-note-prompt">
                <strong>{q.prompt}</strong>
              </p>
              {q.choices ? (
                <ul className="learn-note-choices">
                  {q.choices.map((c) => {
                    const isCorrect = q.correctChoiceIds?.includes(c.id);
                    const isMine = myChoices.includes(c.id);
                    return (
                      <li key={c.id} className={isCorrect ? "is-correct" : isMine ? "is-mine" : undefined}>
                        <span className="learn-choice-id">{c.id.toUpperCase()}</span>
                        <span className="learn-note-choice-text">{c.text}</span>
                        {isCorrect ? <span className="learn-tag is-correct">정답</span> : null}
                        {isMine ? <span className="learn-tag is-mine">내 답</span> : null}
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
              <div className="learn-actions">
                <Button type="button" variant="outline" size="sm" onClick={() => onOpenLesson(q.level)}>
                  관련 학습 보기 (LEVEL {q.level})
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => onMarkReviewed(w.questionId)}>
                  복습 완료 표시
                </Button>
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
