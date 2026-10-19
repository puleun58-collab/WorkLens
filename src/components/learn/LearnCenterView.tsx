"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ALL_LEVELS, DIAGNOSTIC_AREAS, levelMeta } from "@/lib/learn/curriculum";
import { diagnosticQuestions, questionBank } from "@/lib/learn/questions";
import { loadLearnProgress, saveLearnProgress, LEARN_STORAGE_NOTICE } from "@/lib/learn/progress-store";
import {
  applyAttempt,
  canUnlockLevel,
  gradeQuiz,
  isLearningComplete,
  newAttemptId,
  overallProgress,
  selectQuizQuestions,
  weakCategories,
} from "@/lib/learn/scoring";
import type {
  LearnLevelNo,
  LearnProgress,
  LearnQuestion,
  LearnerAnswer,
  QuizAttempt,
} from "@/lib/learn/types";
import { LearnLesson } from "./LearnLesson";
import { LearnQuiz } from "./LearnQuiz";
import { LearnResult } from "./LearnResult";
import { LearnWrongNotes } from "./LearnWrongNotes";
import { LearnDiagnostic } from "./LearnDiagnostic";
import { LearnCertificate } from "./LearnCertificate";
import "./learn.css";

export type LearnScreen =
  | { name: "dashboard" }
  | { name: "lesson"; level: LearnLevelNo }
  | { name: "quiz"; level: LearnLevelNo; attemptId: string; questions: LearnQuestion[] }
  | { name: "result"; attempt: QuizAttempt }
  | { name: "wrongnotes" }
  | { name: "diagnostic" }
  | { name: "certificate" };

export function LearnCenterView() {
  const [progress, setProgress] = useState<LearnProgress | null>(null);
  const [revision, setRevision] = useState<string | undefined>(undefined);
  const [screen, setScreen] = useState<LearnScreen>({ name: "dashboard" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadLearnProgress()
      .then((p) => {
        setProgress(p);
        setRevision(JSON.stringify(p));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "학습 진도를 불러오지 못했습니다."));
  }, []);

  const persist = useCallback(
    async (next: LearnProgress) => {
      try {
        const rev = await saveLearnProgress(next, revision);
        setProgress(next);
        setRevision(rev);
      } catch (e) {
        setError(e instanceof Error ? e.message : "학습 진도 저장에 실패했습니다.");
      }
    },
    [revision],
  );

  const startQuiz = useCallback(
    (level: LearnLevelNo) => {
      if (!progress || !canUnlockLevel(level, progress)) return;
      const attemptId = newAttemptId();
      const questions = selectQuizQuestions(level, questionBank(level), attemptId);
      setScreen({ name: "quiz", level, attemptId, questions });
      window.scrollTo({ top: 0 });
    },
    [progress],
  );

  const finishQuiz = useCallback(
    (level: LearnLevelNo, attemptId: string, questions: LearnQuestion[], answers: Record<string, LearnerAnswer>) => {
      if (!progress) return;
      const { graded, score, passed } = gradeQuiz(level, questions, answers);
      const attempt: QuizAttempt = {
        attemptId,
        level,
        questionIds: questions.map((q) => q.id),
        answers,
        graded,
        score,
        passed,
        startedAt: Date.now(),
        finishedAt: Date.now(),
      };
      const next = applyAttempt(progress, attempt);
      void persist(next);
      setScreen({ name: "result", attempt });
      window.scrollTo({ top: 0 });
    },
    [progress, persist],
  );

  if (error) {
    return (
      <div className="learn-view" role="alert">
        <p>{error}</p>
      </div>
    );
  }
  if (!progress) {
    return (
      <div className="learn-view">
        <p className="learn-muted">학습 진도를 불러오는 중…</p>
      </div>
    );
  }

  return (
    <div className="learn-view">
      {screen.name === "dashboard" ? (
        <LearnDashboard
          progress={progress}
          onOpenLesson={(level) => { setScreen({ name: "lesson", level }); window.scrollTo({ top: 0 }); }}
          onStartQuiz={startQuiz}
          onOpenWrongNotes={() => { setScreen({ name: "wrongnotes" }); window.scrollTo({ top: 0 }); }}
          onOpenDiagnostic={() => { setScreen({ name: "diagnostic" }); window.scrollTo({ top: 0 }); }}
          onOpenCertificate={() => { setScreen({ name: "certificate" }); window.scrollTo({ top: 0 }); }}
        />
      ) : screen.name === "lesson" ? (
        <LearnLesson
          level={screen.level}
          progress={progress}
          onPersistUnit={(unitId) => {
            const lp = progress.levels[screen.level];
            void persist({ ...progress, levels: { ...progress.levels, [screen.level]: { passed: lp?.passed ?? false, bestScore: lp?.bestScore ?? 0, attempts: lp?.attempts ?? [], lastStudiedUnitId: unitId } }, updatedAt: Date.now() });
          }}
          onBack={() => { setScreen({ name: "dashboard" }); window.scrollTo({ top: 0 }); }}
          onStartQuiz={() => startQuiz(screen.level)}
        />
      ) : screen.name === "quiz" ? (
        <LearnQuiz
          level={screen.level}
          attemptId={screen.attemptId}
          questions={screen.questions}
          onSubmit={(answers) => finishQuiz(screen.level, screen.attemptId, screen.questions, answers)}
          onCancel={() => { setScreen({ name: "dashboard" }); window.scrollTo({ top: 0 }); }}
        />
      ) : screen.name === "result" ? (
        <LearnResult
          attempt={screen.attempt}
          onRetry={() => startQuiz(screen.attempt.level)}
          onNext={() => {
            const next = (screen.attempt.level + 1) as LearnLevelNo;
            if (next <= 10 && progress && canUnlockLevel(next, progress)) startQuiz(next);
            else { setScreen({ name: "dashboard" }); window.scrollTo({ top: 0 }); }
          }}
          onDashboard={() => { setScreen({ name: "dashboard" }); window.scrollTo({ top: 0 }); }}
          onReviewWrong={() => { setScreen({ name: "wrongnotes" }); window.scrollTo({ top: 0 }); }}
        />
      ) : screen.name === "wrongnotes" ? (
        <LearnWrongNotes
          progress={progress}
          onMarkReviewed={(questionId) => {
            const next: LearnProgress = {
              ...progress,
              wrongAnswers: progress.wrongAnswers.map((w) =>
                w.questionId === questionId ? { ...w, reviewCount: w.reviewCount + 1 } : w,
              ),
              updatedAt: Date.now(),
            };
            void persist(next);
          }}
          onBack={() => { setScreen({ name: "dashboard" }); window.scrollTo({ top: 0 }); }}
          onOpenLesson={(level) => { setScreen({ name: "lesson", level }); window.scrollTo({ top: 0 }); }}
        />
      ) : screen.name === "diagnostic" ? (
        <LearnDiagnostic
          questions={diagnosticQuestions()}
          onComplete={(weakAreaIds) => {
            const next: LearnProgress = {
              ...progress,
              diagnostic: { answers: {}, completedAt: Date.now(), weakAreas: weakAreaIds },
              updatedAt: Date.now(),
            };
            void persist(next);
            setScreen({ name: "dashboard" });
            window.scrollTo({ top: 0 });
          }}
          onSkip={() => { setScreen({ name: "dashboard" }); window.scrollTo({ top: 0 }); }}
        />
      ) : (
        <LearnCertificate
          progress={progress}
          onBack={() => { setScreen({ name: "dashboard" }); window.scrollTo({ top: 0 }); }}
        />
      )}
    </div>
  );
}

function LearnDashboard(props: {
  progress: LearnProgress;
  onOpenLesson: (level: LearnLevelNo) => void;
  onStartQuiz: (level: LearnLevelNo) => void;
  onOpenWrongNotes: () => void;
  onOpenDiagnostic: () => void;
  onOpenCertificate: () => void;
}) {
  const { progress } = props;
  const overall = overallProgress(progress);
  const weak = weakCategories(progress).slice(0, 3);
  const complete = isLearningComplete(progress);
  // 이어서 학습하기: 통과하지 못한 첫 번째 해제 단계
  const nextLevel = ALL_LEVELS.find((l) => canUnlockLevel(l, progress) && !progress.levels[l]?.passed);

  return (
    <div>
      <h2>AI·AX 학습센터</h2>
      <p className="learn-muted">
        AI·AX 기초부터 업무 자동화 판단, AI 도구 활용, 개발·배포 실무까지 단계별로 학습합니다.
        각 단계를 통과하면 다음 단계가 해제됩니다.
      </p>

      <div className="learn-surface" style={{ marginTop: 16 }}>
        <h3>전체 진행률</h3>
        <div className="learn-progress-bar" role="progressbar" aria-valuenow={overall.percent} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${overall.percent}%` }} />
        </div>
        <p>
          {overall.passed} / {overall.total} 단계 통과 ({overall.percent}%)
        </p>
        <div className="learn-actions">
          {nextLevel ? (
            <Button type="button" variant="default" onClick={() => props.onOpenLesson(nextLevel)}>
              이어서 학습하기 (LEVEL {nextLevel})
            </Button>
          ) : complete ? (
            <Button type="button" variant="default" onClick={props.onOpenCertificate}>
              수료증 보기
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={props.onOpenWrongNotes}>
            오답 노트 ({progress.wrongAnswers.length})
          </Button>
          {!progress.diagnostic ? (
            <Button type="button" variant="outline" onClick={props.onOpenDiagnostic}>
              사전 진단 받기 (선택)
            </Button>
          ) : null}
        </div>
        {progress.diagnostic && progress.diagnostic.weakAreas.length > 0 ? (
          <p>
            <small>
              사전 진단 결과 보완 권장:{" "}
              {progress.diagnostic.weakAreas
                .map((id) => DIAGNOSTIC_AREAS.find((a) => a.id === id)?.label ?? id)
                .join(", ")}
            </small>
          </p>
        ) : null}
        {weak.length > 0 ? (
          <p>
            <small>자주 틀리는 개념: {weak.map((w) => `${w.category}(${w.count})`).join(", ")}</small>
          </p>
        ) : null}
        <p>
          <small>{LEARN_STORAGE_NOTICE}</small>
        </p>
      </div>

      <h3 style={{ marginTop: 24 }}>학습 로드맵</h3>
      <div className="learn-roadmap">
        {ALL_LEVELS.map((level) => {
          const meta = levelMeta(level);
          const lp = progress.levels[level];
          const unlocked = canUnlockLevel(level, progress);
          const isCurrent = nextLevel === level;
          return (
            <div
              key={level}
              className={`learn-level-row${lp?.passed ? " is-passed" : ""}${isCurrent ? " is-current" : ""}${!unlocked ? " is-locked" : ""}`}
            >
              <div className="learn-level-no">L{level}</div>
              <div className="learn-level-body">
                <div className="learn-level-title">{meta.title}</div>
                <div className="learn-level-topic">{meta.topic} · 통과 {meta.passScore}점</div>
                {lp ? (
                  <div className="learn-level-topic">최고 점수 {lp.bestScore}점 · 응시 {lp.attempts.length}회</div>
                ) : null}
              </div>
              <div className="learn-level-status">
                {lp?.passed ? (
                  <strong>통과</strong>
                ) : !unlocked ? (
                  <span>잠김</span>
                ) : isCurrent ? (
                  <strong>학습 중</strong>
                ) : (
                  <span>대기</span>
                )}
              </div>
              <div className="learn-actions" style={{ margin: 0 }}>
                <Button type="button" variant="outline" size="sm" disabled={!unlocked} onClick={() => props.onOpenLesson(level)}>
                  학습하기
                </Button>
                <Button type="button" variant="default" size="sm" disabled={!unlocked} onClick={() => props.onStartQuiz(level)}>
                  퀴즈 응시
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="learn-surface" style={{ marginTop: 16 }}>
        <h3>실무 연결</h3>
        <p className="learn-muted">
          학습한 내용을 실제 업무에 적용해 보세요. 학습 점수는 자동화 진단에 영향을 주지 않습니다.
        </p>
        <ul>
          <li>LEVEL 2 완료 후 — 업무 자동화 진단에서 실제 업무의 자동화 가능성을 판단해 보세요.</li>
          <li>LEVEL 8 완료 후 — 자동화 설계 관점으로 업무를 다시 살펴보세요.</li>
          <li>LEVEL 10 완료 후 — 실제 업무를 등록하고 자동화 판단을 시작해 보세요.</li>
        </ul>
      </div>
    </div>
  );
}
