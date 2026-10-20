"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ALL_LEVELS, DIAGNOSTIC_AREAS, levelMeta } from "@/lib/learn/curriculum";
import { levelContent } from "@/lib/learn/content";
import { diagnosticQuestions, findQuestion, questionBank, restoreQuizQuestions } from "@/lib/learn/questions";
import {
  clearInProgressQuiz,
  loadInProgressQuiz,
  loadLearnProgressEx,
  noteLearnRevision,
  saveInProgressQuiz,
  saveLearnProgress,
  LEARN_STORAGE_NOTICE,
} from "@/lib/learn/progress-store";
import {
  applyAttempt,
  canUnlockLevel,
  gradeQuiz,
  isLearningComplete,
  newAttemptId,
  overallProgress,
  questionFingerprint,
  selectQuizQuestions,
  shuffleQuestionChoices,
  weakCategories,
} from "@/lib/learn/scoring";
import type {
  InProgressQuiz,
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
  | {
      name: "quiz";
      level: LearnLevelNo;
      attemptId: string;
      questions: LearnQuestion[];
      startedAt: number;
      initialAnswers: Record<string, LearnerAnswer>;
      initialIndex: number;
    }
  | { name: "quiz-resume"; targetLevel: LearnLevelNo; inProgress: InProgressQuiz }
  | { name: "result"; attempt: QuizAttempt }
  | { name: "wrongnotes" }
  | { name: "diagnostic" }
  | { name: "certificate" };

interface SaveJob {
  updater: (prev: LearnProgress) => LearnProgress;
  settle: (saved: boolean) => void;
}

export function LearnCenterView() {
  const [progress, setProgress] = useState<LearnProgress | null>(null);
  // progressRef: 저장 기준이 되는 최신 확정 진도 — 렌더 시점과 무관하게 항상 최신 값을 읽는다.
  // (빠른 연속 이동 시 이전 렌더의 클로저가 오래된 revision으로 저장하는 오판 방지)
  const progressRef = useRef<LearnProgress | null>(null);
  const [screen, setScreen] = useState<LearnScreen>({ name: "dashboard" });
  const [error, setError] = useState<string | null>(null);
  // 저장 실패는 화면 전체를 가리지 않는 배너로 표시한다 (학습 화면 유지)
  const [saveError, setSaveError] = useState<{ message: string; retryable: boolean } | null>(null);
  const saveErrorSourceRef = useRef<"progress" | "draft" | null>(null);
  // 저장 작업 큐 — 업데이터는 호출 시점이 아니라 저장 실행 시점의 최신 확정 상태에
  // 순서대로 적용한다. 저장 완료 전에 연속 요청이 와도 이전 변경이 유실되지 않는다.
  const saveQueueRef = useRef<SaveJob[]>([]);
  // 실패한 변경들 — 마지막 하나만 남기지 않고 원래 순서 그대로 보존해 재시도 시 재적용한다
  const failedUpdatersRef = useRef<((prev: LearnProgress) => LearnProgress)[]>([]);
  const flushingRef = useRef(false);
  // 진행 중 퀴즈 응시 (새로고침·재접속 복구용)
  const [inProgress, setInProgress] = useState<InProgressQuiz | null>(null);
  const inProgressRef = useRef<InProgressQuiz | null>(null);
  const quizDraftRef = useRef<InProgressQuiz | null>(null);
  const draftSaveTimerRef = useRef<number | null>(null);
  const draftSaveBlockedRef = useRef(false);
  // 퀴즈 제출 저장 확정 상태
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const pendingSubmissionRef = useRef<{ attempt: QuizAttempt; questions: LearnQuestion[] } | null>(null);

  useEffect(() => {
    loadLearnProgressEx()
      .then(async (result) => {
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
        // 진행 중이던 퀴즈가 있으면 복구 동선(대시보드 안내)을 위해 함께 불러온다
        const saved = await loadInProgressQuiz();
        if (saved) {
          inProgressRef.current = saved;
          setInProgress(saved);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : "학습 진도를 불러오지 못했습니다."));
  }, []);

  const showSaveError = useCallback((source: "progress" | "draft", message: string, retryable: boolean) => {
    saveErrorSourceRef.current = source;
    setSaveError({ message, retryable });
  }, []);

  const clearSaveError = useCallback(() => {
    saveErrorSourceRef.current = null;
    setSaveError(null);
  }, []);

  /**
   * 저장 큐 실행 — 큐의 작업을 순서대로, 각 업데이터를 실행 시점의 최신 확정
   * 상태(progressRef)에 적용해 저장한다. 실패하면 실패한 변경과 뒤에 대기 중인
   * 변경을 모두 보존하고 중단한다 (재시도 시 원래 순서대로 다시 적용).
   */
  const flushSaves = useCallback(async () => {
    if (flushingRef.current) return;
    flushingRef.current = true;
    try {
      // 이전에 실패한 변경을 원래 순서대로 큐 앞에 되돌린다
      if (failedUpdatersRef.current.length > 0) {
        const restored: SaveJob[] = failedUpdatersRef.current.map((updater) => ({ updater, settle: () => {} }));
        failedUpdatersRef.current = [];
        saveQueueRef.current = [...restored, ...saveQueueRef.current];
      }
      while (saveQueueRef.current.length > 0) {
        const job = saveQueueRef.current[0];
        const base = progressRef.current;
        if (!base) {
          saveQueueRef.current.shift();
          job.settle(false);
          continue;
        }
        const next = job.updater(base);
        try {
          await saveLearnProgress(next);
        } catch (e) {
          // 실패한 변경 + 대기 중인 변경을 순서 그대로 보존한다
          const remaining = saveQueueRef.current.splice(0).map((j) => {
            j.settle(false);
            return j.updater;
          });
          failedUpdatersRef.current.push(...remaining);
          const message = e instanceof Error ? e.message : "학습 진도 저장에 실패했습니다.";
          if (message.includes("다른 탭")) {
            // 실제 충돌 — 최신 데이터를 다시 읽고, 보류된 변경은 재시도 시
            // 최신 상태를 기준으로 다시 적용한다 (임의로 덮어쓰지 않는다)
            const latest = await loadLearnProgressEx();
            if (latest.status === "ok") {
              noteLearnRevision(latest.revision);
              progressRef.current = latest.progress;
              setProgress(latest.progress);
              showSaveError(
                "progress",
                "다른 탭에서 학습 데이터가 변경되어 최신 기록을 다시 불러왔습니다. '다시 시도'를 눌러 방금 변경을 다시 저장할 수 있습니다.",
                true,
              );
              return;
            }
          }
          showSaveError("progress", message, true);
          return;
        }
        progressRef.current = next;
        setProgress(next);
        saveQueueRef.current.shift();
        job.settle(true);
      }
      // 모든 변경이 저장됐으면 진도 저장 오류 배너를 정리한다
      if (failedUpdatersRef.current.length === 0 && saveErrorSourceRef.current === "progress") {
        clearSaveError();
      }
    } finally {
      flushingRef.current = false;
    }
  }, [showSaveError, clearSaveError]);

  /**
   * 진도 변경 저장 요청 — 반환 Promise는 이 변경이 실제로 저장 확정되면 true,
   * 실패하면 false로 완료된다. 업데이터는 저장 실행 시점에 적용된다.
   */
  const persist = useCallback(
    (updater: (prev: LearnProgress) => LearnProgress): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        saveQueueRef.current.push({ updater, settle: resolve });
        void flushSaves();
      }),
    [flushSaves],
  );

  const retrySave = useCallback(() => {
    void flushSaves();
  }, [flushSaves]);

  /* ---------------- 진행 중 퀴즈 초안 저장 ---------------- */

  const cancelDraftTimer = useCallback(() => {
    if (draftSaveTimerRef.current !== null) {
      window.clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }
  }, []);

  const saveDraftNow = useCallback(async () => {
    const draft = quizDraftRef.current;
    if (!draft || draftSaveBlockedRef.current) return;
    try {
      const stored = await saveInProgressQuiz(draft);
      if (quizDraftRef.current?.attemptId === draft.attemptId) {
        quizDraftRef.current = { ...quizDraftRef.current, savedAt: stored.savedAt };
      }
      if (inProgressRef.current?.attemptId === draft.attemptId) {
        inProgressRef.current = stored;
        setInProgress(stored);
      }
      if (saveErrorSourceRef.current === "draft") clearSaveError();
    } catch (e) {
      const message = e instanceof Error ? e.message : "진행 중 응시를 저장하지 못했습니다.";
      if (message.includes("다른 탭")) {
        // 다른 탭이 같은 응시를 변경함 — 이 탭의 자동 저장을 중단해 덮어쓰기를 막는다
        draftSaveBlockedRef.current = true;
        showSaveError(
          "draft",
          "다른 탭에서 같은 퀴즈가 진행 중입니다. 이 탭의 답변은 더 이상 자동 저장되지 않습니다. 새로고침하면 저장된 최신 응시 상태를 불러옵니다.",
          false,
        );
      } else {
        showSaveError("draft", "진행 중 응시를 저장하지 못했습니다. 다음 답변 변경 때 다시 저장을 시도합니다.", false);
      }
    }
  }, [showSaveError, clearSaveError]);

  const scheduleDraftSave = useCallback(() => {
    cancelDraftTimer();
    draftSaveTimerRef.current = window.setTimeout(() => {
      draftSaveTimerRef.current = null;
      void saveDraftNow();
    }, 200);
  }, [cancelDraftTimer, saveDraftNow]);

  const handleQuizProgress = useCallback(
    (answers: Record<string, LearnerAnswer>, currentIndex: number) => {
      const draft = quizDraftRef.current;
      if (!draft) return;
      quizDraftRef.current = { ...draft, answers, currentIndex };
      scheduleDraftSave();
    },
    [scheduleDraftSave],
  );

  // 탭이 숨겨지거나 페이지가 닫히기 직전에는 대기 중인 초안 저장을 즉시 실행한다
  useEffect(() => {
    const flushDraft = () => {
      if (draftSaveTimerRef.current !== null) {
        cancelDraftTimer();
        void saveDraftNow();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushDraft();
    };
    window.addEventListener("pagehide", flushDraft);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flushDraft);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [cancelDraftTimer, saveDraftNow]);

  /* ---------------- 퀴즈 시작·복구·종료 ---------------- */

  const startFreshQuiz = useCallback((level: LearnLevelNo) => {
    const base = progressRef.current;
    if (!base || !canUnlockLevel(level, base)) return;
    const attemptId = newAttemptId();
    // 응시 시작 시점에만 문제 세트(단위별 균형 출제 + 순서·선택지 무작위)를 구성하고,
    // 응시가 끝날 때까지 이 구성을 그대로 고정한다.
    const unitIds = levelContent(level).units.map((u) => u.id);
    const attempts = base.levels[level]?.attempts ?? [];
    const previousQuestionIds = attempts.length > 0 ? attempts[attempts.length - 1].questionIds : [];
    const selected = selectQuizQuestions(level, questionBank(level), attemptId, unitIds, previousQuestionIds);
    const questions = shuffleQuestionChoices(selected, attemptId);
    const choiceOrder: Record<string, string[]> = {};
    const questionChecks: Record<string, number> = {};
    for (const q of questions) {
      if (q.choices) choiceOrder[q.id] = q.choices.map((c) => c.id);
      questionChecks[q.id] = questionFingerprint(q);
    }
    const startedAt = Date.now();
    const draft: InProgressQuiz = {
      attemptId,
      level,
      startedAt,
      questionIds: questions.map((q) => q.id),
      choiceOrder,
      answers: {},
      currentIndex: 0,
      passScore: levelMeta(level).passScore,
      questionChecks,
      savedAt: 0,
      status: "in-progress",
    };
    quizDraftRef.current = draft;
    draftSaveBlockedRef.current = false;
    inProgressRef.current = draft;
    setInProgress(draft);
    // 진행 중 응시를 먼저 저장해 새로고침해도 같은 응시로 복구할 수 있게 한다
    void saveDraftNow();
    setScreen({ name: "quiz", level, attemptId, questions, startedAt, initialAnswers: {}, initialIndex: 0 });
    window.scrollTo({ top: 0 });
  }, [saveDraftNow]);

  const resumeInProgress = useCallback((saved: InProgressQuiz) => {
    const questions = restoreQuizQuestions(saved);
    if (!questions) {
      // 복원할 수 없으면 임의로 대체하지 않고 안내 화면으로 보낸다
      setScreen({ name: "quiz-resume", targetLevel: saved.level, inProgress: saved });
      window.scrollTo({ top: 0 });
      return;
    }
    quizDraftRef.current = saved;
    draftSaveBlockedRef.current = false;
    setScreen({
      name: "quiz",
      level: saved.level,
      attemptId: saved.attemptId,
      questions,
      startedAt: saved.startedAt,
      initialAnswers: saved.answers,
      initialIndex: Math.min(saved.currentIndex, questions.length - 1),
    });
    window.scrollTo({ top: 0 });
  }, []);

  const discardInProgress = useCallback(
    async (saved: InProgressQuiz) => {
      cancelDraftTimer();
      if (quizDraftRef.current?.attemptId === saved.attemptId) quizDraftRef.current = null;
      if (inProgressRef.current?.attemptId === saved.attemptId) {
        inProgressRef.current = null;
        setInProgress(null);
      }
      await clearInProgressQuiz(saved.attemptId).catch(() => {});
    },
    [cancelDraftTimer],
  );

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
      const saved = inProgressRef.current;
      if (saved) {
        // 진행 중 응시가 있으면 안내 없이 덮어쓰지 않는다.
        // 같은 LEVEL이면 그대로 이어가고, 다른 LEVEL이면 선택 화면을 거친다.
        if (saved.level === level) {
          resumeInProgress(saved);
          return;
        }
        setScreen({ name: "quiz-resume", targetLevel: level, inProgress: saved });
        window.scrollTo({ top: 0 });
        return;
      }
      startFreshQuiz(level);
    },
    [resumeInProgress, startFreshQuiz],
  );

  const cancelQuiz = useCallback(
    (attemptId: string) => {
      // 명시적 종료 — 진행 중 임시 응시를 정리한다 (완료 기록·과거 점수는 유지)
      cancelDraftTimer();
      if (quizDraftRef.current?.attemptId === attemptId) quizDraftRef.current = null;
      if (inProgressRef.current?.attemptId === attemptId) {
        inProgressRef.current = null;
        setInProgress(null);
      }
      pendingSubmissionRef.current = null;
      setSubmitError(null);
      void clearInProgressQuiz(attemptId).catch(() => {});
      setScreen({ name: "dashboard" });
      window.scrollTo({ top: 0 });
    },
    [cancelDraftTimer],
  );

  /* ---------------- 퀴즈 제출 (저장 확정 후 결과 표시) ---------------- */

  const submitAttempt = useCallback(
    async (attempt: QuizAttempt, questions: LearnQuestion[]) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      setSubmitting(true);
      setSubmitError(null);
      pendingSubmissionRef.current = { attempt, questions };
      // 채점 결과는 IndexedDB 저장이 확정된 뒤에만 결과 화면으로 확정 표시한다.
      // applyAttempt가 attemptId 기준 멱등이라 재시도해도 기록이 중복되지 않는다.
      const saved = await persist((prev) => applyAttempt(prev, attempt, questions));
      submittingRef.current = false;
      setSubmitting(false);
      if (!saved) {
        // 답변과 응시 상태를 그대로 유지하고 재시도 동선을 제공한다
        setSubmitError("채점 결과를 저장하지 못했습니다. 답변은 그대로 유지됩니다. '다시 저장하기'를 눌러 주세요.");
        return;
      }
      pendingSubmissionRef.current = null;
      // 제출 확정 — 진행 중 임시 응시를 정리하고 결과 화면을 표시한다
      cancelDraftTimer();
      if (quizDraftRef.current?.attemptId === attempt.attemptId) quizDraftRef.current = null;
      if (inProgressRef.current?.attemptId === attempt.attemptId) {
        inProgressRef.current = null;
        setInProgress(null);
      }
      void clearInProgressQuiz(attempt.attemptId).catch(() => {});
      setScreen({ name: "result", attempt });
      window.scrollTo({ top: 0 });
    },
    [persist, cancelDraftTimer],
  );

  const finishQuiz = useCallback(
    (level: LearnLevelNo, attemptId: string, questions: LearnQuestion[], answers: Record<string, LearnerAnswer>, startedAt: number) => {
      if (submittingRef.current) return;
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
      void submitAttempt(attempt, questions);
    },
    [submitAttempt],
  );

  const retrySubmit = useCallback(() => {
    const pending = pendingSubmissionRef.current;
    if (pending) void submitAttempt(pending.attempt, pending.questions);
  }, [submitAttempt]);

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
          <span>{saveError.message}</span>
          <span className="learn-save-error-actions">
            {saveError.retryable ? (
              <Button type="button" variant="outline" size="sm" onClick={retrySave}>
                다시 시도
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="sm" onClick={clearSaveError}>
              닫기
            </Button>
          </span>
        </div>
      ) : null}
      {screen.name === "dashboard" ? (
        <LearnDashboard
          progress={progress}
          inProgress={inProgress}
          onResumeInProgress={() => { if (inProgressRef.current) resumeInProgress(inProgressRef.current); }}
          onRestartInProgress={() => {
            const saved = inProgressRef.current;
            if (!saved) return;
            void discardInProgress(saved).then(() => startFreshQuiz(saved.level));
          }}
          onOpenLesson={(level) => { setScreen({ name: "lesson", level }); window.scrollTo({ top: 0 }); }}
          onStartQuiz={startQuiz}
          onOpenWrongNotes={() => { setScreen({ name: "wrongnotes" }); window.scrollTo({ top: 0 }); }}
          onOpenDiagnostic={() => { setScreen({ name: "diagnostic" }); window.scrollTo({ top: 0 }); }}
          onOpenCertificate={() => { setScreen({ name: "certificate" }); window.scrollTo({ top: 0 }); }}
        />
      ) : screen.name === "quiz-resume" ? (
        <div>
          <h2>진행 중인 퀴즈가 있습니다</h2>
          <div className="learn-question-card">
            {restoreQuizQuestions(screen.inProgress) ? (
              <p>
                LEVEL {screen.inProgress.level} 퀴즈를 풀던 중입니다. 진행 중 응시를 이어가거나,
                종료하고 LEVEL {screen.targetLevel} 퀴즈를 새로 시작할 수 있습니다.
              </p>
            ) : (
              <p>
                LEVEL {screen.inProgress.level} 퀴즈가 진행 중이었지만 문제은행이 변경되어
                이전 응시를 복원할 수 없습니다. 진행 중 응시를 종료하고
                LEVEL {screen.targetLevel} 퀴즈를 새로 시작할 수 있습니다.
              </p>
            )}
            <div className="learn-actions">
              {restoreQuizQuestions(screen.inProgress) ? (
                <Button type="button" variant="default" onClick={() => resumeInProgress(screen.inProgress)}>
                  LEVEL {screen.inProgress.level} 응시 이어가기
                </Button>
              ) : null}
              <Button
                type="button"
                variant={restoreQuizQuestions(screen.inProgress) ? "outline" : "default"}
                onClick={() => {
                  const saved = screen.inProgress;
                  const target = screen.targetLevel;
                  void discardInProgress(saved).then(() => startFreshQuiz(target));
                }}
              >
                LEVEL {screen.targetLevel} 새로 시작하기
              </Button>
              <Button type="button" variant="ghost" onClick={() => { setScreen({ name: "dashboard" }); window.scrollTo({ top: 0 }); }}>
                취소
              </Button>
            </div>
          </div>
        </div>
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
          key={screen.attemptId}
          level={screen.level}
          attemptId={screen.attemptId}
          questions={screen.questions}
          initialAnswers={screen.initialAnswers}
          initialIndex={screen.initialIndex}
          onProgressChange={handleQuizProgress}
          submitting={submitting}
          submitError={submitError}
          onRetrySubmit={retrySubmit}
          onSubmit={(answers) => finishQuiz(screen.level, screen.attemptId, screen.questions, answers, screen.startedAt)}
          onCancel={() => cancelQuiz(screen.attemptId)}
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
  inProgress: InProgressQuiz | null;
  onResumeInProgress: () => void;
  onRestartInProgress: () => void;
  onOpenLesson: (level: LearnLevelNo) => void;
  onStartQuiz: (level: LearnLevelNo) => void;
  onOpenWrongNotes: () => void;
  onOpenDiagnostic: () => void;
  onOpenCertificate: () => void;
}) {
  const { progress } = props;
  const inProgressRestorable = props.inProgress ? restoreQuizQuestions(props.inProgress) !== null : false;
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

      {props.inProgress ? (
        <section className="learn-dash-card" aria-label="진행 중인 퀴즈">
          <div className="learn-dash-progress-head">
            <h3>진행 중인 퀴즈</h3>
            <span className="learn-dash-progress-count">
              LEVEL {props.inProgress.level} · 답변 {Object.keys(props.inProgress.answers).length} / {props.inProgress.questionIds.length}
            </span>
          </div>
          {inProgressRestorable ? (
            <>
              <p className="learn-muted">
                <small>이전에 풀던 퀴즈가 저장되어 있습니다. 문제 구성과 답변은 그대로 유지됩니다.</small>
              </p>
              <div className="learn-actions learn-dash-actions">
                <Button type="button" variant="default" onClick={props.onResumeInProgress}>
                  이어서 응시하기
                </Button>
                <Button type="button" variant="outline" onClick={props.onRestartInProgress}>
                  새로 시작하기
                </Button>
              </div>
              <p className="learn-dash-note">
                <small>새로 시작하면 진행 중이던 응시는 종료되고 새 문제가 출제됩니다.</small>
              </p>
            </>
          ) : (
            <>
              <p className="learn-muted">
                <small>문제은행이 변경되어 이전 응시를 복원할 수 없습니다. 진행 중 응시를 종료하고 새로 시작할 수 있습니다.</small>
              </p>
              <div className="learn-actions learn-dash-actions">
                <Button type="button" variant="default" onClick={props.onRestartInProgress}>
                  진행 중 응시 종료하고 새로 시작하기
                </Button>
              </div>
            </>
          )}
        </section>
      ) : null}

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
