"use client";

import { useEffect, useRef, useState } from "react";
import { publishLearnScreen } from "@/client/learn-screen";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Briefcase,
  Check,
  Clock3,
  GitCompare,
  Lightbulb,
  NotebookPen,
  SquareTerminal,
  Target,
  TriangleAlert,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { levelMeta } from "@/lib/learn/curriculum";
import { levelContent } from "@/lib/learn/content";
import type { LearnLevelNo, LearnProgress, TerminalStateSnapshot, TerminalTaskSpec } from "@/lib/learn/types";
import { VirtualTerminal } from "./VirtualTerminal";

/** 명령어 복사 버튼 — 클립보드 API 실패 시 폴백 */
function CopyCommandButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = command;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button type="button" variant="outline" size="sm" onClick={copy} aria-label={`${command} 복사`}>
      {copied ? "복사됨" : "복사"}
    </Button>
  );
}

interface LearnLessonProps {
  level: LearnLevelNo;
  /** 오답 노트 등에서 특정 단위로 바로 이동할 때 지정 — 유효하지 않으면 마지막 학습 단위 사용 */
  initialUnitId?: string;
  progress: LearnProgress;
  onPersistUnit: (unitId: string) => void;
  /** 학습 항목 완료 상태 변경 (완료 표시는 사용자가 명시적으로 확인한 경우에만 바뀐다) */
  onToggleUnitComplete: (unitId: string, completed: boolean) => void;
  /** 연습용 가상 터미널 상태 (공식 평가와 분리 저장) */
  practiceStates: Record<string, TerminalStateSnapshot>;
  onPracticeStateChange: (key: string, snapshot: TerminalStateSnapshot) => void;
  onBack: () => void;
  onStartQuiz: () => void;
}

export function LearnLesson({ level, initialUnitId, progress, onPersistUnit, onToggleUnitComplete, practiceStates, onPracticeStateChange, onBack, onStartQuiz }: LearnLessonProps) {
  const meta = levelMeta(level);
  const content = levelContent(level);
  const [unitIdx, setUnitIdx] = useState(() => {
    const requested = initialUnitId ? content.units.findIndex((u) => u.id === initialUnitId) : -1;
    if (requested >= 0) return requested;
    const lastId = progress.levels[level]?.lastStudiedUnitId;
    const idx = content.units.findIndex((u) => u.id === lastId);
    return idx >= 0 ? idx : 0;
  });
  const unit = content.units[unitIdx];
  const totalUnits = content.units.length;
  const passed = progress.levels[level]?.passed ?? false;
  // 학습 항목 완료 상태 — 현재 위치(lastStudiedUnitId)와 독립적으로 관리한다
  const completedUnitIds = progress.levels[level]?.completedUnitIds ?? [];
  const completedSet = new Set(completedUnitIds);
  const currentCompleted = completedSet.has(unit.id);

  const goUnit = (idx: number) => {
    if (idx < 0 || idx >= totalUnits) return;
    setUnitIdx(idx);
    onPersistUnit(content.units[idx].id);
    window.scrollTo({ top: 0 });
  };

  // 렌즈봇 화면 인식용 현재 단위 발행
  useEffect(() => {
    publishLearnScreen({ unitId: unit.id });
  }, [unit.id]);

  // 선택된 단위 버튼이 nav 안에 보이도록 (좁은 화면에서 가로 스크롤 시)
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navRef.current?.querySelector(".learn-unit-btn.is-active")?.scrollIntoView({
      block: "nearest",
      inline: "center",
      behavior: "smooth",
    });
  }, [unitIdx]);

  // 특정 단위로 바로 이동해 온 경우, 그 단위를 마지막 학습 위치로 저장한다
  const initialUnitApplied = useRef(false);
  useEffect(() => {
    if (initialUnitApplied.current) return;
    initialUnitApplied.current = true;
    if (initialUnitId && content.units.some((u) => u.id === initialUnitId)) {
      onPersistUnit(initialUnitId);
    }
    // 마운트 시 1회만 실행
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!unit) return null;

  return (
    <div className="learn-lesson">
      <Button type="button" variant="ghost" size="sm" className="learn-back" onClick={onBack}>
        <ArrowLeft /> 학습센터로 돌아가기
      </Button>

      <div className="learn-lesson-head">
        <div className="learn-lesson-title">
          <h2>
            LEVEL {level} · {meta.title}
          </h2>
          <span className={`learn-status-pill${passed ? " is-passed" : ""}`}>{passed ? "통과" : "학습 중"}</span>
        </div>
        <div className="learn-lesson-progress">
          <span className="learn-lesson-progress-text">
            {unitIdx + 1} / {totalUnits}
          </span>
          <div
            className="learn-progress-bar learn-lesson-progress-bar"
            role="progressbar"
            aria-valuenow={unitIdx + 1}
            aria-valuemin={1}
            aria-valuemax={totalUnits}
            aria-label="현재 학습 위치"
          >
            <div style={{ width: `${((unitIdx + 1) / totalUnits) * 100}%` }} />
          </div>
          <span className="learn-lesson-progress-text">
            완료한 항목 {completedUnitIds.length} / {totalUnits}
          </span>
        </div>
      </div>
      <p className="learn-muted learn-lesson-intro">{content.intro}</p>

      <nav className="learn-unit-nav" aria-label="학습 단위" ref={navRef}>
        {content.units.map((u, i) => (
          <button
            key={u.id}
            type="button"
            className={`learn-unit-btn${i === unitIdx ? " is-active" : ""}${completedSet.has(u.id) ? " is-completed" : ""}`}
            onClick={() => goUnit(i)}
            aria-current={i === unitIdx ? "true" : undefined}
            title={u.title}
          >
            {completedSet.has(u.id) ? (
              <Check className="learn-unit-done-icon" aria-label="학습 완료" />
            ) : null}
            {i + 1}. {u.shortTitle ?? u.title}
          </button>
        ))}
      </nav>

      <h3 className="learn-lesson-unit-title">
        {unitIdx + 1}. {unit.title}
      </h3>
      <p className="learn-lesson-meta">
        <span>
          <Clock3 /> 예상 소요 {unit.estimatedMinutes}분
        </span>
        <span>
          <Target /> 학습 목표: {unit.goal}
        </span>
      </p>

      <section className="learn-card" aria-label="핵심 개념">
        <h4 className="learn-card-title">
          <BookOpen /> 핵심 개념
        </h4>
        <div className="learn-card-body">
          {unit.concepts.length > 0 ? (
            <p className="learn-concept-lead">
              <strong>{unit.concepts[0].term}</strong> — {unit.concepts[0].definition}
            </p>
          ) : null}
          {unit.concepts.length > 1 ? (
            <ul className="learn-bullet-list">
              {unit.concepts.slice(1).map((c) => (
                <li key={c.term}>
                  <strong>{c.term}</strong> — {c.definition}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      <section className="learn-card" aria-label="왜 알아야 할까요?">
        <h4 className="learn-card-title">
          <Lightbulb /> 왜 알아야 할까요?
        </h4>
        <div className="learn-card-body">
          <p>{unit.whyNeeded}</p>
        </div>
      </section>

      <section className="learn-card" aria-label="실제 사용 상황">
        <h4 className="learn-card-title">
          <Users /> 실제 사용 상황
        </h4>
        <div className="learn-card-body">
          <ul className="learn-check-list">
            {unit.usageSituations.map((s, i) => (
              <li key={i}>
                <span className="learn-check" aria-hidden="true">
                  <Check />
                </span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {unit.comparisons && unit.comparisons.length > 0 ? (
        <section className="learn-card" aria-label="비슷한 개념과 차이">
          <h4 className="learn-card-title">
            <GitCompare /> 비슷한 개념과 차이
          </h4>
          <div className="learn-card-body">
            <ul className="learn-bullet-list">
              {unit.comparisons.map((c, i) => (
                <li key={i}>
                  <strong>
                    {c.a} vs {c.b}
                  </strong>{" "}
                  — {c.difference}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {unit.cases && unit.cases.length > 0 ? (
        <section className="learn-card" aria-label="실무 사례">
          <h4 className="learn-card-title">
            <Briefcase /> 실무 사례
          </h4>
          <div className="learn-card-body">
            {unit.cases.map((c, i) => (
              <div className="learn-case-block" key={i}>
                <p className="learn-case-title">{c.title}</p>
                <p>{c.situation}</p>
                <p className="learn-muted">{c.lesson}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {unit.practice ? (
        <section className="learn-card" aria-label={`실습 — ${unit.practice.title}`}>
          <h4 className="learn-card-title">
            <SquareTerminal /> 실습 — {unit.practice.title}
          </h4>
          <div className="learn-card-body">
            <p className="learn-muted">
              <small>
                실행 환경: Windows PowerShell · 실제 시스템에는 영향을 주지 않는 가상 터미널입니다. 명령어를
                가상 터미널에 직접 입력해 연습해 보세요.
              </small>
            </p>
            <ol>
              {unit.practice.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
            {unit.practice.commands && unit.practice.commands.length > 0 ? (
              <div className="learn-command-box">
                <p>
                  <small className="learn-muted">명령어 예시 (복사해서 가상 터미널에 붙여넣을 수 있습니다)</small>
                </p>
                {unit.practice.commands.map((cmd, i) => (
                  <div key={i} className="learn-command-row">
                    <code>{cmd}</code>
                    <CopyCommandButton command={cmd} />
                  </div>
                ))}
              </div>
            ) : null}
            <PracticeTerminal
              level={level}
              unitId={unit.id}
              practiceTitle={unit.practice.title}
              practiceStates={practiceStates}
              onPracticeStateChange={onPracticeStateChange}
            />
          </div>
        </section>
      ) : null}

      <section className="learn-card learn-card-danger" aria-label="자주 발생하는 실수">
        <h4 className="learn-card-title">
          <TriangleAlert /> 자주 발생하는 실수
        </h4>
        <div className="learn-card-body">
          <div className="learn-mistake-grid">
            {unit.mistakes.map((m, i) => (
              <div className="learn-mistake-card" key={i}>
                <p className="learn-mistake-title">실수: {m.mistake}</p>
                <p>{m.why}</p>
                <p>
                  <strong>올바른 방법:</strong> {m.fix}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="learn-card learn-card-info" aria-label="핵심 요약">
        <h4 className="learn-card-title">
          <NotebookPen /> 핵심 요약
        </h4>
        <div className="learn-card-body">
          <ul className="learn-bullet-list">
            {unit.summary.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      </section>

      <div className="learn-unit-complete-row">
        <span className={currentCompleted ? "learn-unit-complete-status is-done" : "learn-unit-complete-status"}>
          {currentCompleted ? "이 항목의 학습을 완료했습니다" : "아직 완료로 표시하지 않은 항목입니다"}
        </span>
        <Button
          type="button"
          variant="outline"
          onClick={() => onToggleUnitComplete(unit.id, !currentCompleted)}
          aria-pressed={currentCompleted}
        >
          {currentCompleted ? "완료 취소" : "학습 완료로 표시"}
        </Button>
      </div>

      <div className="learn-quiz-nav">
        <Button type="button" variant="outline" disabled={unitIdx === 0} onClick={() => goUnit(unitIdx - 1)}>
          <ArrowLeft /> 이전
        </Button>
        {unitIdx < totalUnits - 1 ? (
          <Button type="button" variant="default" onClick={() => goUnit(unitIdx + 1)}>
            다음 <ArrowRight />
          </Button>
        ) : (
          <Button type="button" variant="default" onClick={onStartQuiz}>
            퀴즈 응시하기
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * 학습 중 연습용 가상 터미널 — 점수에 반영되지 않는다.
 * 연습 상태는 공식 평가와 분리해 저장하고, 다시 열면 이어서 연습할 수 있다.
 */
function PracticeTerminal({
  level,
  unitId,
  practiceTitle,
  practiceStates,
  onPracticeStateChange,
}: {
  level: LearnLevelNo;
  unitId: string;
  practiceTitle: string;
  practiceStates: Record<string, TerminalStateSnapshot>;
  onPracticeStateChange: (key: string, snapshot: TerminalStateSnapshot) => void;
}) {
  // l5-u4 실습(원격 변경 가져오기)은 원격보다 뒤처진 저장소 상태에서 시작해야 지시대로 수행할 수 있다
  const scenario: TerminalTaskSpec["scenario"] =
    level === 5 ? (unitId === "l5-u4" ? "git-remote" : "git-basic") : "folder-nav";
  const stateKey = `${level}:${unitId}`;
  const instructions = [
    `아래 가상 터미널에서 '${practiceTitle}' 단계를 직접 연습해 보세요.`,
    "실제 시스템에는 영향을 주지 않으며, 연습 결과는 점수에 반영되지 않습니다.",
  ];
  return (
    <div style={{ marginTop: 12 }}>
      <VirtualTerminal
        key={stateKey}
        scenario={scenario}
        instructions={instructions}
        successChecks={[]}
        practiceMode
        initialSnapshot={practiceStates[stateKey] ?? null}
        onSnapshotChange={(snapshot) => onPracticeStateChange(stateKey, snapshot)}
      />
    </div>
  );
}
