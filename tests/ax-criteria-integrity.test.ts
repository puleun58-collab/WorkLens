import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt } from "../src/lib/ax/guide";
import { extractReviewableItems } from "../src/lib/ax/hitl";
import { FACTOR_KEYS } from "../src/lib/ax/schema";
import type { AxDiagnosis, HitlReview } from "../src/lib/ax/types";
import { diagnosisFixture, planFixture } from "./fixtures/ax";
import { dieselCase } from "./fixtures/diesel-case";

/**
 * 올인원 지시문 판정 기준 정합성 회귀 (2순위):
 * - 성공 조건·실패 조건·검증 방법·참고 조건이 서로 섞이지 않는다.
 * - 단계 연결 여부가 성공·실패 의미를 바꾸지 않는다.
 * - 성공·실패 양쪽 출처에서 온 동일 문장은 어느 한쪽으로 임의 확정하지
 *   않고 출처 충돌(확인 대상)로 분리한다.
 * - 제외·차단·Level 0 범위에서 판정 조건이 구현 완료 기준으로 승격되지 않는다.
 */

function sectionOf(prompt: string, title: string): string {
  const lines = prompt.split("\n");
  const start = lines.findIndex((l) => l === `### ${title}`);
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("### ") || l.startsWith("## "));
  return rest.slice(0, end < 0 ? undefined : end).join("\n");
}

const withPoc = (poc: Partial<{ success: string[]; failure: string[] }>): AxDiagnosis => ({
  ...diagnosisFixture,
  poc: { ...diagnosisFixture.poc, ...poc },
});

const promptFor = (diagnosis: AxDiagnosis, options?: Parameters<typeof buildAllInOnePrompt>[2]) =>
  buildAllInOnePrompt(planFixture, "codex", { taskName: "판정 정합성", diagnosis, context: "", ...options });

describe("판정 기준 4범주 분리", () => {
  it("정상 성공 기준은 업무 전체 완료 기준에만 완료 조건으로 표시된다", () => {
    const prompt = promptFor(withPoc({ success: ["수동 결과와 자동 결과 일치"], failure: [] }));
    expect(sectionOf(prompt, "업무 전체 완료 기준")).toContain("수동 결과와 자동 결과 일치");
    expect(sectionOf(prompt, "업무 전체 실패 판정 기준")).toBe("");
    expect(sectionOf(prompt, "판정 기준 출처 충돌 (확인 필요)")).toBe("");
  });

  it("정상 실패 기준은 업무 전체 실패 판정 기준에만 표시되고 완료 조건이 아니다", () => {
    const prompt = promptFor(withPoc({ success: [], failure: ["누락 건이 정상 결과에 포함됨"] }));
    const failure = sectionOf(prompt, "업무 전체 실패 판정 기준");
    expect(failure).toContain("누락 건이 정상 결과에 포함됨");
    expect(failure).toContain("완료로 판정하지 마세요");
    expect(sectionOf(prompt, "업무 전체 완료 기준")).not.toContain("누락 건이 정상 결과에 포함됨");
  });

  it("성공·실패가 함께 있어도 서로의 섹션으로 새지 않는다", () => {
    const prompt = promptFor(withPoc({
      success: ["수동 결과와 자동 결과 일치", "형식 검증: 오류 행이 분리됨"],
      failure: ["누락 발생", "자료 수집: 중복 레코드가 정상 결과에 포함됨"],
    }));
    expect(sectionOf(prompt, "업무 전체 완료 기준")).toContain("수동 결과와 자동 결과 일치");
    expect(sectionOf(prompt, "업무 전체 완료 기준")).not.toContain("누락 발생");
    expect(sectionOf(prompt, "업무 전체 실패 판정 기준")).toContain("누락 발생");
    // 단계 연결 성공 기준은 판정 기준에, 단계 연결 실패 기준은 단계별 실패 판정에만
    expect(sectionOf(prompt, "판정 기준")).toContain("형식 검증: 오류 행이 분리됨");
    expect(sectionOf(prompt, "판정 기준")).not.toContain("중복 레코드가 정상 결과에 포함됨");
    const stepFailure = sectionOf(prompt, "단계별 실패 판정 기준");
    expect(stepFailure).toContain("자료 수집: 중복 레코드가 정상 결과에 포함됨");
    expect(stepFailure).toContain("해당 단계를 완료로 판정하지 마세요");
  });

  it("단계에 연결된 실패 기준은 판정 기준(성공 취급)으로 표시되지 않는다", () => {
    const prompt = promptFor(withPoc({ success: [], failure: ["자료 수집: 중복 레코드가 정상 결과에 포함됨"] }));
    expect(sectionOf(prompt, "판정 기준")).toBe("");
    expect(sectionOf(prompt, "단계별 실패 판정 기준")).toContain("자료 수집: 중복 레코드가 정상 결과에 포함됨");
  });

  it("검증 방법은 성공 조건으로 승격되지 않는다 (단계 연결 검증 방법)", () => {
    const prompt = promptFor(withPoc({ success: ["자료 수집: 담당자 수동 결과와 대조"], failure: [] }));
    expect(sectionOf(prompt, "검증 방법·기록 (합격 조건 아님)")).toContain("자료 수집: 담당자 수동 결과와 대조");
    expect(sectionOf(prompt, "업무 전체 완료 기준")).not.toContain("담당자 수동 결과와 대조");
    expect(sectionOf(prompt, "판정 기준")).not.toContain("담당자 수동 결과와 대조");
  });
});

describe("성공·실패 출처 충돌", () => {
  it("동일 문장이 성공·실패 양쪽 출처이면 (미연결) 출처 충돌로만 분리된다", () => {
    const prompt = promptFor(withPoc({
      success: ["대조 결과가 기준표와 일치"],
      failure: ["대조 결과가 기준표와 일치"],
    }));
    const conflict = sectionOf(prompt, "판정 기준 출처 충돌 (확인 필요)");
    expect(conflict).toContain("대조 결과가 기준표와 일치");
    expect(conflict).toContain("어느 한쪽으로 임의로 해석해 완료·실패를 판정하지 말고");
    // 성공 조건으로도, 실패 조건으로도 확정하지 않는다
    expect(sectionOf(prompt, "업무 전체 완료 기준")).not.toContain("대조 결과가 기준표와 일치");
    expect(sectionOf(prompt, "업무 전체 실패 판정 기준")).not.toContain("대조 결과가 기준표와 일치");
  });

  it("동일 문장이 성공·실패 양쪽 출처이면 (단계 연결) 단계 연결이 의미를 바꾸지 않는다", () => {
    const prompt = promptFor(withPoc({
      success: ["자료 수집: 중복 레코드가 제거됨"],
      failure: ["자료 수집: 중복 레코드가 제거됨"],
    }));
    const conflict = sectionOf(prompt, "판정 기준 출처 충돌 (확인 필요)");
    expect(conflict).toContain("자료 수집: 중복 레코드가 제거됨");
    expect(sectionOf(prompt, "판정 기준")).not.toContain("중복 레코드가 제거됨");
    expect(sectionOf(prompt, "단계별 실패 판정 기준")).not.toContain("중복 레코드가 제거됨");
  });
});

describe("범위 제한 상태에서 판정 조건 승격 방지", () => {
  it("HITL로 제외한 단계의 실패 기준이 필수 판정으로 재등장하지 않는다", () => {
    const items = extractReviewableItems(diagnosisFixture);
    const stepItem = items.find((i) => i.type === "step" && i.text.startsWith("형식 검증"));
    if (!stepItem) throw new Error("reviewable step not found: 형식 검증");
    const review: HitlReview = {
      id: "criteria-integrity-review",
      target: { type: stepItem.type, key: stepItem.key, source: stepItem.source, sourceText: stepItem.text, sourceHash: stepItem.sourceHash },
      action: "exclude",
      status: "confirmed",
      reason: "사용자 제외 결정",
      reviewedAt: "2026-10-21T00:00:00.000Z",
      updatedAt: "2026-10-21T00:00:00.000Z",
    } as HitlReview;
    const prompt = promptFor(
      withPoc({ success: ["수동 결과와 자동 결과 일치"], failure: ["형식 검증: 오류 행이 정상 결과에 포함됨"] }),
      { hitlReviews: [review], hitlTool: "codex" },
    );
    for (const title of ["판정 기준", "단계별 실패 판정 기준", "업무 전체 실패 판정 기준"]) {
      expect(sectionOf(prompt, title)).not.toContain("오류 행이 정상 결과에 포함됨");
    }
  });

  it("Level 0 검토 전용에서는 미연결 PoC 기준이 업무 전체 완료 조건으로 승격되지 않는다", () => {
    const l0 = {
      ...dieselCase.diagnosis,
      factors: FACTOR_KEYS.map((key) => ({ key, aiValue: 1, rationale: "낮음" })),
    } as unknown as AxDiagnosis;
    const prompt = buildAllInOnePrompt(dieselCase.plan, "codex", { taskName: dieselCase.name, diagnosis: l0, context: "" });
    expect(sectionOf(prompt, "업무 전체 완료 기준")).toBe("");
    expect(sectionOf(prompt, "업무 전체 실패 판정 기준")).toBe("");
    const deferred = sectionOf(prompt, "참고 판정 (필수 완료 조건 아님)");
    expect(deferred).toContain("증감률 계산이 담당자 수동 계산과 일치");
    expect(deferred).toContain("검토·검증 전용 범위");
  });

  it("Gate 차단 상태에서는 PoC 기준이 완료 조건이 아니라 참고 판정으로 강등된다", () => {
    const blocked = {
      ...dieselCase.diagnosis,
      decisionGate: { verdict: "no-go", reasons: ["운영 정책 위반"] },
    } as unknown as AxDiagnosis;
    const prompt = buildAllInOnePrompt(dieselCase.plan, "codex", { taskName: dieselCase.name, diagnosis: blocked, context: "" });
    expect(sectionOf(prompt, "업무 전체 완료 기준")).not.toContain("증감률 계산이 담당자 수동 계산과 일치");
    const deferred = sectionOf(prompt, "참고 판정 (필수 완료 조건 아님)");
    expect(deferred).toContain("증감률 계산이 담당자 수동 계산과 일치");
    expect(deferred).toContain("실행 차단 상태");
  });
});
