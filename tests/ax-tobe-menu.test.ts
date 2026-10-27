import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { automationLevel, executionGate } from "../src/lib/ax/policy";
import { diagnosisCheckItems, diagnosisSummaryParts } from "../src/components/ax/AxReport";
import { outputFixture } from "./fixtures/ax";
import { dieselCase } from "./fixtures/diesel-case";

const SRC = path.resolve(import.meta.dirname, "../src");

/** TO-BE 주황색 확인 안내 제거 + 관리 메뉴의 단계 박스 내부 배치에 대한 구조·불변성 단언.
 * 렌더링 결과 자체는 tests/e2e/ax-tobe-menu.spec.ts에서 실제 브라우저로 검증한다. */
describe("ax to-be menu", () => {
  test("TO-BE 확인 안내 렌더링 경로가 소스·스타일에서 제거됐다 (문구 부재 검사가 아님)", () => {
    const report = readFileSync(path.join(SRC, "components/ax/AxReport.tsx"), "utf8");
    const css = readFileSync(path.join(SRC, "components/ax/ax.css"), "utf8");
    // 안내를 만들던 표시 전용 연결 로직 자체가 없어야 한다.
    expect(report).not.toContain("toBeStepCheckTopics");
    expect(report).not.toContain("TOBE_CHECK_STOPWORDS");
    // 안내 전용 마크업·클래스·스타일이 없어야 한다.
    expect(report).not.toContain("ax-tobe-check");
    expect(css).not.toContain("ax-tobe-check");
    // 단계명·담당·설명·화살표·아이콘 렌더링 경로는 그대로 남는다.
    expect(report).toContain("TO-BE · 역할과 흐름 (목표 프로세스)");
    expect(report).toContain("<strong>{s.step}</strong>");
    expect(report).toContain("ax-tobe-icon");
    expect(report).toContain("ax-tobe-arrow");
    expect(report).toContain("{OWNER_LABELS[s.owner]}");
  });

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
    expect(diagnosisSummaryParts(d).check).toBe("구현 전 확인 2건");
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

  test("관리 메뉴가 단계 내비게이션 박스 내부에 있고 외부에 중복되지 않는다 (소스 구조)", () => {
    const view = readFileSync(path.join(SRC, "components/ax/AxDiagnosisView.tsx"), "utf8");
    // 외부 관리 버튼 영역(ax-data-actions)은 유틸리티 메시지만 남기고, 메뉴는 TabsList 내부에 있다.
    const dataActionsLine = view.split("\n").find(line => line.includes("ax-data-actions")) ?? "";
    expect(dataActionsLine).not.toContain("AI•AX 데이터 작업");
    const tabsList = view.slice(view.indexOf("<TabsList"), view.indexOf("</TabsList>"));
    expect(tabsList).toContain("AI•AX 데이터 작업");
    expect(tabsList).toContain("데이터 내보내기");
    expect(tabsList).toContain("데이터 가져오기");
    expect(tabsList).toContain("데이터 초기화");
    // 학습센터와 같은 공통 컴포넌트·버튼 조합을 재사용하고, 새 메뉴 컴포넌트를 만들지 않는다.
    expect(tabsList).toContain("<Menu><MenuTrigger render={<Button type=\"button\" variant=\"outline\" size=\"icon\"");
    expect(view.match(/AI•AX 데이터 작업/g)?.length).toBe(1);
    // 4개 단계 순서·명칭은 그대로다.
    expect(view).toContain("const STEPS = [\"업무 등록\", \"업무 진단\", \"자동화 매트릭스\", \"결과·로드맵\"]");
  });
});
