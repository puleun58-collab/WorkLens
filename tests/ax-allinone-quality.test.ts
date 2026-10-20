import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt, buildAgentInstructionModel, stepIoSpec } from "../src/lib/ax/guide";
import { dieselCase } from "./fixtures/diesel-case";

const promptFor = () =>
  buildAllInOnePrompt(dieselCase.plan, "codex", {
    taskName: dieselCase.name, diagnosis: dieselCase.diagnosis, context: "",
  });

describe("AX all-in-one quality: diesel price regression case", () => {
  it("shows PoC outputs as related/overall deliverables instead of '확인 필요'", () => {
    const prompt = promptFor();
    // No function block ends with output "확인 필요"
    const funcBlocks = prompt.match(/### 기능 \d+\.[\s\S]*?(?=### 기능 \d+|### 전체 흐름)/g) ?? [];
    expect(funcBlocks.length).toBeGreaterThan(0);
    for (const block of funcBlocks) {
      expect(block).not.toMatch(/- 출력: 확인 필요/);
    }
    // Related outputs are linked by keyword relevance
    expect(prompt).toContain("전주 대비 증감률 (관련 산출물)");
    expect(prompt).toContain("월평균 가격 (관련 산출물)");
  });

  it("keeps PoC success criteria as overall completion criteria, not demoted", () => {
    const prompt = promptFor();
    expect(prompt).toContain("### 업무 전체 완료 기준");
    expect(prompt).toContain("증감률 계산이 담당자 수동 계산과 일치");
    expect(prompt).toContain("월평균 계산이 담당자 수동 계산과 일치");
    // Not demoted to reference-only
    const refSection = prompt.match(/### 참고 판정[\s\S]*?(?=### |$)/)?.[0] ?? "";
    expect(refSection).not.toContain("증감률 계산이 담당자 수동 계산과 일치");
  });

  it("does not expose internal field paths or link boilerplate on goals", () => {
    const prompt = promptFor();
    expect(prompt).not.toMatch(/plan\.toBe|plan\.asIs|plan\.poc|diagnosis\.stepAssessments\.note/);
    expect(prompt).not.toContain("연결된 진단 단계가 확인되지 않았습니다");
    expect(prompt).not.toContain("적용 단계 미확인");
    expect(prompt).not.toContain("명시적 처리 방식 확인 필요");
    // The plan goal is a task-level objective, not a step-link failure
    const goalSection = prompt.match(/### 생성 계획 목표[\s\S]*?(?=### |$)/)?.[0] ?? "";
    expect(goalSection).not.toContain("어느 업무 단계에 적용되는지 확인되지 않았습니다");
  });

  it("stepIoSpec distinguishes step outputs from overall deliverables", () => {
    const model = buildAgentInstructionModel(dieselCase.plan, {
      taskName: dieselCase.name, diagnosis: dieselCase.diagnosis, context: "",
    });
    const idx = model.steps.findIndex(s => s.step === "전주 대비 증감률 계산");
    expect(idx).toBeGreaterThanOrEqual(0);
    const spec = stepIoSpec(model, idx);
    // Step-linked output present; overall fallback empty when step outputs exist
    expect(spec.outputs.some(o => o.includes("전주 대비 증감률"))).toBe(true);
    const inputIdx = model.steps.findIndex(s => s.step === "가격 입력");
    const inputSpec = stepIoSpec(model, inputIdx);
    // Input step has no false keyword-linked outputs; overall deliverables shown instead
    expect(inputSpec.outputs).toEqual([]);
    expect(inputSpec.overallOutputs.length).toBeGreaterThan(0);
  });

  it("preserves Level 1 user-initiated execution and HITL/human constraints", () => {
    const prompt = promptFor();
    // Level 번호는 출력하지 않되, 해당 정책의 실행 제한(보조 수준 유지·무인 실행 금지)은 그대로 적용된다.
    expect(prompt).toContain("자동화 범위를 현재 보조 수준에서 확대하지 마세요");
    expect(prompt).toMatch(/담당자가 실행을 요청하면|담당자 요청 기반/);
    expect(prompt).toMatch(/무인|스케줄러/);
    expect(prompt).toContain("| 담당자 최종 검토 | 담당자 수행 |"); // human step stays human-owned in the scope table
    expect(prompt).toContain("가격 자동 수집"); // excluded stays excluded
  });
});
