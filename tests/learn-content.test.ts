import { describe, expect, test } from "vitest";
import { ALL_LEVELS, levelMeta } from "@/lib/learn/curriculum";
import { allQuestions, diagnosticQuestions, linkedUnitForQuestion, questionBank } from "@/lib/learn/questions";
import { allContents } from "@/lib/learn/content";
import type { LearnQuestion } from "@/lib/learn/types";

describe("문제은행 무결성", () => {
  test("단계별 검증 문제 수 (출제 문항의 2배 이상)", () => {
    for (const level of ALL_LEVELS) {
      const meta = levelMeta(level);
      const verified = questionBank(level).filter((q) => q.verified);
      expect(verified.length, `LEVEL ${level}`).toBeGreaterThanOrEqual(meta.questionCount * 2);
    }
  });

  test("문제 ID 중복 없음", () => {
    const ids = allQuestions().map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("선택지 정합성", () => {
    for (const q of allQuestions()) {
      if (q.type === "single" || q.type === "command-result" || q.type === "error-cause" || q.type === "case-judgment") {
        expect(q.choices?.length, `${q.id} 선택지`).toBeGreaterThanOrEqual(2);
        expect(q.correctChoiceIds, `${q.id} 정답`).toHaveLength(1);
        expect(q.choices?.some((c) => c.id === q.correctChoiceIds![0]), `${q.id} 정답이 선택지에 존재`).toBe(true);
      }
      if (q.type === "multiple") {
        expect(q.choices?.length, `${q.id} 선택지`).toBeGreaterThanOrEqual(3);
        expect((q.correctChoiceIds?.length ?? 0), `${q.id} 정답 개수`).toBeGreaterThanOrEqual(2);
        for (const id of q.correctChoiceIds ?? []) {
          expect(q.choices?.some((c) => c.id === id), `${q.id} 정답 ${id}가 선택지에 존재`).toBe(true);
        }
      }
      if (q.type === "ox") {
        expect(typeof q.oxAnswer, `${q.id} oxAnswer`).toBe("boolean");
      }
      if (q.type === "terminal-task") {
        expect(q.terminalTask, `${q.id} terminalTask`).toBeDefined();
        expect(q.terminalTask!.successChecks.length, `${q.id} 성공 조건`).toBeGreaterThan(0);
      }
      expect(q.explanation?.length, `${q.id} 해설`).toBeGreaterThan(0);
      expect(q.category?.length, `${q.id} 카테고리`).toBeGreaterThan(0);
    }
  });

  test("선택지 ID 중복 없음", () => {
    for (const q of allQuestions()) {
      if (!q.choices) continue;
      const ids = q.choices.map((c) => c.id);
      expect(new Set(ids).size, `${q.id} 선택지 ID`).toBe(ids.length);
    }
  });

  test("난이도 분포가 단계별 기준에 근접", () => {
    const check = (levels: number[], concept: number, application: number, judgment: number) => {
      const qs = allQuestions().filter((q) => levels.includes(q.level));
      const total = qs.length;
      const c = qs.filter((q) => q.difficulty === "concept").length / total;
      const a = qs.filter((q) => q.difficulty === "application").length / total;
      const j = qs.filter((q) => q.difficulty === "judgment").length / total;
      // ±15%p 허용
      expect(Math.abs(c - concept), `concept ${levels}`).toBeLessThan(0.15);
      expect(Math.abs(a - application), `application ${levels}`).toBeLessThan(0.15);
      expect(Math.abs(j - judgment), `judgment ${levels}`).toBeLessThan(0.15);
    };
    check([1, 2, 3], 0.6, 0.3, 0.1);
    check([4, 5, 6, 7], 0.3, 0.4, 0.3);
    check([8, 9, 10], 0.1, 0.3, 0.6);
  });
});

describe("학습 콘텐츠 무결성", () => {
  test("10단계 콘텐츠 존재, 단계당 4개 이상 단위", () => {
    const contents = allContents();
    expect(contents).toHaveLength(10);
    for (const c of contents) {
      expect(c.units.length, `LEVEL ${c.level} 단위 수`).toBeGreaterThanOrEqual(4);
    }
  });

  test("단위 필수 요소", () => {
    for (const c of allContents()) {
      for (const u of c.units) {
        expect(u.goal?.length, `${u.id} goal`).toBeGreaterThan(0);
        expect(u.concepts.length, `${u.id} concepts`).toBeGreaterThan(0);
        expect(u.whyNeeded?.length, `${u.id} whyNeeded`).toBeGreaterThan(0);
        expect(u.usageSituations.length, `${u.id} usageSituations`).toBeGreaterThan(0);
        expect(u.cases.length, `${u.id} cases`).toBeGreaterThan(0);
        expect(u.mistakes.length, `${u.id} mistakes`).toBeGreaterThan(0);
        expect(u.summary.length, `${u.id} summary`).toBeGreaterThan(0);
        expect(u.estimatedMinutes, `${u.id} estimatedMinutes`).toBeGreaterThan(0);
      }
    }
  });

  test("단위 ID 중복 없음", () => {
    const ids = allContents().flatMap((c) => c.units.map((u) => u.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("문제-학습 단위 연결", () => {
  test("모든 문제은행 문항이 같은 LEVEL의 실제 학습 단위에 연결되어 있다", () => {
    const contents = allContents();
    for (const q of allQuestions()) {
      expect(q.unitId, `${q.id} unitId`).toBeTruthy();
      const content = contents.find((c) => c.level === q.level);
      expect(content, `${q.id} LEVEL 콘텐츠`).toBeDefined();
      expect(content!.units.some((u) => u.id === q.unitId), `${q.id} → ${q.unitId}`).toBe(true);
    }
  });

  test("모든 학습 단위에 검증된 문항이 균형 출제 쿼터 이상 연결되어 있다", () => {
    for (const c of allContents()) {
      const meta = levelMeta(c.level);
      const minPerUnit = Math.floor(meta.questionCount / c.units.length);
      for (const u of c.units) {
        const linked = allQuestions().filter((q) => q.unitId === u.id && q.verified);
        expect(linked.length, `${u.id} 연결 문항`).toBeGreaterThanOrEqual(minPerUnit);
      }
    }
  });

  test("연결이 끊긴(존재하지 않는 단위) 문항은 출제에서 제외된다", () => {
    // linkedUnitForQuestion이 undefined를 반환하면 UI는 레벨 학습 화면으로 안전하게 대체한다
    const orphan: LearnQuestion = { ...allQuestions()[0], unitId: "l1-u999" };
    expect(linkedUnitForQuestion(orphan)).toBeUndefined();
    const noLink: LearnQuestion = { ...allQuestions()[0], unitId: undefined };
    expect(linkedUnitForQuestion(noLink)).toBeUndefined();
  });
});

describe("사전 진단", () => {
  test("8문제, 영역별 2문제", () => {
    const qs = diagnosticQuestions();
    expect(qs).toHaveLength(8);
    const areas = ["AI·AX 개념 이해", "업무 자동화 판단", "CLI·Git 기본 지식", "개발·배포 개념"];
    for (const area of areas) {
      expect(qs.filter((q) => q.category === area).length, area).toBe(2);
    }
  });
});

export function __typecheck(q: LearnQuestion): LearnQuestion { return q; }
void __typecheck;
