import { describe, expect, test } from "vitest";
import { automationLevel, executionGate } from "../src/lib/ax/policy";
import { diagnosisCheckItems } from "../src/components/ax/AxReport";
import { outputFixture } from "./fixtures/ax";
import { dieselCase } from "./fixtures/diesel-case";

describe("ax to-be menu", () => {

  test("TO-BE 안내 제거가 원본 진단·판정 데이터를 바꾸지 않는다 (변경 전 기준과 대조)", () => {
    // dieselCase.diagnosis는 입력 타입이라 sourceNote가 타입에 없으므로, 런타임 값과
    // 같은 sourceNote를 명시해 AxDiagnosis로 완성한다 (값 자체는 픽스처 원본 그대로).
    const d = { ...dieselCase.diagnosis, sourceNote: "사용자 등록 정보 기반 진단" };
    // 변경 전 기준: 미확인 기술 확인 2건이 TO-BE 5단계에 연결돼 표시됐던 진단.
    expect(d.technicalChecks).toEqual([
      { topic: "보고서 양식", status: "확인 필요", note: "현재 보고 양식 확인" },
      { topic: "전주 가격 데이터", status: "확인 필요", note: "전주 가격 기록 확인" },
    ]);
    expect(d.toBe.map(s => s.step)).toEqual(["가격 입력", "증감률 계산", "월평균 계산", "보고서 업데이트", "담당자 최종 검토"]);
    // 확인 데이터는 진단 카드·02 경로에서 그대로 보인다.
    expect(diagnosisCheckItems(d).map(i => [i.title, i.badge])).toEqual([
      ["보고서 양식", "확인 필요"],
      ["전주 가격 데이터", "확인 필요"],
    ]);
    // Level·Gate 판정은 변경 전과 동일하다.
    expect(automationLevel(d)).toEqual({ level: 1, label: "L1 AI 보조", provisional: false });
    expect(executionGate(d)).toBe("conditional");
    // 대표 픽스처 2건째도 동일하게 불변이다 (outputFixture는 출력 스키마 타입이라
    // 기존 테스트와 같은 방식으로 sourceNote를 보완한다).
    const o = { ...outputFixture(), sourceNote: "test" };
    expect(o.technicalChecks).toEqual([{ topic: "시스템 접근", status: "확인 필요", note: "API와 권한 실제 확인" }]);
    expect(o.toBe.map(s => s.step)).toEqual(["검토용 표 생성", "승인"]);
    expect(automationLevel(o)).toEqual({ level: 3, label: "L3 고도 자동화", provisional: false });
    expect(executionGate(o)).toBe("conditional");
  });

});
