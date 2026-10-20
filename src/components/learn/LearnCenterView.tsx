"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ALL_LEVELS, DIAGNOSTIC_AREAS, levelMeta } from "@/lib/learn/curriculum";
import { levelContent } from "@/lib/learn/content";
import { diagnosticQuestions, findQuestion, questionBank } from "@/lib/learn/questions";
import { loadLearnProgressEx, noteLearnRevision, saveLearnProgress, LEARN_STORAGE_NOTICE } from "@/lib/learn/progress-store";
import {
  applyAttempt,
  canUnlockLevel,
  gradeQuiz,
  isLearningComplete,
  newAttemptId,
  overallProgress,
  selectQuizQuestions,
  shuffleQuestionChoices,
  weakCategories,
} from "@/lib/learn/scoring";
import type {
  LearnLevelNo,
  LearnProgress,
  LearnQuestion,
  LearnerAnswer,
  QuizAttempt,
} from "@/lib/learn/types";
import { clearLearnScreen, publishLearnScreen } from "@/client/learn-screen";
import { LearnLesson } from "./LearnLesson";
import { LearnQuiz } from "./LearnQuiz";
import { LearnResult } from "./LearnResult";
import { LearnWrongNotes } from "./LearnWrongNotes";
import { LearnDiagnostic } from "./LearnDiagnostic";
import { LearnCertificate } from "./LearnCertificate";
import "./learn.css";

export type LearnScreen =
  | { name: "dashboard" }
  | { name: "lesson"; level: LearnLevelNo; unitId?: string }
  | { name: "quiz"; level: LearnLevelNo; attemptId: string; questions: LearnQuestion[]; startedAt: number }
  | { name: "result"; attempt: QuizAttempt }
  | { name: "wrongnotes" }
  | { name: "diagnostic" }
  | { name: "certificate" };

export function LearnCenterView() {
  const [progress, setProgress] = useState<LearnProgress | null>(null);
  // progressRef: 저장 기준이 되는 최신 진도 — 렌더 시점과 무관하게 항상 최신 값을 읽는다.
  // (빠른 연속 이동 시 이전 렌더의 클로저가 오래된 revision으로 저장하는 오판 방지)
  const progressRef = useRef<LearnProgress | null>(null);
  const [screen, setScreen] = useState<LearnScreen>({ name: "dashboard" });
  const [error, setError] = useState<string | null>(null);
  // 저장 실패는 화면 전체를 가리지 않는 배너로 표시한다 (학습 화면 유지)
  const [saveError, setSaveError] = useState<string | null>(null);
  const [canRetrySave, setCanRetrySave] = useState(false);
  const pendingSaveRef = useRef<((prev: LearnProgress) => LearnProgress) | null>(null);

  useEffect(() => {
    loadLearnProgressEx()
      .then((result) => {
        if (result.status === "corrupt") {
          // 손상된 기록은 빈 진도인 것처럼 자동 저장하여 덮어쓰지 않는다
          setError(result.message ?? "저장된 학습 기록의 형식이 손상되었습니다. 기존 기록을 보호하기 위해 저장을 중단했습니다.");
          return;
        }
        if (result.status === "unavailable") {
          setError(result.message ?? "학습 진도를 불러오지 못했습니다.");
          return;
        }
        noteLearnRevision(result.revision);
        progressRef.current = result.progress;
        setProgress(result.progress);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "학습 진도를 불러오지 못했습니다."));
  }, []);

  const persist = useCallback(
    async (updater: (prev: LearnProgress) => LearnProgress) => {
      const base = progressRef.current;
      if (!base) return;
      const next = updater(base);
      try {
        await saveLearnProgress(next);
        progressRef.current = next;
        setProgress(next);
        pendingSaveRef.current = null;
        setSaveError(null);
        setCanRetrySave(false);
      } catch (e) {
        const message = e instanceof Error ? e.message : "학습 진도 저장에 실패했습니다.";
        pendingSaveRef.current = updater;
        if (message.includes("다른 탭")) {
          // 실제 충돌 가능성 — 최신 데이터를 다시 읽어 복구 동선을 제공한다
          const latest = await loadLearnProgressEx();
          if (latest.status === "ok") {
            noteLearnRevision(latest.revision);
            progressRef.current = latest.progress;
            setProgress(latest.progress);
            setSaveError("다른 탭에서 학습 데이터가 변경되어 최신 기록을 다시 불러왔습니다. '다시 시도'를 눌러 방금 변경을 저장할 수 있습니다.");
            setCanRetrySave(true);
            return;
          }
        }
        setSaveError(message);
        setCanRetrySave(true);
      }
    },
    [],
  );

  const retrySave = useCallback(() => {
    const updater = pendingSaveRef.current;
    if (updater) void persist(updater);
  }, [persist]);

  // 렌즈봇 화면 인식용 현재 화면 발행 (단위·문항 같은 세부 상태는 하위 화면이 발행한다)
  useEffect(() => {
    switch (screen.name) {
      case "dashboard":
        publishLearnScreen({ mode: "dashboard", level: undefined, unitId: undefined, questionId: undefined, attemptId: undefined });
        break;
      case "lesson":
        publishLearnScreen({ mode: "lesson", level: screen.level, questionId: undefined, attemptId: undefined });
        break;
      case "quiz":
        publishLearnScreen({ mode: "quiz", level: screen.level, attemptId: screen.attemptId, unitId: undefined });
        break;
      case "result":
        publishLearnScreen({ mode: "result", level: screen.attempt.level, attemptId: screen.attempt.attemptId, questionId: undefined, unitId: undefined });
        break;
      case "wrongnotes":
        publishLearnScreen({ mode: "wrongnotes", level: undefined, unitId: undefined, questionId: undefined, attemptId: undefined });
        break;
      case "diagnostic":
        publishLearnScreen({ mode: "diagnostic", level: undefined, unitId: undefined, questionId: undefined, attemptId: undefined });
        break;
      case "certificate":
        publishLearnScreen({ mode: "certificate", level: undefined, unitId: undefined, questionId: undefined, attemptId: undefined });
        break;
    }
  }, [screen]);

  useEffect(() => () => clearLearnScreen(), []);

  const startQuiz = useCallback(
    (level: LearnLevelNo) => {
      if (!progress || !canUnlockLevel(level, progress)) return;
      const attemptId = newAttemptId();
      // 응시 시작 시점에만 문제 세트(단위별 균형 출제 + 순서·선택지 무작위)를 구성하고,
      // 응시가 끝날 때까지 이 구성을 그대로 고정한다.
      const unitIds = levelContent(level).units.map((u) => u.id);
      const attempts = progress.levels[level]?.attempts ?? [];
      const previousQuestionIds = attempts.length > 0 ? attempts[attempts.length - 1].questionIds : [];
      const selected = selectQuizQuestions(level, questionBank(level), attemptId, unitIds, previousQuestionIds);
      const questions = shuffleQuestionChoices(selected, attemptId);
      setScreen({ name: "quiz", level, attemptId, questions, startedAt: Date.now() });
      window.scrollTo({ top: 0 });
    },
    [progress],
  );

  const finishQuiz = useCallback(
    (level: LearnLevelNo, attemptId: string, questions: LearnQuestion[], answers: Record<string, LearnerAnswer>, startedAt: number) => {
      if (!progress) return;
      const { graded, score, passed } = gradeQuiz(level, questions, answers);
      const choiceOrder: Record<string, string[]> = {};
      for (const q of questions) {
        if (q.choices) choiceOrder[q.id] = q.choices.map((c) => c.id);
      }
      const attempt: QuizAttempt = {
        attemptId,
        level,
        questionIds: questions.map((q) => q.id),
        answers,
        graded,
        score,
        passed,
        // 응시 당시 통과 기준과 선택지 표시 순서를 기록에 고정한다
        passScore: levelMeta(level).passScore,
        choiceOrder,
        startedAt,
        finishedAt: Date.now(),
      };
      void persist((prev) => applyAttempt(prev, attempt, questions));
      setScreen({ name: "result", attempt });
      window.scrollTo({ top: 0 });
    },
    [progress, persist],
  );

  const openLessonUnit = useCallback((level: LearnLevelNo, unitId?: string) => {
    setScreen({ name: "lesson", level, unitId });
    window.scrollTo({ top: 0 });
  }, []);

  if (error) {
    return (
      <div className="learn-view" role="alert">
        <div className="learn-state">
          <p className="learn-empty-title">학습 진도를 불러오지 못했습니다</p>
          <p className="learn-muted">{error}</p>
        </div>
      </div>
    );
  }
  if (!progress) {
    return (
      <div className="learn-view">
        <div className="learn-state">
          <p className="learn-muted">학습 진도를 불러오는 중…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="learn-view">
      {saveError ? (
        <div className="learn-save-error" role="alert">
          <span>{saveError}</span>
          <span className="learn-save-error-actions">
            {canRetrySave ? (
              <Button type="button" variant="outline" size="sm" onClick={retrySave}>
                다시 시도
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="sm" onClick={() => { setSaveError(null); setCanRetrySave(false); }}>
              닫기
            </Button>
          </span>
        </div>
      ) : null}
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
          initialUnitId={screen.unitId}
          progress={progress}
          onPersistUnit={(unitId) => {
            void persist((prev) => {
              const lp = prev.levels[screen.level];
              return {
                ...prev,
                levels: {
                  ...prev.levels,
                  [screen.level]: {
                    passed: lp?.passed ?? false,
                    bestScore: lp?.bestScore ?? 0,
                    attempts: lp?.attempts ?? [],
                    lastStudiedUnitId: unitId,
                  },
                },
                updatedAt: Date.now(),
              };
            });
          }}
          onBack={() => { setScreen({ name: "dashboard" }); window.scrollTo({ top: 0 }); }}
          onStartQuiz={() => startQuiz(screen.level)}
        />
      ) : screen.name === "quiz" ? (
        <LearnQuiz
          level={screen.level}
          attemptId={screen.attemptId}
          questions={screen.questions}
          onSubmit={(answers) => finishQuiz(screen.level, screen.attemptId, screen.questions, answers, screen.startedAt)}
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
          onOpenLessonUnit={openLessonUnit}
        />
      ) : screen.name === "wrongnotes" ? (
        <LearnWrongNotes
          progress={progress}
          onMarkReviewed={(questionId) => {
            void persist((prev) => ({
              ...prev,
              wrongAnswers: prev.wrongAnswers.map((w) =>
                w.questionId === questionId ? { ...w, reviewCount: w.reviewCount + 1 } : w,
              ),
              updatedAt: Date.now(),
            }));
          }}
          onBack={() => { setScreen({ name: "dashboard" }); window.scrollTo({ top: 0 }); }}
          onOpenLesson={(level) => { setScreen({ name: "lesson", level }); window.scrollTo({ top: 0 }); }}
          onOpenLessonUnit={openLessonUnit}
        />
      ) : screen.name === "diagnostic" ? (
        <LearnDiagnostic
          questions={diagnosticQuestions()}
          onComplete={(weakAreaIds) => {
            void persist((prev) => ({
              ...prev,
              diagnostic: { answers: {}, completedAt: Date.now(), weakAreas: weakAreaIds },
              updatedAt: Date.now(),
            }));
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
  const weak = weakCategories(progress, (id) => findQuestion(id)?.category).slice(0, 3);
  const complete = isLearningComplete(progress);
  // 이어서 학습하기: 통과하지 못한 첫 번째 해제 단계
  const nextLevel = ALL_LEVELS.find((l) => canUnlockLevel(l, progress) && !progress.levels[l]?.passed);
  // 신규 사용자: 어떤 단계에도 응시한 적이 없음
  const isNewLearner = !ALL_LEVELS.some((l) => (progress.levels[l]?.attempts.length ?? 0) > 0);

  return (
    <div className="learn-dash">
      <h2>학습센터</h2>
      <p className="learn-muted learn-dash-intro">
        AI·AX 기초부터 업무 자동화 판단, AI 도구 활용, 개발·배포 실무까지 단계별로 학습합니다.
        각 단계를 통과하면 다음 단계가 해제됩니다.
      </p>

      <section className="learn-dash-card" aria-label="전체 진행률">
        <div className="learn-dash-progress-head">
          <h3>전체 진행률</h3>
          <span className="learn-dash-progress-count">
            {overall.passed} / {overall.total} 단계 ({overall.percent}%)
          </span>
        </div>
        <div className="learn-progress-bar learn-dash-bar" role="progressbar" aria-valuenow={overall.percent} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${overall.percent}%` }} />
        </div>
        <div className="learn-actions learn-dash-actions">
          {nextLevel ? (
            <Button type="button" variant="default" onClick={() => props.onOpenLesson(nextLevel)}>
              {isNewLearner ? "처음 학습하기" : "이어서 학습하기"} (LEVEL {nextLevel})
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
          <p className="learn-dash-note">
            <small>
              사전 진단 결과 보완 권장:{" "}
              {progress.diagnostic.weakAreas
                .map((id) => DIAGNOSTIC_AREAS.find((a) => a.id === id)?.label ?? id)
                .join(", ")}
            </small>
          </p>
        ) : null}
        {weak.length > 0 ? (
          <p className="learn-dash-note">
            <small>자주 틀리는 개념: {weak.map((w) => `${w.category}(${w.count})`).join(", ")}</small>
          </p>
        ) : null}
        <p className="learn-dash-note">
          <small>{LEARN_STORAGE_NOTICE}</small>
        </p>
      </section>

      <div className="learn-dash-roadmap-head">
        <h3>학습 로드맵</h3>
        <span className="learn-dash-roadmap-count">총 {ALL_LEVELS.length}개 단계</span>
      </div>
      <div className="learn-dash-roadmap">
        {ALL_LEVELS.map((level) => {
          const meta = levelMeta(level);
          const lp = progress.levels[level];
          const unlocked = canUnlockLevel(level, progress);
          const isCurrent = nextLevel === level;
          return (
            <div
              key={level}
              className={`learn-dash-row${lp?.passed ? " is-passed" : ""}${isCurrent ? " is-current" : ""}${!unlocked ? " is-locked" : ""}`}
            >
              <div className="learn-dash-no" aria-hidden="true">{String(level).padStart(2, "0")}</div>
              <div className="learn-dash-body">
                <div className="learn-dash-lv-title">{meta.title}</div>
                <div className="learn-dash-lv-desc">
                  {meta.topic} · 통과 {meta.passScore}점
                  {lp ? (
                    <> · 최고 {lp.bestScore}점 · 응시 {lp.attempts.length}회</>
                  ) : null}
                </div>
              </div>
              {!unlocked ? (
                <span className="learn-dash-locked">
                  <Lock aria-hidden="true" />
                  잠김
                </span>
              ) : (
                <div className="learn-dash-right">
                  {lp?.passed ? (
                    <span className="learn-dash-status is-passed">통과</span>
                  ) : isCurrent ? (
                    <span className="learn-dash-status is-current">
                      <Play aria-hidden="true" />
                      학습 중
                    </span>
                  ) : (
                    <span className="learn-dash-status">대기</span>
                  )}
                  <div className="learn-dash-btns">
                    <Button type="button" variant="outline" size="sm" onClick={() => props.onOpenLesson(level)}>
                      {lp?.passed ? "복습하기" : isCurrent ? "이어서 학습" : "학습하기"}
                    </Button>
                    <Button type="button" variant="default" size="sm" onClick={() => props.onStartQuiz(level)}>
                      퀴즈 응시
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
