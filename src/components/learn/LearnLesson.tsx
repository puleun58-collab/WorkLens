"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { levelMeta } from "@/lib/learn/curriculum";
import { levelContent } from "@/lib/learn/content";
import type { LearnLevelNo, LearnProgress, TerminalTaskSpec } from "@/lib/learn/types";
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
  progress: LearnProgress;
  onPersistUnit: (unitId: string) => void;
  onBack: () => void;
  onStartQuiz: () => void;
}

export function LearnLesson({ level, progress, onPersistUnit, onBack, onStartQuiz }: LearnLessonProps) {
  const meta = levelMeta(level);
  const content = levelContent(level);
  const [unitIdx, setUnitIdx] = useState(() => {
    const lastId = progress.levels[level]?.lastStudiedUnitId;
    const idx = content.units.findIndex((u) => u.id === lastId);
    return idx >= 0 ? idx : 0;
  });
  const unit = content.units[unitIdx];

  const goUnit = (idx: number) => {
    if (idx < 0 || idx >= content.units.length) return;
    setUnitIdx(idx);
    onPersistUnit(content.units[idx].id);
    window.scrollTo({ top: 0 });
  };

  if (!unit) return null;

  return (
    <div>
      <Button type="button" variant="ghost" size="sm" onClick={onBack}>
        ← 학습센터로
      </Button>
      <h2>
        LEVEL {level} · {meta.title}
      </h2>
      <p className="learn-muted">{content.intro}</p>

      <nav className="learn-unit-nav" aria-label="학습 단위">
        {content.units.map((u, i) => (
          <Button
            key={u.id}
            type="button"
            variant={i === unitIdx ? "default" : "outline"}
            size="sm"
            onClick={() => goUnit(i)}
          >
            {i + 1}. {u.title}
          </Button>
        ))}
      </nav>

      <article className="learn-unit">
        <h3>
          {unitIdx + 1}. {unit.title}
        </h3>
        <p className="learn-muted">
          <small>예상 소요 {unit.estimatedMinutes}분 · 학습 목표: {unit.goal}</small>
        </p>

        <h4>핵심 개념</h4>
        <dl>
          {unit.concepts.map((c) => (
            <div className="learn-concept" key={c.term}>
              <dt>{c.term}</dt>
              <dd>{c.definition}</dd>
            </div>
          ))}
        </dl>

        <h4>왜 알아야 할까요?</h4>
        <p>{unit.whyNeeded}</p>

        <h4>실제 사용 상황</h4>
        <ul>
          {unit.usageSituations.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>

        {unit.comparisons && unit.comparisons.length > 0 ? (
          <>
            <h4>비슷한 개념과 차이</h4>
            <ul>
              {unit.comparisons.map((c, i) => (
                <li key={i}>
                  <strong>{c.a} vs {c.b}</strong> — {c.difference}
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <h4>실무 사례</h4>
        {unit.cases.map((c, i) => (
          <div className="learn-case" key={i}>
            <strong>{c.title}</strong>
            <p>{c.situation}</p>
            <p className="learn-muted">{c.lesson}</p>
          </div>
        ))}

        {unit.practice ? (
          <>
            <h4>실습 — {unit.practice.title}</h4>
            <p className="learn-muted">
              <small>실행 환경: Windows PowerShell · 실제 시스템에는 영향을 주지 않는 가상 터미널입니다. 명령어를 가상 터미널에 직접 입력해 연습해 보세요.</small>
            </p>
            <ol>
              {unit.practice.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
            {unit.practice.commands && unit.practice.commands.length > 0 ? (
              <div className="learn-surface" style={{ marginTop: 8 }}>
                <p><small className="learn-muted">명령어 예시 (복사해서 가상 터미널에 붙여넣을 수 있습니다)</small></p>
                {unit.practice.commands.map((cmd, i) => (
                  <div key={i} className="learn-command-row">
                    <code>{cmd}</code>
                    <CopyCommandButton command={cmd} />
                  </div>
                ))}
              </div>
            ) : null}
            <PracticeTerminal level={level} practiceTitle={unit.practice.title} />
          </>
        ) : null}

        <h4>자주 발생하는 실수</h4>
        {unit.mistakes.map((m, i) => (
          <div className="learn-mistake" key={i}>
            <strong>실수: {m.mistake}</strong>
            <p>왜 발생하나요? {m.why}</p>
            <p>올바른 방법: {m.fix}</p>
          </div>
        ))}

        <h4>핵심 요약</h4>
        <div className="learn-summary">
          <ul>
            {unit.summary.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      </article>

      <div className="learn-quiz-nav">
        <Button type="button" variant="outline" disabled={unitIdx === 0} onClick={() => goUnit(unitIdx - 1)}>
          이전 단위
        </Button>
        {unitIdx < content.units.length - 1 ? (
          <Button type="button" variant="default" onClick={() => goUnit(unitIdx + 1)}>
            다음 단위
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

/** 학습 중 연습용 가상 터미널 — 점수에 반영되지 않는다 */
function PracticeTerminal({ level, practiceTitle }: { level: LearnLevelNo; practiceTitle: string }) {
  const scenario: TerminalTaskSpec["scenario"] = level === 5 ? "git-basic" : "folder-nav";
  const instructions = [
    `아래 가상 터미널에서 '${practiceTitle}' 단계를 직접 연습해 보세요.`,
    "실제 시스템에는 영향을 주지 않으며, 연습 결과는 점수에 반영되지 않습니다.",
  ];
  return (
    <div style={{ marginTop: 12 }}>
      <VirtualTerminal scenario={scenario} instructions={instructions} successChecks={[]} practiceMode />
    </div>
  );
}
