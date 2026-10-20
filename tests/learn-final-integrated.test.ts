import { describe, expect, test } from "vitest";
import { DIAGNOSTIC_AREA_TARGETS, levelMeta } from "../src/lib/learn/curriculum";
import { levelContent } from "../src/lib/learn/content";
import { questionBank } from "../src/lib/learn/questions";
import {
  allocateDifficultyTargets,
  applyAttempt,
  deriveFirstCompletionAt,
  questionFingerprint,
  selectQuizQuestions,
} from "../src/lib/learn/scoring";
import {
  buildLearnBackup,
  parseLearnBackup,
  serializeLearnBackup,
} from "../src/lib/learn/backup";
import {
  checkTerminalSuccess,
  deserializeTerminalState,
  executeCommand,
  initialStateForScenario,
  serializeTerminalState,
} from "../src/lib/learn/terminal";
import type {
  InProgressQuiz,
  LearnLevelNo,
  LearnProgress,
  QuizAttempt,
  TerminalStateSnapshot,
} from "../src/lib/learn/types";

const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as LearnLevelNo[];

function makeAttempt(level: LearnLevelNo, finishedAt: number, passed = true, score = 90): QuizAttempt {
  return {
    attemptId: `att-${level}-${finishedAt}`,
    level,
    questionIds: [],
    answers: {},
    graded: [],
    score: passed ? score : 40,
    passed,
    startedAt: finishedAt - 1000,
    finishedAt,
  };
}

function completeProgress(completedAt?: number): LearnProgress {
  const levels: LearnProgress["levels"] = {};
  for (const l of LEVELS) {
    levels[l] = { passed: true, bestScore: 90, attempts: [makeAttempt(l, 1_000_000 + l * 1000)] };
  }
  return { version: 1, levels, wrongAnswers: [], completedAt, updatedAt: 0 };
}

describe("최초 학습 완료일", () => {
  test("전체 통과가 확정되는 응시에서 completedAt이 한 번만 기록된다", () => {
    let progress = completeProgress();
    delete progress.levels[10];
    progress = { ...progress, levels: { ...progress.levels } };
    const finalAttempt = makeAttempt(10, 2_000_000);
    const next = applyAttempt(progress, finalAttempt);
    expect(next.completedAt).toBe(2_000_000);
    // 재응시해도 최초 완료일은 유지된다
    const again = applyAttempt(next, makeAttempt(10, 3_000_000));
    expect(again.completedAt).toBe(2_000_000);
  });

  test("전체 통과가 아니면 completedAt을 기록하지 않는다", () => {
    const progress: LearnProgress = { version: 1, levels: {}, wrongAnswers: [], updatedAt: 0 };
    const next = applyAttempt(progress, makeAttempt(1, 1_000));
    expect(next.completedAt).toBeUndefined();
  });

  test("과거 기록 복원 — 단계별 최초 통과 시각 중 가장 늦은 값이 완료일이다", () => {
    const progress = completeProgress();
    // L3 최초 통과는 500_000 (이후 재응시 통과 기록이 뒤에 있음)
    progress.levels[3] = {
      passed: true,
      bestScore: 100,
      attempts: [makeAttempt(3, 500_000), makeAttempt(3, 900_000)],
    };
    expect(deriveFirstCompletionAt(progress)).toBe(1_000_000 + 10 * 1000);
  });

  test("응시 이력이 보관 한도(20회)에 닿은 단계가 있으면 복원하지 않는다", () => {
    const progress = completeProgress();
    progress.levels[5] = {
      passed: true,
      bestScore: 90,
      attempts: Array.from({ length: 20 }, (_, i) => makeAttempt(5, 100 + i)),
    };
    expect(deriveFirstCompletionAt(progress)).toBeNull();
  });

  test("미완료 기록은 복원 대상이 아니다", () => {
    const progress = completeProgress();
    progress.levels[7] = { passed: false, bestScore: 50, attempts: [] };
    expect(deriveFirstCompletionAt(progress)).toBeNull();
  });
});

describe("난이도 균형 출제", () => {
  test("allocateDifficultyTargets는 은행 비율을 출제 수에 비례 배분하고 합이 일치한다", () => {
    for (const level of LEVELS) {
      const bank = questionBank(level);
      const meta = levelMeta(level);
      const targets = allocateDifficultyTargets(bank, meta.questionCount);
      const sum = [...targets.values()].reduce((a, b) => a + b, 0);
      expect(sum).toBe(meta.questionCount);
      const bankConcept = bank.filter((q) => q.difficulty === "concept").length / bank.length;
      const targetConcept = (targets.get("concept") ?? 0) / meta.questionCount;
      expect(Math.abs(bankConcept - targetConcept)).toBeLessThan(0.15);
    }
  });

  test("LEVEL별 12개 응시 세트 — 난이도 평균이 목표 근방이고 세트 편차가 제한된다", () => {
    for (const level of LEVELS) {
      const bank = questionBank(level);
      const meta = levelMeta(level);
      const unitIds = levelContent(level).units.map((u) => u.id);
      const targets = allocateDifficultyTargets(bank, meta.questionCount);
      const sums = new Map<string, number>();
      let prev: string[] = [];
      for (let i = 0; i < 12; i++) {
        const selected = selectQuizQuestions(level, bank, `balance-${level}-${i}`, unitIds, prev);
        expect(selected.length).toBe(meta.questionCount);
        expect(new Set(selected.map((q) => q.id)).size).toBe(meta.questionCount);
        // 모든 단위에서 출제된다
        expect(new Set(selected.map((q) => q.unitId))).toEqual(new Set(unitIds));
        for (const q of selected) sums.set(q.difficulty, (sums.get(q.difficulty) ?? 0) + 1);
        for (const d of ["concept", "application", "judgment"] as const) {
          const count = selected.filter((q) => q.difficulty === d).length;
          // 단위 풀 구성상 불가피한 편차를 감안한 상한
          expect(Math.abs(count - (targets.get(d) ?? 0))).toBeLessThanOrEqual(3);
        }
        prev = selected.map((q) => q.id);
      }
      for (const d of ["concept", "application", "judgment"] as const) {
        const avg = (sums.get(d) ?? 0) / 12;
        expect(Math.abs(avg - (targets.get(d) ?? 0))).toBeLessThanOrEqual(1.2);
      }
    }
  });
});

describe("가상 터미널 상태 저장·복구", () => {
  test("직렬화 → 복원 후에도 상태와 성공 판정이 동일하다", () => {
    let state = initialStateForScenario("git-basic");
    const transcript: { cmd: string; out: string[] }[] = [];
    for (const cmd of ["git add report.txt", "git add memo.txt", 'git commit -m "보고서 정리"']) {
      const r = executeCommand(state, cmd);
      state = r.state;
      transcript.push({ cmd, out: r.output });
    }
    const checks = [
      { kind: "commit-exists", messageContains: "보고서" } as const,
    ];
    expect(checkTerminalSuccess(state, checks).passed).toBe(true);

    const snapshot = serializeTerminalState(state, transcript);
    // JSON 왕복 (실제 저장 경로와 동일)
    const revived = JSON.parse(JSON.stringify(snapshot)) as TerminalStateSnapshot;
    const restored = deserializeTerminalState(revived);
    expect(restored).not.toBeNull();
    expect(restored!.state.cwd).toBe(state.cwd);
    expect(restored!.transcript.length).toBe(3);
    // 복원된 실제 상태로 성공 조건을 다시 검증한다 (저장된 성공 여부를 믿지 않음)
    expect(checkTerminalSuccess(restored!.state, checks).passed).toBe(true);
    // 복원 후에도 이어서 명령을 실행할 수 있다
    const next = executeCommand(restored!.state, "git status");
    expect(next.output.join("\n")).toContain("On branch");
  });

  test("성공 조건을満た 못한 복원 상태는 통과로 판정되지 않는다", () => {
    const state = initialStateForScenario("git-basic");
    const snapshot = serializeTerminalState(state, []);
    const restored = deserializeTerminalState(JSON.parse(JSON.stringify(snapshot)));
    expect(restored).not.toBeNull();
    expect(
      checkTerminalSuccess(restored!.state, [{ kind: "commit-exists", messageContains: "보고서" }]).passed,
    ).toBe(false);
  });

  test("손상된 스냅샷은 복원하지 않는다", () => {
    expect(deserializeTerminalState({ cwd: 1 } as unknown as TerminalStateSnapshot)).toBeNull();
    expect(deserializeTerminalState(null as unknown as TerminalStateSnapshot)).toBeNull();
  });
});

describe("학습 기록 JSON 백업·복원", () => {
  function sampleInProgress(): InProgressQuiz {
    const bank = questionBank(4);
    const questions = bank.slice(0, 3);
    const questionChecks: Record<string, number> = {};
    const choiceOrder: Record<string, string[]> = {};
    for (const q of questions) {
      questionChecks[q.id] = questionFingerprint(q);
      if (q.choices) choiceOrder[q.id] = q.choices.map((c) => c.id);
    }
    return {
      attemptId: "att-progress-1",
      level: 4,
      startedAt: 1000,
      questionIds: questions.map((q) => q.id),
      choiceOrder,
      answers: {},
      currentIndex: 1,
      terminalStates: {},
      passScore: 80,
      questionChecks,
      savedAt: 2000,
      status: "in-progress",
    };
  }

  test("내보내기 → 가져오기 왕복 시 진도·완료일·진행 중 퀴즈가 보존된다", () => {
    const progress = completeProgress(1_700_000_000_000);
    progress.diagnostic = { answers: {}, completedAt: 123, weakAreas: ["concept"] };
    progress.levels[1] = {
      passed: true,
      bestScore: 90,
      attempts: [makeAttempt(1, 5000)],
      lastStudiedUnitId: "l1-u2",
      completedUnitIds: ["l1-u1", "l1-u2"],
    };
    const backup = buildLearnBackup(progress, sampleInProgress(), {});
    const result = parseLearnBackup(serializeLearnBackup(backup));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.progress.completedAt).toBe(1_700_000_000_000);
    expect(result.progress.levels[1]?.completedUnitIds).toEqual(["l1-u1", "l1-u2"]);
    expect(result.progress.diagnostic?.weakAreas).toEqual(["concept"]);
    expect(result.inProgress?.attemptId).toBe("att-progress-1");
    expect(result.inProgress?.currentIndex).toBe(1);
  });

  test("손상된 JSON은 거부한다", () => {
    expect(parseLearnBackup("{not json").ok).toBe(false);
    expect(parseLearnBackup("{}").ok).toBe(false);
    expect(parseLearnBackup(JSON.stringify({ format: "other", formatVersion: 1, data: {} })).ok).toBe(false);
  });

  test("지원하지 않는 백업 버전은 거부한다", () => {
    const backup = buildLearnBackup(completeProgress(), null, {});
    const text = serializeLearnBackup({ ...backup, formatVersion: 99 });
    const result = parseLearnBackup(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("버전");
  });

  test("중복 응시 ID가 있으면 거부한다 (기존 기록 보호)", () => {
    const progress = completeProgress();
    const dup = makeAttempt(1, 777);
    progress.levels[1] = { passed: true, bestScore: 90, attempts: [dup] };
    progress.levels[2] = { passed: true, bestScore: 90, attempts: [{ ...dup, level: 2 }] };
    const result = parseLearnBackup(serializeLearnBackup(buildLearnBackup(progress, null, {})));
    expect(result.ok).toBe(false);
  });

  test("잘못된 LEVEL 데이터는 거부한다", () => {
    const progress = completeProgress() as unknown as Record<string, unknown>;
    (progress.levels as Record<string, unknown>)["11"] = { passed: true, bestScore: 10, attempts: [] };
    const backup = buildLearnBackup(progress as unknown as LearnProgress, null, {});
    expect(parseLearnBackup(serializeLearnBackup(backup)).ok).toBe(false);
  });

  test("존재하지 않는 학습 항목 참조는 제외하고 경고한다", () => {
    const progress = completeProgress();
    progress.levels[1] = {
      passed: true,
      bestScore: 90,
      attempts: [makeAttempt(1, 5000)],
      lastStudiedUnitId: "l1-removed",
      completedUnitIds: ["l1-u1", "l1-removed"],
    };
    const result = parseLearnBackup(serializeLearnBackup(buildLearnBackup(progress, null, {})));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.progress.levels[1]?.lastStudiedUnitId).toBeUndefined();
    expect(result.progress.levels[1]?.completedUnitIds).toEqual(["l1-u1"]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("문제은행이 변경된 진행 중 퀴즈는 제외하고 경고한다", () => {
    const inProgress = sampleInProgress();
    inProgress.questionIds = ["l4-q999"];
    inProgress.questionChecks = { "l4-q999": 1 };
    const result = parseLearnBackup(serializeLearnBackup(buildLearnBackup(completeProgress(), inProgress, {})));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inProgress).toBeNull();
    expect(result.warnings.some((w) => w.includes("진행 중 퀴즈"))).toBe(true);
  });
});

describe("사전 진단 영역 연결", () => {
  test("모든 진단 영역의 연결 단위가 실제 커리큘럼에 존재한다", () => {
    for (const target of Object.values(DIAGNOSTIC_AREA_TARGETS)) {
      const unit = levelContent(target.level).units.find((u) => u.id === target.unitId);
      expect(unit, `${target.level}/${target.unitId}`).toBeDefined();
    }
  });
});
