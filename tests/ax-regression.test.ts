import { describe, expect, it } from "vitest";
import { AX_POLICY, axes, automationLevel, matrixPosition, priority } from "@/lib/ax/policy";
import { followUpDescription, legacyDetailValues, validateAttachmentPreflight } from "@/lib/ax/registration";
import { inputLimitFor } from "@/lib/parsers/policy";
import type { AxDiagnosis } from "@/lib/ax/types";
import { diagnosisFixture, taskFixture } from "./fixtures/ax";

function rated(values: number[]): AxDiagnosis {
  const d = structuredClone(diagnosisFixture);
  d.factors.forEach((f, i) => { f.aiValue = values[i]; });
  return d;
}

describe("AX Tier 1 exhaustive policy regression", () => {
  it("keeps all 15,625 factor combinations bounded, finite and deterministic", () => {
    const combinations = 5 ** 6;
    let visited = 0;
    for (let index = 0; index < combinations; index += 1) {
      const values = Array.from({ length: 6 }, (_, i) => Math.floor(index / 5 ** i) % 5 + 1);
      const d = rated(values);
      const a = axes(d), level = automationLevel(d), position = matrixPosition(d);
      for (const value of Object.values(a)) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(1);
        expect(value).toBeLessThanOrEqual(5);
      }
      expect(Number.isInteger(level.level)).toBe(true);
      expect(level.level).toBeGreaterThanOrEqual(0);
      expect(level.level).toBeLessThanOrEqual(3);
      for (const coordinate of [position.x, position.y]) {
        expect(Number.isFinite(coordinate)).toBe(true);
        expect(coordinate).toBeGreaterThanOrEqual(0);
        expect(coordinate).toBeLessThanOrEqual(100);
      }
      expect(["quick", "strategic", "maybe", "hold"]).toContain(position.region);
      const ranked = priority([taskFixture(`combination-${index}`, d)]);
      expect(ranked).toHaveLength(1);
      expect(Number.isFinite(ranked[0].score)).toBe(true);
      expect(axes(d)).toEqual(a);
      expect(automationLevel(d)).toEqual(level);
      expect(matrixPosition(d)).toEqual(position);
      visited += 1;
    }
    expect(visited).toBe(15_625);
  }, 30_000);

  it.each([
    { ai: [1, 1, 1, 1, 5, 5], final: [5, 5, 5, 5, 1, 1] },
    { ai: [5, 5, 5, 5, 1, 1], final: [2, 2, 2, 2, 4, 4] },
    { ai: [1, 2, 3, 4, 5, 1], final: [4, 4, 4, 3, 3, 4] },
    { ai: [5, 4, 3, 2, 1, 5], final: [1, 3, 4, 5, 4, 2] },
  ])("uses finalValue consistently instead of aiValue: $final", ({ ai, final }) => {
    const adjusted = rated(ai), expected = rated(final);
    adjusted.factors.forEach((f, i) => { f.finalValue = final[i]; });
    expect(axes(adjusted)).toEqual(axes(expected));
    expect(automationLevel(adjusted)).toEqual(automationLevel(expected));
    expect(matrixPosition(adjusted)).toEqual(matrixPosition(expected));
    expect(priority([taskFixture("adjusted", adjusted)])[0].score)
      .toBe(priority([taskFixture("expected", expected)])[0].score);
  });

  it("preserves aiValue for factors without finalValue when only some factors are adjusted", () => {
    const d = rated([1, 4, 4, 2, 2, 2]);
    d.factors[0].finalValue = 4;
    d.factors[3].finalValue = 4;
    const expected = rated([4, 4, 4, 4, 2, 2]);
    expect(axes(d)).toEqual(axes(expected));
    expect(automationLevel(d)).toEqual(automationLevel(expected));
    expect(matrixPosition(d)).toEqual(matrixPosition(expected));
  });
});

describe("AX Tier 1 policy boundaries", () => {
  it("makes matrixThreshold 3.5 equivalent to integer value >= 4: value 3 is maybe and 4 is quick", () => {
    const below = rated([3, 3, 3, 5, 2, 2]), above = rated([4, 4, 4, 4, 2, 2]);
    expect(AX_POLICY.matrixThreshold).toBe(3.5);
    expect(axes(below)).toMatchObject({ value: 3, feasibility: 4 });
    expect(axes(above)).toMatchObject({ value: 4, feasibility: 4 });
    expect(matrixPosition(below).region).toBe("maybe");
    expect(matrixPosition(above).region).toBe("quick");
  });

  it("makes holdJudgment 4.5 equivalent to judgment 5: judgment 4 is quick and 5 is hold", () => {
    expect(AX_POLICY.holdJudgment).toBe(4.5);
    expect(matrixPosition(rated([5, 5, 5, 5, 4, 1])).region).toBe("quick");
    expect(matrixPosition(rated([5, 5, 5, 5, 5, 1])).region).toBe("hold");
  });

  it("applies holdRisk 4 inclusively: risk 3 is quick and risk 4 is hold", () => {
    expect(AX_POLICY.holdRisk).toBe(4);
    expect(matrixPosition(rated([5, 5, 5, 5, 1, 3])).region).toBe("quick");
    expect(matrixPosition(rated([5, 5, 5, 5, 1, 4])).region).toBe("hold");
  });

  it("assigns L0 at value axis 2 even with low judgment and risk", () => {
    const d = rated([2, 2, 2, 5, 1, 1]);
    expect(axes(d).value).toBe(2);
    expect(automationLevel(d).level).toBe(0);
  });

  it("assigns L2 at value 3, feasibility 3 and judgment 3", () => {
    const d = rated([3, 3, 3, 3, 3, 2]);
    expect(axes(d)).toMatchObject({ value: 3, feasibility: 3, judgment: 3 });
    expect(automationLevel(d).level).toBe(2);
  });

  it("assigns L0 when judgment >= 4 and risk >= 4 despite high value and feasibility", () => {
    for (const judgment of [4, 5]) for (const risk of [4, 5]) {
      expect(automationLevel(rated([5, 5, 5, 5, judgment, risk])).level).toBe(0);
    }
  });
});

describe("AX Tier 1 pure registration helpers", () => {
  it("builds only answered follow-up rows and preserves the original description and arrays", () => {
    const description = "  원본 업무\n설명  ";
    const questions = ["입력은?", "승인자는?", "접근은?", "누락 답변은?"];
    const answers = ["CSV", "   ", "  담당자 권한  "];
    const beforeQuestions = [...questions], beforeAnswers = [...answers];
    expect(followUpDescription(description, questions, answers))
      .toBe(`${description}\n추가 확인:\n입력은?: CSV\n접근은?:   담당자 권한  `);
    expect(description).toBe("  원본 업무\n설명  ");
    expect(questions).toEqual(beforeQuestions);
    expect(answers).toEqual(beforeAnswers);
    expect(followUpDescription(description, questions, [])).toBe(description);
    expect(followUpDescription(description, [], ["대응 질문 없는 답변"])).toBe(description);
  });

  it("preserves defined legacy fields including empty strings and omits undefined fields", () => {
    const task = { ...taskFixture(), people: 3, painPoints: "", goal: "기존 목표", systems: "ERP" };
    const before = structuredClone(task);
    expect(legacyDetailValues(task)).toEqual({ people: 3, painPoints: "", goal: "기존 목표" });
    expect(legacyDetailValues({ ...taskFixture(), people: undefined, painPoints: undefined, goal: undefined })).toEqual({});
    expect(legacyDetailValues({ ...taskFixture(), goal: "" })).toEqual({ goal: "" });
    expect(task).toEqual(before);
  });

  it.each(["csv", "xlsx", "docx", "pptx", "pdf"] as const)("accepts %s case-insensitively through the shared size limit", kind => {
    const file = { name: `  ${"가".normalize("NFD")}.자료.${kind.toUpperCase()}  `, size: inputLimitFor(kind) };
    const before = { ...file };
    expect(validateAttachmentPreflight(file)).toBe(kind);
    expect(file).toEqual(before);
    expect(() => validateAttachmentPreflight({ ...file, size: inputLimitFor(kind) + 1 }))
      .toThrow("파일 크기가 허용 한도를 초과했습니다.");
  });

  it.each(["자료.xlsm", "자료.txt", "자료.csv.exe", "csv", "자료.pdf.", ""])("rejects unsupported extension %j before checking size", name => {
    expect(() => validateAttachmentPreflight({ name, size: 0 }))
      .toThrow("지원하지 않는 파일 형식입니다. CSV·XLSX·DOCX·PPTX·PDF 파일을 선택하세요.");
  });

  it("rejects an empty supported attachment before reading its content", () => {
    expect(() => validateAttachmentPreflight({ name: "자료.pdf", size: 0 })).toThrow("빈 파일은 첨부할 수 없습니다.");
  });
});
