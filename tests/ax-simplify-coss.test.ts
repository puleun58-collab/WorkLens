import { describe, expect, it } from "vitest";
import { formatUnifiedNextAction, resolvePrecheckTarget, precheckTargetLabel, partitionReviewItems } from "../src/components/ax/AxReport";

describe("formatUnifiedNextAction", () => {
  it("먼저 확인 + 하이픈 구분을 제거하고 최우선 항목 + 외 N건으로 표시한다", () => {
    expect(formatUnifiedNextAction({ label: "먼저 확인", detail: "웹사이트 접근 권한 — 스크래핑 가능 여부와 인증 방식 확인 필요 외 4건" }))
      .toBe("웹사이트 접근 권한 확인 외 4건");
  });
  it("1건이면 외 N건을 붙이지 않는다", () => {
    expect(formatUnifiedNextAction({ label: "먼저 확인", detail: "시스템 접근" })).toBe("시스템 접근 확인");
  });
  it("확인 필요 접미사를 정리하고 동사로 끝나는 항목은 그대로 둔다", () => {
    expect(formatUnifiedNextAction({ label: "먼저 확인", detail: "API 접근 권한 확인 필요 외 2건" })).toBe("API 접근 권한 확인 외 2건");
    expect(formatUnifiedNextAction({ label: "먼저 확인", detail: "업무 목적·기대 효과 답변" })).toBe("업무 목적·기대 효과 답변");
  });
  it("먼저 확인이 아닌 라벨은 하이픈만 공백으로 바꾸고 라벨·상세를 유지한다", () => {
    expect(formatUnifiedNextAction({ label: "추가 질문 답변", detail: "원본 사이트 접근 권한이 있나요?" }))
      .toBe("추가 질문 답변 원본 사이트 접근 권한이 있나요?");
    expect(formatUnifiedNextAction({ label: "확인할 사항 검토", detail: "시스템 접근 — API와 권한 실제 확인" }))
      .toBe("확인할 사항 검토 시스템 접근 API와 권한 실제 확인");
    expect(formatUnifiedNextAction({ label: "차단 사유 해결", detail: "접근 권한 없음" })).toBe("차단 사유 해결 접근 권한 없음");
  });
  it("상세가 없으면 정책 라벨 그대로 표시한다", () => {
    expect(formatUnifiedNextAction({ label: "핵심 확인사항 확인 필요" })).toBe("핵심 확인사항 확인 필요");
  });
  it("출력에 먼저 확인·하이픈 구분자가 남지 않는다", () => {
    const outputs = [
      formatUnifiedNextAction({ label: "먼저 확인", detail: "웹사이트 접근 권한 — 스크래핑 가능 여부와 인증 방식 확인 필요 외 4건" }),
      formatUnifiedNextAction({ label: "먼저 확인", detail: "시스템 접근" }),
      formatUnifiedNextAction({ label: "추가 질문 답변", detail: "원본 사이트 접근 권한이 있나요?" }),
    ];
    for (const output of outputs) {
      expect(output).not.toContain("먼저 확인");
      expect(output).not.toContain("—");
    }
  });
});

describe("resolvePrecheckTarget", () => {
  it("출력 컬럼 미확정은 이동 버튼 없이 안내만 남긴다", () => {
    const target = resolvePrecheckTarget({ topic: "출력 컬럼 미확정", note: "출력 컬럼이 확정되지 않은 산출물: 운임결과.csv", origin: "check" });
    expect(target.kind).toBe("none");
    if (target.kind === "none") expect(target.guidance.length).toBeGreaterThan(0);
    expect(precheckTargetLabel(target)).toBe("");
  });
  it("예시 체계 제거 후 예시 부족 항목은 전용 이동 대상이 없어 확인 사항으로 연결한다", () => {
    expect(resolvePrecheckTarget({ topic: "업무 처리 예시 미확정", note: "확정 예시가 1건으로 3건 미만입니다.", origin: "check" }))
      .toEqual({ kind: "checks" });
  });
  it("예시 필수 여부 미확정(D 여러 개 언급)은 결정 지점 섹션으로 연결한다", () => {
    expect(resolvePrecheckTarget({ topic: "업무 처리 예시 확인 필요", note: "결정 지점 D1·D2·D3·D7을 확정하거나 해당 없음으로 확인하면 필수 여부가 정해집니다.", origin: "check" }))
      .toEqual({ kind: "decision" });
  });
  it("D번호 하나만 언급되면 해당 결정 지점 행으로 연결한다", () => {
    expect(resolvePrecheckTarget({ topic: "시스템 접근", note: "D4 결과 상태 미확정", origin: "check" }))
      .toEqual({ kind: "decision", id: "D4" });
  });
  it("기준 충돌은 결정 지점 섹션으로 연결한다", () => {
    expect(resolvePrecheckTarget({ topic: "합계 기준 충돌", origin: "conflict" })).toEqual({ kind: "decision" });
  });
  it("HITL·보류 항목은 HITL 검토 표로 연결한다", () => {
    expect(resolvePrecheckTarget({ topic: "HITL 검토 필요", origin: "check" })).toEqual({ kind: "hitl" });
    expect(resolvePrecheckTarget({ topic: "API 접근 권한", tone: "held", origin: "check" })).toEqual({ kind: "hitl" });
  });
  it("구현 계획·업무 정보·기타는 각각 계획 검토·업무 정보 수정·확인 사항으로 연결한다", () => {
    expect(resolvePrecheckTarget({ topic: "구현 계획 검토 필요", origin: "extra" })).toEqual({ kind: "plan" });
    expect(resolvePrecheckTarget({ topic: "업무 정보 누락", origin: "extra" })).toEqual({ kind: "register" });
    expect(resolvePrecheckTarget({ topic: "시스템 접근", note: "API와 권한 실제 확인", origin: "check" })).toEqual({ kind: "checks" });
  });
  it("이동 버튼 문구는 동작별로 구분된다", () => {
    expect(precheckTargetLabel({ kind: "decision" })).toBe("규칙 확인");
    expect(precheckTargetLabel({ kind: "hitl" })).toBe("HITL 검토");
    expect(precheckTargetLabel({ kind: "plan" })).toBe("계획 검토");
    expect(precheckTargetLabel({ kind: "register" })).toBe("업무 정보 수정");
    expect(precheckTargetLabel({ kind: "checks" })).toBe("확인 사항 보기");
  });
});

describe("partitionReviewItems", () => {
  it("미완료 항목을 우선으로 나누고 완료 항목을 분리한다", () => {
    const items = [{ key: "a" }, { key: "b" }, { key: "c" }];
    const { pending, completed } = partitionReviewItems(items, new Set(["b"]), item => item.key);
    expect(pending).toEqual([{ key: "a" }, { key: "c" }]);
    expect(completed).toEqual([{ key: "b" }]);
  });
});
