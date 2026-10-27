import { describe, expect, it } from "vitest";
import { buildAgentInstructionModel, buildAllInOnePrompt } from "../src/lib/ax/guide";
import { automationLevel, executionGate, executionProfile } from "../src/lib/ax/policy";
import { agentCases, equipmentRuleCase, freightCase, type AxAgentCase } from "./fixtures/ax-agent-cases";

const optionsFor = (c: Pick<AxAgentCase, "name" | "description" | "diagnosis">) => {
  const profile = executionProfile(c.diagnosis);
  return { taskName: c.name, prerequisites: profile.gate === "blocked" ? [] : profile.prerequisites, diagnosis: c.diagnosis, context: c.description };
};
const funcBlock = (prompt: string, step: string) => {
  const m = prompt.match(new RegExp(`### 기능 \\d+\\. ${step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?(?=### 기능 \\d+\\.|## 4\\.)`));
  return m?.[0] ?? "";
};
const ALL = [...agentCases, freightCase, equipmentRuleCase];

describe("작업 19: 진단 단계 메모 전달 (원본 그대로, 신설 없음)", () => {
  it("구현·확인 후 구현 단계의 기능 블록에 해당 단계의 진단 메모 원문이 들어간다", () => {
    const cases: Array<[string, string]> = [
      ["월간 운임 정산", "누락·중복 검증"],
      ["월간 운임 정산", "실적 파일 병합"],
      ["월간 운임 정산", "정산표 생성"],
      ["계약 갱신 일정 관리", "만료 예정 계약 추출"],
      ["시설 보수 요청 접수·우선순위 검토", "필수 정보 확인"],
      ["시설 보수 요청 접수·우선순위 검토", "요청 접수"],
    ];
    for (const [name, step] of cases) {
      const c = ALL.find(x => x.name === name)!;
      const note = c.diagnosis.stepAssessments.find(s => s.step === step)!.note;
      const prompt = buildAllInOnePrompt(c.plan, "codex", optionsFor(c));
      expect(funcBlock(prompt, step)).toContain(`진단 단계 메모: ${note}`);
    }
    // 규칙 기반 검증 메모(장비 규칙 사례)도 같은 경로로 전달된다.
    const rule = equipmentRuleCase;
    const ruleNote = rule.diagnosis.stepAssessments.find(s => s.step === "누락·중복 검증")!.note;
    const rulePrompt = buildAllInOnePrompt(rule.plan, "codex", optionsFor(rule));
    expect(funcBlock(rulePrompt, "누락·중복 검증")).toContain(`진단 단계 메모: ${ruleNote}`);
  });

  it("메모 줄은 원본 메모 수와 일치하고, 메모 밖의 새 규칙 문구를 만들지 않는다", () => {
    for (const c of ALL) {
      const prompt = buildAllInOnePrompt(c.plan, "codex", optionsFor(c));
      const model = buildAgentInstructionModel(c.plan, optionsFor(c));
      const workNotes = model.steps
        .filter(s => s.scope === "implement" || s.scope === "after-check")
        .map(s => s.note.trim())
        .filter(Boolean);
      const section3 = prompt.split("## 3.")[1]?.split("## 4.")[0] ?? "";
      const lines = section3.match(/^- 진단 단계 메모: .+$/gmu) ?? [];
      expect(lines.length).toBe(workNotes.length);
      for (const note of workNotes) expect(section3).toContain(`진단 단계 메모: ${note}`);
    }
  });

  it("검토·검증 단계(차단 사례)에도 진단 메모가 함께 표시된다", () => {
    const c = ALL.find(x => x.name === "작업 허가 및 안전조치 승인")!;
    const prompt = buildAllInOnePrompt(c.plan, "codex", optionsFor(c));
    expect(prompt).toContain("허가 신청 접수 — 처리 방식 미확정 — 근거·필수 기준 확인 후 진행 (진단 메모: 신청서 형식 확인)");
  });

  it("미확정 메모가 확정 규칙으로 승격되지 않는다: 방식 미확정 문구와 보류 규칙이 유지된다", () => {
    const c = ALL.find(x => x.name === "일일 장비 가동 실적 집계")!;
    const prompt = buildAllInOnePrompt(c.plan, "codex", optionsFor(c));
    expect(funcBlock(prompt, "가동률 계산")).toContain("진단 단계 메모: 계산식 미확정");
    expect(prompt).toContain("해당 기능의 실제 구현은 처리 방식과 선행조건이 확인될 때까지 보류합니다");
  });

  it("Codex/Claude 지시문이 동일하고, Level·Gate·단계 범위가 변하지 않는다", () => {
    for (const c of ALL) {
      const opts = optionsFor(c);
      expect(buildAllInOnePrompt(c.plan, "claude", opts)).toBe(buildAllInOnePrompt(c.plan, "codex", opts));
      const model = buildAgentInstructionModel(c.plan, opts);
      expect(automationLevel(c.diagnosis).level).toBe(model.level?.level);
      expect(executionGate(c.diagnosis)).toBe(model.gate);
      expect(model.steps.map(s => `${s.step}:${s.scope}`).join("|"))
        .toBe(executionProfile(c.diagnosis).stepScope.map(s => `${s.step}:${s.scope}`).join("|"));
    }
  });

  it("원본 진단·계획 객체를 변경하지 않는다", () => {
    const before = structuredClone(freightCase);
    buildAllInOnePrompt(freightCase.plan, "codex", optionsFor(freightCase));
    expect(freightCase).toEqual(before);
  });
});
