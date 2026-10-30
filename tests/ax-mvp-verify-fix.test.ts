import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildAllInOnePrompt, buildFixPrompt, type AxVerificationInput } from "../src/lib/ax/guide";
import { executionProfile } from "../src/lib/ax/policy";
import { exportAxState, importAxState, migrateAxState, validateAxStateV2 } from "../src/lib/ax/transfer";
import { extractReviewableItems, type ReviewableItem } from "../src/lib/ax/hitl";
import type { AxDiagnosis, HitlReview, VerificationResult } from "../src/lib/ax/types";
import { diagnosisFixture, planFixture, taskFixture } from "./fixtures/ax";

const optionsFor = (diagnosis: AxDiagnosis = diagnosisFixture) => {
  const profile = executionProfile(diagnosis);
  return {
    taskName: "업무 task-1",
    prerequisites: profile.prerequisites,
    diagnosis,
    context: "매월 입력 표를 취합하고 담당자가 최종 승인합니다.",
  };
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
/** "## N. 제목" 헤더로 나눈 뒤 제목으로 섹션 본문을 찾는다. */
const sectionOf = (prompt: string, title: string) => {
  const parts = prompt.split(/^## \d+\. /mu).slice(1);
  const found = parts.find(part => part.startsWith(title));
  return found ? found.slice(title.length) : "";
};
const fixOptions = (overrides: Partial<Parameters<typeof buildFixPrompt>[1]> = {}) => ({ ...optionsFor(), ...overrides });

const PROHIBITED_AFFIRMATIVE = [
  "처음부터 다시 작성하세요",
  "기대 결과를 하드코딩하세요",
  "보류 항목을 구현하세요",
  "제외 항목을 구현하세요",
  "실행 증거 없이 해결 완료로 판정하세요",
  "완료로 표시하세요",
];
const REQUIRED_GUARDS = [
  "실행 증거 없이 해결 완료로 판정하지 마세요",
  "HTTP 200 응답이나 빌드 성공만으로 업무 기능이 통과했다고 표시하지 마세요",
  "해결 확인 / 일부 해결 / 미해결 / 미검증",
  "사용자 승인 없이 운영 배포하지 마세요",
  "AI가 대신 확정·승인하지 마세요",
  "같은 수정을 무한히 반복하지 마세요",
  "사용자 제공 내용과 다르면 실제 실행 결과를 우선해 보고하세요",
];

describe("ax mvp verify-fix: 04 invariance", () => {
  it("pins the representative 04 prompt byte-identical for codex and claude", () => {
    const options = optionsFor();
    const codex = buildAllInOnePrompt(planFixture, "codex", options);
    const claude = buildAllInOnePrompt(planFixture, "claude", options);
    expect(codex).toBe(claude);
    expect(codex.length).toBe(9960);
    expect(sha(codex)).toBe("077504cf05cc26251cc3c7b81c1e098015d033baa3b50d785f8bcfbe9efad3dc");
  });

  it("keeps 04 identical with empty and with present verification input, without mutating inputs", () => {
    const options = optionsFor();
    const diagnosisBefore = structuredClone(diagnosisFixture);
    const planBefore = structuredClone(planFixture);
    const inputBefore: AxVerificationInput = {
      failures: [{ feature: "자료 수집", expected: "합계 1,000", actual: "합계 950", error: "오류 없음", reproduction: "월말 표 입력" }],
      keptFeatures: ["형식 검증"],
      reportedAt: "2026-10-30T08:00:00.000Z",
    };
    const inputSnapshot = structuredClone(inputBefore);
    const before04 = buildAllInOnePrompt(planFixture, "codex", options);
    const fix = buildFixPrompt(planFixture, fixOptions(), inputBefore);
    expect(fix).toContain("자료 수집");
    const after04 = buildAllInOnePrompt(planFixture, "codex", options);
    expect(after04).toBe(before04);
    expect(sha(after04)).toBe("077504cf05cc26251cc3c7b81c1e098015d033baa3b50d785f8bcfbe9efad3dc");
    expect(before04).not.toContain("수정·보완 지시문");
    expect(before04).not.toContain("수정 대상 아님");
    expect(before04).not.toContain("반복 실패 확인 대상");
    expect(diagnosisFixture).toEqual(diagnosisBefore);
    expect(planFixture).toEqual(planBefore);
    expect(inputBefore).toEqual(inputSnapshot);
    expect(buildFixPrompt(planFixture, fixOptions(), { failures: [] })).toContain("수정 대상이 없습니다");
    expect(buildAllInOnePrompt(planFixture, "claude", options)).toBe(before04);
  });

  it("returns a blocked notice instead of a fix prompt when the gate is blocked", () => {
    const blocked = { ...diagnosisFixture, decisionGate: { verdict: "no-go" as const, reasons: ["권한 확인"] } };
    const prompt = buildFixPrompt(planFixture, fixOptions({ diagnosis: blocked }), {
      failures: [{ feature: "자료 수집", expected: "합계 1,000", actual: "합계 950" }],
    });
    expect(prompt).toContain("구현 계획 생성이 차단되어 수정·보완 지시문을 만들 수 없습니다");
    expect(prompt).toContain("권한 확인");
    expect(prompt).not.toContain("수정 대상");
  });
});

describe("ax mvp verify-fix: ten verification cases", () => {
  const cases: Array<{ name: string; input: AxVerificationInput; targets: string[]; keeps: string[]; extra: string[] }> = [
    {
      name: "(1) 정상+실패 기능 혼합",
      input: { failures: [{ feature: "자료 수집", expected: "입력 표 전수 취합", actual: "일부 행 누락", error: "누락 행 식별 불가", reproduction: "월말 표 입력 후 취합 실행" }], keptFeatures: ["형식 검증"] },
      targets: ["자료 수집", "입력 표 전수 취합", "일부 행 누락", "누락 행 식별 불가", "월말 표 입력 후 취합 실행"],
      keeps: ["형식 검증"],
      extra: [],
    },
    {
      name: "(2) 일부 입력에서만 오류",
      input: { failures: [{ feature: "형식 검증", expected: "모든 행 형식 통과", actual: "2번째 행에서만 오류", reproduction: "입력 표 3건 중 2번째 행에 공백 포함" }] },
      targets: ["형식 검증", "입력 표 3건 중 2번째 행에 공백 포함"],
      keeps: [],
      extra: [],
    },
    {
      name: "(3) 계산 결과가 기대값과 다름",
      input: { failures: [{ feature: "자료 수집", expected: "합계 1,000", actual: "합계 950" }] },
      targets: ["합계 1,000", "합계 950"],
      keeps: [],
      extra: [],
    },
    {
      name: "(4) 출력 컬럼 누락",
      input: { failures: [{ feature: "검토용 표", expected: "컬럼: 일자, 금액", actual: "금액 컬럼 없음" }] },
      targets: ["컬럼: 일자, 금액", "금액 컬럼 없음"],
      keeps: [],
      extra: [],
    },
    {
      name: "(5) 예외 처리 미구현",
      input: { failures: [{ feature: "형식 검증", expected: "빈 입력 시 안내 메시지", actual: "빈 입력 시 프로그램 종료" }] },
      targets: ["빈 입력 시 안내 메시지", "빈 입력 시 프로그램 종료"],
      keeps: [],
      extra: [],
    },
    {
      name: "(6) 핵심 기능 자체 미구현",
      input: { failures: [{ feature: "자료 수집", expected: "입력 표 자동 취합", actual: "기능이 구현되지 않음" }] },
      targets: ["자료 수집", "기능이 구현되지 않음"],
      keeps: [],
      extra: [],
    },
    {
      name: "(7) 업무 규칙 미확정",
      input: { failures: [{ feature: "자료 수집", expected: "할인율 적용 후 합계", actual: "할인율 미적용 합계" }], unconfirmedRules: ["할인율 적용 기준"] },
      targets: ["할인율 적용 후 합계", "할인율 미적용 합계"],
      keeps: [],
      extra: ["할인율 적용 기준", "사용자 확인 필요 항목", "임의로 확정하지 말고"],
    },
    {
      name: "(8) 오류 로그 없이 결과 차이만 제공",
      input: { failures: [{ feature: "자료 수집", expected: "합계 1,000", actual: "합계 950" }] },
      targets: ["합계 1,000", "합계 950"],
      keeps: [],
      extra: ["사용자 제공 없음 — 에이전트가 직접 재현·확인", "확인 사실과 미확정 원인을 구분"],
    },
    {
      name: "(9) 코드 접근 불가",
      input: { failures: [{ feature: "자료 수집", expected: "합계 1,000", actual: "합계 950" }] },
      targets: [],
      keeps: [],
      extra: ["사용자 제공 없음 — 저장소에서 구현 상태와 코드 버전을 직접 확인하세요", "구체적인 코드 수정이 완료됐다고 주장하지 마세요"],
    },
    {
      name: "(10) 검증 결과 일부만 확보",
      input: { failures: [{ feature: "자료 수집", actual: "합계 950" }], testRunFailure: "테스트 환경 접속 실패" },
      targets: ["합계 950"],
      keeps: [],
      extra: ["환경 문제와 기능 오류를 구분", "사용자 제공 없음 — 에이전트가 직접 재현·확인"],
    },
  ];
  it.each(cases.map(c => [c.name, c] as const))("%s separates fix targets from kept features", (_name, c) => {
    const prompt = buildFixPrompt(planFixture, fixOptions(), c.input);
    const targetSection = sectionOf(prompt, "수정 대상");
    const keepSection = sectionOf(prompt, "유지할 정상 기능");
    for (const text of c.targets) expect(targetSection).toContain(text);
    for (const text of c.keeps) {
      expect(keepSection).toContain(text);
      expect(targetSection).not.toContain(text);
    }
    for (const text of c.extra) expect(prompt).toContain(text);
    for (const banned of PROHIBITED_AFFIRMATIVE) expect(prompt).not.toContain(banned);
    for (const guard of REQUIRED_GUARDS) expect(prompt).toContain(guard);
    expect(prompt).toContain("이전 실패 항목이 해결됐는지");
    expect(prompt).toContain("변경된 입력에서도 기존 업무 규칙을 준수하는지");
    expect(prompt).toContain("기존 정상 기능이 유지되는지");
    expect(prompt).toContain("신규 오류가 없는지");
    expect(prompt).toContain("미구현·미검증 항목이 남아 있는지");
  });

  it("marks deferred and excluded items as not fix targets", () => {
    const stepItem: ReviewableItem | undefined = extractReviewableItems(diagnosisFixture)
      .find(item => item.type === "step" && item.text.startsWith("자료 수집:"));
    expect(stepItem).toBeDefined();
    const deferReview: HitlReview = {
      id: "review-defer-1",
      target: { type: stepItem!.type, key: stepItem!.key, source: stepItem!.source, sourceText: stepItem!.text, sourceHash: stepItem!.sourceHash },
      action: "defer",
      status: "confirmed",
      reason: "권한 확인 전",
      resumeCondition: "권한 확인 후",
      reviewedAt: "2026-10-30T08:00:00.000Z",
      updatedAt: "2026-10-30T08:00:00.000Z",
    };
    const prompt = buildFixPrompt(planFixture, fixOptions({ hitlReviews: [deferReview], hitlTool: "codex" }), {
      failures: [
        { feature: "자료 수집", expected: "합계 1,000", actual: "합계 950" },
        { feature: "자동 승인", expected: "자동 승인 없음", actual: "자동 승인됨" },
        { feature: "형식 검증", expected: "형식 통과", actual: "형식 오류" },
      ],
    });
    const targetSection = sectionOf(prompt, "수정 대상");
    const notTargetSection = sectionOf(prompt, "수정 대상 아님");
    expect(targetSection).toContain("형식 검증");
    expect(targetSection).not.toContain("자료 수집");
    expect(targetSection).not.toContain("자동 승인");
    expect(notTargetSection).toContain("자료 수집");
    expect(notTargetSection).toContain("자동 승인");
    expect(notTargetSection).toContain("권한 확인 전");
    expect(notTargetSection).toContain("권한 확인 후");
  });

  it("distinguishes repeat failures from new failures across rounds", () => {
    const prompt = buildFixPrompt(planFixture, fixOptions(), {
      failures: [
        { feature: "자료 수집", expected: "합계 1,000", actual: "합계 950" },
        { feature: "검토용 표", expected: "컬럼: 일자, 금액", actual: "금액 컬럼 없음" },
      ],
      reportedAt: "2026-10-30T09:00:00.000Z",
      previousReportedAt: "2026-10-30T08:00:00.000Z",
      previousFailureNames: ["자료 수집"],
    });
    expect(prompt).toContain("이번 라운드 보고 일시: 2026-10-30T09:00:00.000Z");
    expect(prompt).toContain("이전 라운드 보고 일시: 2026-10-30T08:00:00.000Z");
    expect(prompt).toContain("반복 실패 확인 대상: 이전 라운드에도 보고된 문제입니다");
    expect(prompt).toContain("신규 실패: 이전 라운드에 없던 문제입니다");
    expect(prompt).toContain("불필요하게 다시 수정하지 마세요");
    expect(prompt).toContain("최초 구현 결과와 수정 후 결과를 혼동하지 마세요");
  });

  it("warns on D5 outside the confirmed D4 list and quotes a valid D5 state", () => {
    const invalid = {
      ...diagnosisFixture,
      decisionPoints: [
        { id: "D4" as const, status: "확정" as const, detail: "접수, 검토, 완료" },
        { id: "D5" as const, status: "확정" as const, detail: "미분류" },
      ],
    };
    const invalidPrompt = buildFixPrompt(planFixture, fixOptions({ diagnosis: invalid }), {
      failures: [{ feature: "자료 수집", expected: "합계 1,000", actual: "합계 950" }],
    });
    expect(invalidPrompt).toContain("확정 결과 상태 목록(D4): 접수 · 검토 · 완료");
    expect(invalidPrompt).toContain("D4 확정 목록에 없는 상태명이므로 유효하지 않습니다");
    expect(invalidPrompt).toContain("판정 불가 행은 보류로 두고");
    const valid = {
      ...diagnosisFixture,
      decisionPoints: [
        { id: "D4" as const, status: "확정" as const, detail: "접수, 검토, 완료" },
        { id: "D5" as const, status: "확정" as const, detail: "검토" },
      ],
    };
    const validPrompt = buildFixPrompt(planFixture, fixOptions({ diagnosis: valid }), {
      failures: [{ feature: "자료 수집", expected: "합계 1,000", actual: "합계 950" }],
    });
    expect(validPrompt).toContain("판정 불가 행은 D5 확정 상태 '검토'로 보내세요");
    expect(validPrompt).not.toContain("유효하지 않습니다");
  });
});

describe("ax mvp verify-fix: schema compatibility", () => {
  const round: VerificationResult = {
    reportedAt: "2026-10-30T08:00:00.000Z",
    failures: [{ feature: "자료 수집", expected: "합계 1,000", actual: "합계 950" }],
    keptFeatures: ["형식 검증"],
  };
  it("accepts legacy v2 tasks without verificationResults and round-trips new rounds", () => {
    const legacy = validateAxStateV2({
      schemaVersion: 2,
      tasks: [taskFixture("task-1", diagnosisFixture)],
      selectedTaskId: "task-1",
      step: 4,
    });
    expect((legacy.tasks[0] as { verificationResults?: unknown }).verificationResults).toBeUndefined();
    const withRound = validateAxStateV2({
      schemaVersion: 2,
      tasks: [{ ...taskFixture("task-1", diagnosisFixture), verificationResults: [round] }],
      selectedTaskId: "task-1",
      step: 4,
    });
    const restored = importAxState(exportAxState(withRound));
    expect(restored.tasks[0].verificationResults).toEqual([round]);
  });

  it("migrates v1 states without inventing verification records", () => {
    const migrated = migrateAxState({ schemaVersion: 1, tasks: [taskFixture("task-1")], selectedTaskId: "task-1", step: 1 });
    expect(migrated.schemaVersion).toBe(2);
    expect((migrated.tasks[0] as { verificationResults?: unknown }).verificationResults).toBeUndefined();
    expect(() => validateAxStateV2(migrated)).not.toThrow();
  });
});
