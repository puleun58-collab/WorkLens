"use client";

import { ArrowLeft, ArrowRight, FileCheck2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { levelContent } from "@/lib/learn/content";
import { findQuestion, linkedUnitForQuestion, orderedChoicesForAttempt } from "@/lib/learn/questions";
import type { LearnLevelNo, LearnProgress, QuizAttempt } from "@/lib/learn/types";

interface LearnWrongNotesProps {
  progress: LearnProgress;
  onMarkReviewed: (questionId: string) => void;
  onBack: () => void;
  onOpenLesson: (level: LearnLevelNo) => void;
  onOpenLessonUnit: (level: LearnLevelNo, unitId?: string) => void;
}

function findAttempt(progress: LearnProgress, w: LearnProgress["wrongAnswers"][number]): QuizAttempt | undefined {
  const level = progress.levels[w.level];
  return level?.attempts.find((a) => a.attemptId === w.attemptId);
}

export function LearnWrongNotes({ progress, onMarkReviewed, onBack, onOpenLesson, onOpenLessonUnit }: LearnWrongNotesProps) {
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
          const attempt = findAttempt(progress, w);
          // 내 답: 응시 기록이 남아 있으면 그 기록을, 응시 이력이 보관 한도를 넘어
          // 정리된 경우 응시 당시 스냅샷을 사용한다. 둘 다 없으면 추측해 표시하지 않는다.
          const answer = attempt?.answers[w.questionId] ?? w.myAnswer;
          // 문제 정보: 현재 문제은행을 우선하고, 문항이 변경·제거된 경우 스냅샷으로 보완한다
          const prompt = q?.prompt ?? w.prompt;
          const explanation = q?.explanation ?? w.explanation;
          const questionType = q?.type ?? w.questionType;
          const correctIds = q?.correctChoiceIds ?? w.correctChoiceIds;
          const oxAnswer = q?.oxAnswer ?? w.oxAnswer;
          const choices = q
            ? attempt
              ? orderedChoicesForAttempt(q, attempt)
              : (w.choices ?? orderedChoicesForAttempt(q, undefined))
            : w.choices;
          const unit = q
            ? linkedUnitForQuestion(q)
            : w.unitId
              ? levelContent(w.level).units.find((u) => u.id === w.unitId)
              : undefined;
          const noteLevel = q?.level ?? w.level;
          const myChoices = answer?.kind === "choices" ? answer.selectedChoiceIds : [];

          if (!prompt) {
            // 문제 정보를 어디에서도 복원할 수 없는 기록 — 임의로 만들지 않고
            // 아는 범위만 표시한다 (기록 자체는 삭제하지 않는다)
            return (
              <section key={`${w.questionId}-${w.attemptId}-${i}`} className="learn-note-item">
                <p className="learn-question-meta">
                  LEVEL {w.level} · {w.category || "분류 없음"} · 복습 {w.reviewCount}회
                </p>
                <p className="learn-muted">
                  이 오답의 문제 정보를 찾을 수 없습니다. 문제은행에서 문항이 변경·제거되었거나
                  오래된 기록입니다.
                </p>
                <div className="learn-actions">
                  <Button type="button" variant="outline" size="sm" onClick={() => onOpenLesson(w.level)}>
                    관련 학습 보기 (LEVEL {w.level})
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => onMarkReviewed(w.questionId)}>
                    복습 완료 표시
                  </Button>
                </div>
              </section>
            );
          }
          return (
            <section key={`${w.questionId}-${w.attemptId}-${i}`} className="learn-note-item">
              <p className="learn-question-meta">
                LEVEL {w.level} · {w.category || q?.category || ""} · 복습 {w.reviewCount}회
                {unit ? <> · 관련 학습: {unit.title}</> : null}
              </p>
              <p className="learn-note-prompt">
                <strong>{prompt}</strong>
              </p>
              {choices ? (
                <ul className="learn-note-choices">
                  {choices.map((c, choiceIdx) => {
                    const isCorrect = correctIds?.includes(c.id);
                    const isMine = myChoices.includes(c.id);
                    return (
                      <li key={c.id} className={isCorrect ? "is-correct" : isMine ? "is-mine" : undefined}>
                        <span className="learn-choice-id">{String.fromCharCode(65 + choiceIdx)}</span>
                        <span className="learn-note-choice-text">{c.text}</span>
                        {isCorrect ? <span className="learn-tag is-correct">정답</span> : null}
                        {isMine ? <span className="learn-tag is-mine">내 답</span> : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {questionType === "ox" && oxAnswer !== undefined ? (
                <p>
                  정답: <strong>{oxAnswer ? "O" : "X"}</strong>
                  {answer?.kind === "ox" ? (
                    <>
                      {" · "}내 답: <strong>{answer.answer ? "O" : "X"}</strong>
                    </>
                  ) : null}
                </p>
              ) : null}
              {explanation ? (
                <div className="learn-explanation">
                  <strong>해설:</strong> {explanation}
                </div>
              ) : null}
              <div className="learn-actions">
                {unit ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => onOpenLessonUnit(noteLevel, unit.id)}>
                    관련 내용 학습하기
                  </Button>
                ) : (
                  <Button type="button" variant="outline" size="sm" onClick={() => onOpenLesson(noteLevel)}>
                    관련 학습 보기 (LEVEL {noteLevel})
                  </Button>
                )}
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
