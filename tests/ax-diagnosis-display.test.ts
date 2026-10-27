import { describe, expect, test } from "vitest";
import { diagnosisCheckItems, diagnosisSummaryParts, diagnosisSummarySentences, matrixRationaleBullets, visibleDiagnosisCheckItems } from "../src/components/ax/AxReport";
import { LEVEL_DESCRIPTIONS, LEVEL_LABELS, levelDisplayLabel } from "../src/lib/ax/policy";
import { outputFixture } from "./fixtures/ax";

describe("diagnosis display helpers", () => {
  test("summary sentences use only real data, max 3", () => {
    const d = { ...outputFixture(), sourceNote: "test" };
    const sentences = diagnosisSummarySentences(d);
    expect(sentences.length).toBeGreaterThan(0);
    expect(sentences.length).toBeLessThanOrEqual(3);
    for (const s of sentences) expect(s.trim().length).toBeGreaterThan(0);
  });
  test("summary reflects blocked gate truthfully", () => {
    const d = { ...outputFixture(), sourceNote: "test", decisionGate: { verdict: "no-go" as const, reasons: ["필수 시스템 접근 불가"] } };
    const sentences = diagnosisSummarySentences(d);
    expect(sentences.join(" ")).toContain("진행 보류");
  });
  test("check items dedupe same topic, keep independent conditions", () => {
    const d = { ...outputFixture(), sourceNote: "test" };
    const base = { ...d, decisionGate: { verdict: "go" as const, reasons: [] as string[] } };
    const withDupes = {
      ...base,
      technicalChecks: [
        { topic: "API 연동 여부", status: "확인 필요" as const, note: "" },
        { topic: "api 연동 여부", status: "확인 필요" as const, note: "" },
        { topic: "API 접근 권한", status: "확인 필요" as const, note: "" },
      ],
    };
    const items = diagnosisCheckItems(withDupes);
    expect(items.map(i => i.title)).toEqual(["API 연동 여부", "API 접근 권한"]);
    expect(items.every(i => i.kind === "need" && i.badge === "확인 필요")).toBe(true);
  });
  test("summary is structured as verdict distribution, human steps, pending count", () => {
    const d = { ...outputFixture(), sourceNote: "test" };
    const sentences = diagnosisSummarySentences(d);
    // 픽스처: 자동화 1 · AI 보조 1 · 사람 유지 1, 미확인 기술 확인 1건
    expect(sentences[0]).toBe("전체 3개 업무 단계 중 자동화 적합 1개 · AI 보조 적합 1개 · 담당자 수행 1개로 판정되었습니다.");
    // 사람 유지 단계는 수행으로, 명시된 승인 지점(humanInLoop)은 승인으로 구분해 표시한다.
    expect(sentences[1]).toBe("담당자 승인 단계는 담당자가 직접 수행해야 합니다. 담당자 최종 승인 지점에서는 담당자 승인이 필요합니다.");
    expect(sentences.join(" ")).not.toContain("판단·승인이 필요합니다");
    expect(sentences[2]).toBe("구현 전 확인 1건");
    // Level·Gate 문장은 배지와 중복되므로 요약에 반복하지 않는다.
    expect(sentences.join(" ")).not.toContain("확인 후 진행 상태로");
    expect(sentences.join(" ")).not.toContain("진행 가능 상태입니다");
  });
  test("summary separates perform, review and approval roles without inventing approval duties", () => {
    const base = { ...outputFixture(), sourceNote: "test" };
    const step = (name: string, verdict: "자동화" | "AI 보조" | "사람 유지") => ({ step: name, verdict, owner: "사용자" as const, note: "" });
    // 수행만 존재: 승인·검토 문구를 만들지 않는다.
    const performOnly = diagnosisSummarySentences({ ...base, stepAssessments: [step("자료 수집", "자동화"), step("현장 확인", "사람 유지")], humanInLoop: [] });
    expect(performOnly[1]).toBe("현장 확인 단계는 담당자가 직접 수행해야 합니다.");
    expect(performOnly.join(" ")).not.toContain("승인이 필요합니다");
    expect(performOnly.join(" ")).not.toContain("검토가 필요합니다");
    // 검토 지점만 명시: 승인으로 단정하지 않는다.
    const reviewOnly = diagnosisSummarySentences({ ...base, stepAssessments: [], humanInLoop: ["담당자 최종 검토"] });
    expect(reviewOnly[0]).toBe("담당자 최종 검토 지점에서는 담당자 검토가 필요합니다.");
    expect(reviewOnly.join(" ")).not.toContain("승인이 필요합니다");
    // 승인 지점만 명시.
    const approvalOnly = diagnosisSummarySentences({ ...base, stepAssessments: [], humanInLoop: ["정산 승인"] });
    expect(approvalOnly[0]).toBe("정산 승인 지점에서는 담당자 승인이 필요합니다.");
    // 검토·승인 복합 지점.
    const mixed = diagnosisSummarySentences({ ...base, stepAssessments: [], humanInLoop: ["안전조치 확인", "허가 승인"] });
    expect(mixed[0]).toBe("안전조치 확인 지점에서는 담당자 검토가 필요합니다. 허가 승인 지점에서는 담당자 승인이 필요합니다.");
    // 수행·검토·승인 복합: 세 절이 한 문장 슬롯에 담기고 확인 사항 문장이 밀려나지 않는다.
    const composite = diagnosisSummarySentences({ ...base, stepAssessments: [step("예외 처리", "사람 유지")], humanInLoop: ["갱신 여부 판단", "담당자 최종 승인"] });
    expect(composite).toHaveLength(3);
    expect(composite[1]).toBe("예외 처리 단계는 담당자가 직접 수행해야 합니다. 갱신 여부 판단 지점에서는 담당자 검토가 필요합니다. 담당자 최종 승인 지점에서는 담당자 승인이 필요합니다.");
    expect(composite[2]).toBe("구현 전 확인 1건");
  });
  test("summary marks needs-check verdicts as provisional and counts questions when no checks pend", () => {
    const base = { ...outputFixture(), sourceNote: "test" };
    const d = {
      ...base,
      informationSufficiency: "needs-check" as const,
      followUpQuestions: ["입력 자료 형식을 알려주세요."],
      technicalChecks: [{ topic: "시스템 접근", status: "확인됨" as const, note: "확인" }],
    };
    const sentences = diagnosisSummarySentences(d);
    expect(sentences[0]).toContain("잠정 판정");
    expect(sentences[sentences.length - 1]).toBe("구현 전에 추가 질문 1건에 대한 답변이 필요합니다.");
  });
  test("summary parts split the same content into verdict, human and check without new facts", () => {
    const d = { ...outputFixture(), sourceNote: "test" };
    const parts = diagnosisSummaryParts(d);
    const sentences = diagnosisSummarySentences(d);
    expect(parts.verdict).toBe("전체 3개 업무 단계 중 자동화 적합 1개 · AI 보조 적합 1개 · 담당자 수행 1개");
    expect(parts.verdictSentence).toBe(sentences[0]);
    expect(parts.human).toBe(sentences[1]);
    expect(parts.check).toBe(sentences[2]);
    // 차단 상태에서는 확인 필요 자리에 보류·재진단 문장이 그대로 온다.
    const blocked = diagnosisSummaryParts({ ...d, decisionGate: { verdict: "no-go" as const, reasons: ["필수 시스템 접근 불가"] } });
    expect(blocked.check).toBe("현재 진행 보류 상태로, 차단 사유를 해결한 뒤 재진단이 필요합니다.");
    // 미확인 항목도 추가 질문도 없으면 확인 필요는 비어 있다 (화면에서 "없음"으로 표시).
    const clear = diagnosisSummaryParts({ ...d, technicalChecks: [{ topic: "시스템 접근", status: "확인됨" as const, note: "" }], followUpQuestions: [] });
    expect(clear.check).toBeUndefined();
  });
  // TO-BE 단계의 미확정 확인 안내는 렌더링 경로 자체가 제거됐다. 해당 연결
  // 로직(toBeStepCheckTopics)은 삭제됐으며, 구조 단언은 tests/ax-tobe-menu.test.ts에서
  // 소스·CSS·렌더링 결과로 함께 검증한다. 확인 데이터 자체는 아래 불변성 테스트에서 다룬다.
  test("visible check items hide only question-covered topics and keep independent, done and distinct topics", () => {
    const base = { ...outputFixture(), sourceNote: "test", decisionGate: { verdict: "go" as const, reasons: [] as string[] } };
    const d = {
      ...base,
      followUpQuestions: ["웹사이트 접근 권한을 알려주세요.", "API 제공 여부를 알려주세요."],
      technicalChecks: [
        { topic: "웹사이트 접근 권한", status: "확인 필요" as const, note: "로그인 권한" },
        { topic: "API 제공 여부", status: "확인 필요" as const, note: "" },
        { topic: "API 접근 권한", status: "확인 필요" as const, note: "제공 여부와 별개" },
        { topic: "보고서 양식", status: "확인 필요" as const, note: "독립 확인사항" },
        { topic: "시스템 접근", status: "확인됨" as const, note: "조회 권한 확인" },
      ],
    };
    const visible = visibleDiagnosisCheckItems(d);
    expect(visible.map(i => i.title)).toEqual(["API 접근 권한", "보고서 양식", "시스템 접근"]);
    // 원본 항목 수는 그대로 유지된다 (표시만 정리).
    expect(diagnosisCheckItems(d)).toHaveLength(5);
  });
  test("visible check items are unchanged when there are no follow-up questions", () => {
    const d = { ...outputFixture(), sourceNote: "test" };
    expect(visibleDiagnosisCheckItems(d)).toEqual(diagnosisCheckItems(d));
  });
  test("blocked gate prepends block reasons", () => {
    const d = { ...outputFixture(), sourceNote: "test", decisionGate: { verdict: "no-go" as const, reasons: ["필수 시스템 접근 불가"] }, technicalChecks: [] as { topic: string; status: "확인됨" | "확인 필요" | "불가"; note: string }[] };
    const items = diagnosisCheckItems(d);
    expect(items[0]).toMatchObject({ title: "필수 시스템 접근 불가", badge: "보류 사유", kind: "block" });
  });
  test("matrix rationale bullets keep the unique driver rationale without repeating card scores or classification", () => {
    const d = { ...outputFixture(), sourceNote: "test" };
    const bullets = matrixRationaleBullets(d);
    expect(bullets.length).toBeGreaterThan(0);
    expect(bullets.length).toBeLessThanOrEqual(3);
    // 점수 카드·상단 배지와 중복되는 축 점수 요약과 분류 문구는 표시하지 않는다.
    for (const b of bullets) {
      expect(b).not.toMatch(/자동화 가치 \d점 · 기술 실현 가능성 \d점/);
      expect(b).not.toContain("분류");
    }
    // 고유한 판단 근거(최상위 동인 팩터의 평가 근거)는 유지한다.
    expect(bullets.join(" ")).toContain("등록된 반복 업무와 승인 조건 근거");
  });
  test("matrix rationale constraints describe high judgment/risk without repeating their card scores", () => {
    const d = { ...outputFixture(), sourceNote: "test" };
    const high = {
      ...d,
      factors: d.factors.map(f => f.key === "humanJudgment" || f.key === "operationalRisk" ? { ...f, aiValue: 5 } : f),
    };
    const bullets = matrixRationaleBullets(high);
    expect(bullets.join(" ")).toContain("담당자 판단 필요도가 높아 담당자 수행 유지");
    expect(bullets.join(" ")).toContain("운영 위험이 높음");
    expect(bullets.join(" ")).not.toContain("담당자 판단 필요도 5점");
    expect(bullets.join(" ")).not.toContain("운영 위험 5점");
  });
});

describe("level display label and tooltip descriptions", () => {
  test("label is unified as 명칭 (Level N) for all levels", () => {
    expect(LEVEL_LABELS.map((label, level) => levelDisplayLabel({ level, label }))).toEqual([
      "수동 유지 (Level 0)",
      "AI 보조 (Level 1)",
      "부분 자동화 (Level 2)",
      "고도 자동화 (Level 3)",
    ]);
  });
  test("every level has a one-line description and Level 1 matches the policy wording", () => {
    expect(LEVEL_DESCRIPTIONS).toHaveLength(4);
    for (const description of LEVEL_DESCRIPTIONS) {
      expect(description.trim().length).toBeGreaterThan(0);
      expect(description).not.toContain("\n");
    }
    expect(LEVEL_DESCRIPTIONS[1]).toBe("담당자의 요청에 따라 AI가 업무를 보조합니다.");
  });
  test("verdict counts always sum to the total step count", () => {
    const d = { ...outputFixture(), sourceNote: "test" };
    const parts = diagnosisSummaryParts(d);
    expect(parts.verdict).toBe("전체 3개 업무 단계 중 자동화 적합 1개 · AI 보조 적합 1개 · 담당자 수행 1개");
    const single = diagnosisSummaryParts({ ...d, stepAssessments: d.stepAssessments.filter(s => s.verdict === "자동화") });
    expect(single.verdict).toBe("전체 1개 업무 단계 중 자동화 적합 1개");
    const empty = diagnosisSummaryParts({ ...d, stepAssessments: [] });
    expect(empty.verdict).toBeUndefined();
  });
});
