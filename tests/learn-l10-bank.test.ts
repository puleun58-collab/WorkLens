/**
 * LEVEL 10 문제은행 균형·유사 문항 회귀 가드.
 *
 * 배경: 은행 분포는 l10-u2에 16/40문항이 집중돼 있지만, 실제 출제는 단위 쿼터가
 * 결정하므로 은행 비율이 출제 비율로 이어지지 않는다. 이 테스트는 그 균형이
 * 깨지지 않는지, 그리고 집계형 문항 l10-q037·q038이 서로의 정답을 단서로
 * 제공하지 않는지를 고정한다.
 */
import { describe, expect, test } from "vitest";
import { levelContent } from "@/lib/learn/content";
import { questionBank } from "@/lib/learn/questions";
import { allocateUnitQuotas, gradeQuiz, selectQuizQuestions } from "@/lib/learn/scoring";
import type { LearnerAnswer } from "@/lib/learn/types";

const bank = questionBank(10);
const unitIds = levelContent(10).units.map((u) => u.id);

describe("LEVEL 10 문제은행 분포와 실제 출제 비율", () => {
  test("은행은 40문항이며 단위 쿼터가 출제를 균형 배분한다 (u2 은행 16문항 ≠ 출제 40%)", () => {
    expect(bank).toHaveLength(40);
    expect(bank.every((q) => q.verified)).toBe(true);
    const bankSizes = new Map(unitIds.map((id) => [id, bank.filter((q) => q.unitId === id).length]));
    expect(bankSizes.get("l10-u2")).toBe(16);
    const quotas = allocateUnitQuotas(unitIds, bankSizes, 20);
    // 가장 큰 단위도 출제의 20%를 넘지 않고, 모든 단위가 매 응시에 포함된다
    for (const id of unitIds) {
      expect(quotas.get(id) ?? 0).toBeGreaterThanOrEqual(3);
      expect(quotas.get(id) ?? 0).toBeLessThanOrEqual(4);
    }
    expect([...quotas.values()].reduce((a, b) => a + b, 0)).toBe(20);
  });

  test("30개 연쇄 응시 세트: 세트당 20문항·중복 없음·전 문항이 출제된다", () => {
    const seen = new Set<string>();
    let previous: string[] = [];
    for (let s = 0; s < 30; s++) {
      const selected = selectQuizQuestions(10, bank, `l10-chain-${s}`, unitIds, previous);
      expect(selected).toHaveLength(20);
      expect(new Set(selected.map((q) => q.id)).size).toBe(20);
      const perUnit = new Map<string, number>();
      for (const q of selected) {
        perUnit.set(q.unitId!, (perUnit.get(q.unitId!) ?? 0) + 1);
        seen.add(q.id);
      }
      // 단위 쿼터 고정: u2는 세트당 정확히 4문항
      expect(perUnit.get("l10-u2")).toBe(4);
      previous = selected.map((q) => q.id);
    }
    // 은행의 40문항이 30세트 안에 모두 실제로 출제된다 (사각 문항 없음)
    expect(seen.size).toBe(40);
  });

  test("생성된 세트의 채점 일관성: 전부 정답이면 100점 통과, 전부 오답이면 0점 미통과", () => {
    const selected = selectQuizQuestions(10, bank, "l10-grade-consistency", unitIds);
    const right: Record<string, LearnerAnswer> = {};
    const wrong: Record<string, LearnerAnswer> = {};
    for (const q of selected) {
      if (q.type === "ox") {
        right[q.id] = { kind: "ox", answer: q.oxAnswer! };
        wrong[q.id] = { kind: "ox", answer: !q.oxAnswer! };
      } else if (q.type === "terminal-task") {
        right[q.id] = { kind: "terminal", passed: true };
        wrong[q.id] = { kind: "terminal", passed: false };
      } else {
        const correct = q.correctChoiceIds ?? [];
        right[q.id] = { kind: "choices", selectedChoiceIds: correct };
        const wrongPick = (q.choices ?? []).map((c) => c.id).filter((id) => !correct.includes(id)).slice(0, 1);
        wrong[q.id] = { kind: "choices", selectedChoiceIds: wrongPick };
      }
    }
    expect(gradeQuiz(10, selected, right)).toMatchObject({ score: 100, passed: true });
    expect(gradeQuiz(10, selected, wrong)).toMatchObject({ score: 0, passed: false });
  });
});

describe("l10-q037·q038 유사 문항 단서 차단", () => {
  const q037 = bank.find((q) => q.id === "l10-q037")!;
  const q038 = bank.find((q) => q.id === "l10-q038")!;

  test("두 문항은 평가 범주가 다르고, q038의 선택지 소재가 q037의 선택지와 겹치지 않는다", () => {
    expect(q037).toBeDefined();
    expect(q038).toBeDefined();
    expect(q037.unitId).toBe("l10-u2");
    expect(q038.unitId).toBe("l10-u2");
    expect(q037.category).not.toBe(q038.category);
    // q038 선택지의 소재(콜론 앞부분)가 q037 선택지 텍스트에 등장하면
    // 한 문항의 풀이가 다른 문항의 정답·오답을 알려주는 단서가 된다
    const q037Texts = (q037.choices ?? []).map((c) => c.text);
    for (const choice of q038.choices ?? []) {
      const subject = choice.text.split(":")[0].trim();
      for (const other of q037Texts) {
        expect(other.includes(subject) || subject.includes(other), `q038:${choice.id} 소재가 q037과 겹침`).toBe(false);
      }
    }
    // 과거에 겹쳤던 소재(최종 정산 금액 확정)는 q038에 남아 있지 않다
    const q038AllText = [q038.prompt, ...(q038.choices ?? []).map((c) => c.text)].join(" ");
    expect(q038AllText).not.toContain("최종 정산 금액");
  });

  test("q038의 정답 구조는 기존과 동일하다 (a·b·c, 정답 변경 없음)", () => {
    expect(q038.correctChoiceIds).toEqual(["a", "b", "c"]);
    expect(q038.type).toBe("multiple");
    expect(q038.difficulty).toBe("judgment");
  });
});
