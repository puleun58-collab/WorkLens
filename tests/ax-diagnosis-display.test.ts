import { describe, expect, test } from "bun:test";
import { diagnosisCheckItems, diagnosisSummarySentences, matrixRationaleBullets } from "../src/components/ax/AxReport";
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
  test("blocked gate prepends block reasons", () => {
    const d = { ...outputFixture(), sourceNote: "test", decisionGate: { verdict: "no-go" as const, reasons: ["필수 시스템 접근 불가"] }, technicalChecks: [] as { topic: string; status: "확인됨" | "확인 필요" | "불가"; note: string }[] };
    const items = diagnosisCheckItems(d);
    expect(items[0]).toMatchObject({ title: "필수 시스템 접근 불가", badge: "보류 사유", kind: "block" });
  });
  test("matrix rationale bullets reference real scores and region", () => {
    const d = { ...outputFixture(), sourceNote: "test" };
    const bullets = matrixRationaleBullets(d);
    expect(bullets.length).toBeGreaterThan(0);
    expect(bullets.length).toBeLessThanOrEqual(3);
    expect(bullets[0]).toMatch(/자동화 가치 \d점 · 기술 실현 가능성 \d점 → 「.+」 분류/);
  });
});
