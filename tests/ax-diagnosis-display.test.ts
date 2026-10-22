import { describe, expect, test } from "vitest";
import { diagnosisCheckItems, diagnosisSummarySentences, matrixRationaleBullets, visibleDiagnosisCheckItems } from "../src/components/ax/AxReport";
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
    expect(sentences[0]).toBe("전체 3단계 중 자동화 1단계 · AI 보조 1단계 · 담당자 수행 1단계로 판정되었습니다.");
    expect(sentences[1]).toContain("담당자 승인");
    expect(sentences[1]).toContain("담당자 판단·승인이 필요합니다.");
    expect(sentences[2]).toBe("구현 전에 확인해야 할 사항이 1건 남아 있습니다.");
    // Level·Gate 문장은 배지와 중복되므로 요약에 반복하지 않는다.
    expect(sentences.join(" ")).not.toContain("확인 후 진행 상태로");
    expect(sentences.join(" ")).not.toContain("진행 가능 상태입니다");
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
