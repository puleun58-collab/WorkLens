/** 6 business-type quality validation for the all-in-one prompt generator.
 * Checks: goal clarity, INPUT/PROCESS/OUTPUT linkage, output-scope safety,
 * HITL/Level×Gate integrity, and absence of internal jargon.
 */
import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt } from "../src/lib/ax/guide";
import { dieselCase } from "./fixtures/diesel-case";
import { pdfCase, reportCase } from "./fixtures/quality-cases";
import { freightCase, contractCase, permitCase } from "./fixtures/ax-agent-cases";
import type { AxAgentCase } from "./fixtures/ax-agent-cases";

const cases: Array<{ label: string; c: AxAgentCase }> = [
  { label: "웹 데이터 취합", c: dieselCase },
  { label: "Excel·CSV 집계", c: freightCase },
  { label: "PDF·문서 처리", c: pdfCase },
  { label: "데이터 비교·매칭", c: contractCase },
  { label: "보고서 생성", c: reportCase },
  { label: "담당자 승인형", c: permitCase },
];

const promptFor = (c: AxAgentCase) =>
  buildAllInOnePrompt(c.plan, "codex", {
    taskName: c.name, diagnosis: c.diagnosis, context: "",
  });

describe("6 business-type generation quality", () => {
  for (const { label, c } of cases) {
    describe(label, () => {
      it("has clear development goal", () => {
        const p = promptFor(c);
        expect(p).toContain("## 1. 구현 목표");
        expect(p).toContain("업무 목적");
      });

      it("has INPUT/PROCESS/OUTPUT sections", () => {
        const p = promptFor(c);
        // 실행형 6개 영역: 입력·처리·출력은 기능별 요구사항(공통 입력·출력 + 기능별 입력/처리/출력)으로 제시된다
        expect(p).toContain("## 3. 기능별 요구사항");
        expect(p).toContain("### 공통 입력·출력");
        // 구현 가능한 기능이 있는 경우에만 기능별 입력/처리/출력 줄을 요구한다 (전체 차단 케이스는 기능 블록 없음)
        if (p.includes("### 기능 1.")) {
          expect(p).toMatch(/- 입력:/);
          expect(p).toMatch(/- 처리:/);
          expect(p).toMatch(/- 출력:/);
        }
        expect(p).toContain("## 5. 구현 순서 및 검증");
      });

      it("has verifiable completion criteria", () => {
        const p = promptFor(c);
        expect(p).toContain("## 5. 구현 순서 및 검증");
        // 전체 차단 상태에서는 완료 기준을 필수 조건으로 제시하지 않고 보류 상태로 보고한다
        expect(p.includes("### 업무 전체 완료 기준") || p.includes("진행 보류 상태")).toBe(true);
      });

      it("exposes no internal field paths", () => {
        const p = promptFor(c);
        expect(p).not.toMatch(/plan\.toBe|plan\.asIs|plan\.poc|diagnosis\.stepAssessments\.note/);
        expect(p).not.toContain("연결된 진단 단계가 확인되지 않았습니다");
      });

      it("emits execution conditions without internal diagnostic grades", () => {
        const p = promptFor(c);
        // 실행 조건 섹션은 업무 목적과 실행 제약 문장만 포함한다 (진단 점수·등급 번호·Gate 상태명 없음).
        expect(p).toMatch(/### 실행 조건/);
        expect(p).not.toMatch(/자동화 (수준|가치):|기술 실현 가능성:|담당자 판단 필요도:|운영 위험:/);
        expect(p).not.toMatch(/Level [0-3]/);
      });

      it("does not instruct unattended automation", () => {
        const p = promptFor(c);
        expect(p).not.toMatch(/정기 무인 실행을 구현하세요/);
        expect(p).not.toMatch(/승인 없이.*확정하세요/);
      });
    });
  }
});
