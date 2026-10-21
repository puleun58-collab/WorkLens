import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt } from "../src/lib/ax/guide";
import { dieselCase } from "./fixtures/diesel-case";
import { contractCase, permitCase } from "./fixtures/ax-agent-cases";
import type { AxDiagnosis, AxPlan } from "../src/lib/ax/types";

/**
 * 올인원 지시문 12점 목표 고도화 — 중복·불필요 설명 제거 회귀:
 * - 방식별 검증 기준 전문은 공통 블록에 한 번만 정의하고 기능은 참조만 한다
 * - 단계별 완료 기준은 구현/확인 후 구현 그룹으로 묶어 템플릿 문장을 반복하지 않는다
 * - 결과 보고는 상태 정의 목록 없이 4개 항목으로 보고하게 한다
 * - 차단 문구·미연결 조건 안내·예외 포함 중복을 한 번만 표시한다
 * - '구현:' 처리 항목이 단계명을 그대로 재진술하지 않는다
 */
const promptFor = (c: { plan: AxPlan; name: string; diagnosis: AxDiagnosis }) =>
  buildAllInOnePrompt(c.plan, "codex", { taskName: c.name, diagnosis: c.diagnosis, context: "" });

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("중복 제거 — 검증 기준·완료 기준", () => {
  it("diesel: 방식별 검증 기준 전문은 프롬프트 전체에서 한 번만 등장한다", () => {
    const prompt = promptFor(dieselCase);
    expect(count(prompt, "확인된 형식·키·업무 규칙으로 실제 입력이 처리되고")).toBe(1);
    expect(count(prompt, "담당자가 실행을 요청할 때만 동작하고 담당자 확정 전에는 운영 결과로 반영되지 않아야 합니다")).toBe(1);
    // 모든 기능의 검증 줄은 공통 블록을 참조한다
    for (const n of [1, 2, 3, 4]) {
      const block = prompt.match(new RegExp(`### 기능 ${n}\\.[\\s\\S]*?(?=### 기능 ${n + 1}|## 4\\.)`))?.[0] ?? "";
      expect(block).toContain("검증 기준 적용 (위 '방식별 검증 기준' 참조)");
    }
  });

  it("diesel: 단계별 완료 기준은 그룹 템플릿 한 줄로 묶인다", () => {
    const prompt = promptFor(dieselCase);
    const done = prompt.match(/### 단계별 완료 기준[\s\S]*?(?=### |$)/)?.[0] ?? "";
    expect(done).toContain("확인 후 구현 단계 (가격 입력, 전주 대비 증감률 계산, 월평균 계산, 보고서 업데이트)");
    expect(count(prompt, "확인하지 못했다면 '확인·승인 대기'로 보고")).toBe(1);
  });

  it("contract: 구현 단계 그룹 완료 기준도 한 줄로 묶인다", () => {
    const prompt = promptFor(contractCase);
    const done = prompt.match(/### 단계별 완료 기준[\s\S]*?(?=### |$)/)?.[0] ?? "";
    expect(done).toContain("구현 단계 (");
    expect(done).toContain("'기능별 요구사항'의 해당 기능 검증 기준을 모두 충족하면 완료");
  });
});

describe("중복 제거 — 결과 보고·조건·예외", () => {
  it("diesel: 결과 보고에 상태별 정의 목록이 없고 4개 보고 항목만 남는다", () => {
    const prompt = promptFor(dieselCase);
    expect(prompt).not.toContain("### 완료 상태 구분");
    expect(prompt).not.toContain("구현·검증 완료: 실제 구현 후 검증 통과");
    expect(prompt).toContain("완료 상태는 실제 실행 근거로 구분해 표기하세요");
    expect(prompt).toContain("1. 구현한 기능 및 변경 파일");
    expect(prompt).toContain("4. Git·배포·운영 적용 상태");
    // Git·배포 안내는 3개 항목으로 압축된다 (차단 전용 항목 제외)
    const gitSection = prompt.match(/### Git·배포[\s\S]*?(?=\n작업이 끝나면)/)?.[0] ?? "";
    expect(gitSection.split("\n").filter(line => line.startsWith("- ")).length).toBe(3);
  });

  it("permit(차단): 차단 문구가 목표와 실행 조건에 중복되지 않는다", () => {
    const prompt = promptFor(permitCase);
    expect(count(prompt, "차단 사유가 해결되기 전에는 기능 구현·코드 생성·스캐폴딩·운영 연결을 하지 마세요")).toBe(1);
  });

  it("diesel: 미연결 조건 항목마다 표준 안내 문구가 반복되지 않는다", () => {
    const prompt = promptFor(dieselCase);
    const section = prompt.match(/### 적용 단계 확인 필요\n\n[\s\S]*?(?=\n\n미연결 조건)/)?.[0] ?? "";
    expect(section).toContain("보고서 양식");
    expect(section).not.toContain("적용 단계를 실제 의존 관계로 확인하세요");
    // 안내 자체는 섹션 뒤 단락에 한 번만 존재한다
    expect(count(prompt, "미연결 조건의 적용 대상과 의존 관계를 실제 자료로 확인하세요")).toBe(1);
  });

  it("permit: 포함 관계 예외는 긴 항목 한 번만 남는다", () => {
    const prompt = promptFor(permitCase);
    const exceptions = prompt.match(/### 예외\n\n[\s\S]*?(?=\n\n실패·미매칭)/)?.[0] ?? "";
    expect(exceptions).toContain("안전조치 미이행 상태의 작업 허가");
    expect(exceptions).not.toMatch(/^- 안전조치 미이행$/mu);
  });

  it("diesel: 처리 줄이 단계명을 '구현:' 항목으로 재진술하지 않는다", () => {
    const prompt = promptFor(dieselCase);
    expect(prompt).not.toContain("구현: 가격 입력");
    expect(prompt).not.toContain("구현: 전주 대비 증감률 계산");
    expect(prompt).not.toContain("구현: 월평균 계산");
  });
});

describe("정합성 유지 — 중복 제거 후에도 남는 것", () => {
  it("diesel: 업무 주기는 자동 실행 요구로 바뀌지 않는다", () => {
    const prompt = promptFor(dieselCase);
    expect(prompt).toContain("자동 실행 요구사항 아님");
    expect(prompt).toContain("담당자 요청 기반 실행만 허용합니다");
  });

  it("diesel: 6개 영역 구조와 판정 기준 섹션이 유지된다", () => {
    const prompt = promptFor(dieselCase);
    for (const title of ["## 1. 구현 목표", "## 2. 구현 범위", "## 3. 기능별 요구사항", "## 4. 예외 및 유지 조건", "## 5. 구현 순서 및 검증", "## 6. 결과 보고"]) {
      expect(prompt).toContain(title);
    }
    expect(prompt).toContain("### 업무 전체 완료 기준");
    expect(prompt).toContain("### 업무 전체 실패 판정 기준");
    // 성공 기준과 실패 기준이 서로 섞이지 않는다
    const success = prompt.match(/### 업무 전체 완료 기준[\s\S]*?(?=### |$)/)?.[0] ?? "";
    expect(success).toContain("증감률 계산이 담당자 수동 계산과 일치");
    expect(success).not.toContain("가격 누락 건이 정상 결과에 섞임");
  });

  it("diesel: 내부 진단 정보(Factor 점수·Level 번호·Gate 상태명)가 출력되지 않는다", () => {
    const prompt = promptFor(dieselCase);
    expect(prompt).not.toMatch(/Level\s*[0-3]\b/);
    expect(prompt).not.toContain("conditional");
    expect(prompt).not.toContain("Factor");
  });
});
