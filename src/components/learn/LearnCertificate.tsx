"use client";

import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ALL_LEVELS, levelMeta } from "@/lib/learn/curriculum";
import { isLearningComplete } from "@/lib/learn/scoring";
import type { LearnProgress } from "@/lib/learn/types";

interface LearnCertificateProps {
  progress: LearnProgress;
  onBack: () => void;
}

/**
 * 학습 완료 및 수료증 — WorkLens 자체 교육과정 수료 증명.
 * 외부 공인 자격증이 아님을 명시한다.
 */
export function LearnCertificate({ progress, onBack }: LearnCertificateProps) {
  const complete = isLearningComplete(progress);
  const today = new Date();
  const dateStr = `${today.getFullYear()}년 ${today.getMonth() + 1}월 ${today.getDate()}일`;

  if (!complete) {
    return (
      <div className="learn-certificate-screen">
        <Button type="button" variant="ghost" size="sm" className="learn-back" onClick={onBack}>
          <ArrowLeft /> 학습센터로 돌아가기
        </Button>
        <h2>수료증</h2>
        <div className="learn-question-card">
          <p>아직 모든 단계를 통과하지 않았습니다. 10단계를 모두 통과하면 수료증이 발급됩니다.</p>
          <p className="learn-muted">
            <small>
              통과한 단계: {ALL_LEVELS.filter((l) => progress.levels[l]?.passed).length} / 10
            </small>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="learn-certificate-screen">
      <Button type="button" variant="ghost" size="sm" className="learn-back" onClick={onBack}>
        <ArrowLeft /> 학습센터로 돌아가기
      </Button>
      <div className="learn-certificate">
        <h2>수료증</h2>
        <p className="learn-muted">Certificate of Completion</p>
        <p>위 학습자가 아래 교육과정을 수료하였음을 증명합니다.</p>
        <p className="learn-cert-name">AI·AX 업무 자동화 학습센터 (LEVEL 1~10)</p>
        <p>수료일: {dateStr}</p>
        <div style={{ margin: "20px 0" }}>
          {ALL_LEVELS.map((l) => {
            const meta = levelMeta(l);
            const best = progress.levels[l]?.bestScore ?? 0;
            return (
              <p key={l} style={{ margin: "4px 0" }}>
                <small>
                  LEVEL {l} {meta.title} — {best}점 통과
                </small>
              </p>
            );
          })}
        </div>
        <p>
          <small className="learn-muted">
            본 수료증은 WorkLens 자체 교육과정 수료 증명이며, 외부 공인 자격증이 아닙니다.
          </small>
        </p>
        <div className="learn-actions" style={{ justifyContent: "center" }}>
          <Button type="button" variant="outline" onClick={() => window.print()}>
            출력하기
          </Button>
        </div>
      </div>
    </div>
  );
}
