"use client";

import { ArrowLeft, CalendarDays, CheckCircle2, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ALL_LEVELS } from "@/lib/learn/curriculum";
import { deriveFirstCompletionAt, isLearningComplete } from "@/lib/learn/scoring";
import type { LearnProgress } from "@/lib/learn/types";

interface LearnCompletionProps {
  progress: LearnProgress;
  onBack: () => void;
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/**
 * 학습 완료 확인 화면 — 수료증 발급이 아니라, LEVEL 1~10 전체 통과 사실과
 * 최초 완료일을 간결하게 확인하는 화면이다.
 * 최초 완료일은 실제 저장된 값을 우선하고, 없는 과거 기록은 응시 이력에서
 * 신뢰성 있게 복원할 수 있을 때만 표시한다 (임의 날짜를 만들지 않는다).
 */
export function LearnCompletion({ progress, onBack }: LearnCompletionProps) {
  const complete = isLearningComplete(progress);
  const passedCount = ALL_LEVELS.filter((l) => progress.levels[l]?.passed).length;
  const completedAt = progress.completedAt ?? deriveFirstCompletionAt(progress) ?? undefined;

  if (!complete) {
    return (
      <div className="learn-completion-screen">
        <Button type="button" variant="ghost" size="sm" className="learn-back" onClick={onBack}>
          <ArrowLeft /> 학습센터로 돌아가기
        </Button>
        <h2>학습 완료 확인</h2>
        <div className="learn-question-card">
          <p>아직 모든 단계를 통과하지 않았습니다. LEVEL 1~10을 모두 통과하면 학습 완료를 확인할 수 있습니다.</p>
          <p className="learn-muted">
            <small>통과한 단계: {passedCount} / 10</small>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="learn-completion-screen">
      <Button type="button" variant="ghost" size="sm" className="learn-back" onClick={onBack}>
        <ArrowLeft /> 학습센터로 돌아가기
      </Button>
      <div className="learn-completion">
        <div className="learn-completion-icon" aria-hidden="true">
          <CheckCircle2 />
        </div>
        <h2>모든 학습을 완료했습니다</h2>
        <p className="learn-muted">AI·AX 학습센터 LEVEL 1~10의 모든 단계를 통과했습니다.</p>
        <div className="learn-completion-stats">
          <div className="learn-completion-stat">
            <Layers aria-hidden="true" />
            <div>
              <span className="learn-completion-stat-label">완료 단계</span>
              <strong>10 / 10</strong>
            </div>
          </div>
          <div className="learn-completion-stat">
            <CalendarDays aria-hidden="true" />
            <div>
              <span className="learn-completion-stat-label">최초 완료일</span>
              <strong>{completedAt !== undefined ? formatDate(completedAt) : "최초 완료일 확인 불가"}</strong>
            </div>
          </div>
        </div>
        <p className="learn-completion-note">
          학습을 완료한 후에도 언제든 다시 학습하고 퀴즈에 응시할 수 있습니다.
        </p>
        <div className="learn-actions" style={{ justifyContent: "center" }}>
          <Button type="button" variant="default" onClick={onBack}>
            학습센터로 돌아가기
          </Button>
        </div>
      </div>
    </div>
  );
}
