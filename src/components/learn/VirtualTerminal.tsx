"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  checkTerminalSuccess,
  deserializeTerminalState,
  executeCommand,
  initialStateForScenario,
  serializeTerminalState,
  type VirtualTerminalState,
} from "@/lib/learn/terminal";
import type { TerminalStateSnapshot, TerminalSuccessCheck, TerminalTaskSpec } from "@/lib/learn/types";

interface VirtualTerminalProps {
  scenario: TerminalTaskSpec["scenario"];
  instructions: string[];
  successChecks: TerminalSuccessCheck[];
  hint?: string;
  onResult?: (passed: boolean) => void;
  /** 연습 모드: 점수에 반영되지 않음을 명시하고 완료 확인 버튼을 숨긴다 */
  practiceMode?: boolean;
  /** 복원할 실습 중간 상태 — 없으면 시나리오 초기 상태로 시작한다 */
  initialSnapshot?: TerminalStateSnapshot | null;
  /** 상태가 바뀔 때마다 저장용 스냅샷을 보고한다 */
  onSnapshotChange?: (snapshot: TerminalStateSnapshot) => void;
}

/**
 * 가상 터미널 — 실제 셸을 실행하지 않고 시뮬레이터로 동작한다.
 */
export function VirtualTerminal({ scenario, instructions, successChecks, hint, onResult, practiceMode, initialSnapshot, onSnapshotChange }: VirtualTerminalProps) {
  const [termState, setTermState] = useState<VirtualTerminalState>(() => {
    if (initialSnapshot) {
      const restored = deserializeTerminalState(initialSnapshot);
      if (restored) return restored.state;
    }
    return initialStateForScenario(scenario);
  });
  const [transcript, setTranscript] = useState<{ cmd: string; out: string[] }[]>(() => {
    if (initialSnapshot) {
      const restored = deserializeTerminalState(initialSnapshot);
      if (restored) return restored.transcript;
    }
    const initial = initialStateForScenario(scenario);
    return initial.lines.length > 0 ? [{ cmd: "", out: initial.lines }] : [];
  });
  const [input, setInput] = useState("");
  const [checked, setChecked] = useState<boolean | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  const scrollBottom = () => {
    requestAnimationFrame(() => {
      outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
    });
  };

  const run = (raw: string) => {
    const cmd = raw.trim();
    if (!cmd) return;
    const { state, output } = executeCommand(termState, cmd);
    const nextTranscript = [...transcript, { cmd, out: output }];
    setTermState(state);
    setTranscript(nextTranscript);
    setChecked(null);
    setInput("");
    onSnapshotChange?.(serializeTerminalState(state, nextTranscript));
    scrollBottom();
  };

  const check = () => {
    const { passed } = checkTerminalSuccess(termState, successChecks);
    setChecked(passed);
    onResult?.(passed);
    scrollBottom();
  };

  return (
    <div className="learn-terminal-block">
      {practiceMode ? (
        <p className="learn-muted">
          <small><strong>연습 모드</strong> — 여기서 연습한 결과는 점수에 반영되지 않습니다.</small>
        </p>
      ) : null}
      <ol className="learn-terminal-steps">
        {instructions.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <div className="learn-terminal" role="region" aria-label="가상 터미널">
        <div className="learn-terminal-output" ref={outputRef} aria-live="polite">
          {transcript.map((entry, i) => (
            <div key={i}>
              {entry.cmd ? (
                <div>
                  <span className="learn-terminal-prompt">PS {termState.cwd}&gt;</span> {entry.cmd}
                </div>
              ) : null}
              {entry.out.map((line, j) => (
                <div key={j}>{line || "\u00a0"}</div>
              ))}
            </div>
          ))}
        </div>
        <div className="learn-terminal-input-row">
          <span className="learn-terminal-prompt">PS {termState.cwd}&gt;</span>
          <input
            className="learn-terminal-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") run(input);
            }}
            aria-label="가상 터미널 명령어 입력"
            placeholder="명령어 입력 (예: help)"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </div>
      {hint ? <p className="learn-muted"><small>힌트: {hint}</small></p> : null}
      <div className="learn-actions">
        <Button type="button" variant="outline" onClick={() => run(input)} disabled={!input.trim()}>
          실행
        </Button>
        {practiceMode ? null : (
          <Button type="button" variant="default" onClick={check}>
            과제 완료 확인
          </Button>
        )}
      </div>
      {checked !== null ? (
        <p role="status" className={checked ? "learn-result-pass" : "learn-result-fail"}>
          {checked ? "과제 성공! 요구한 상태가 모두 확인되었습니다." : "아직 성공 조건을 만족하지 못했습니다. instructions를 다시 확인해 보세요."}
        </p>
      ) : null}
    </div>
  );
}
