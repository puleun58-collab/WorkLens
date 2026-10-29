import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt, detectUndeterminedOutputs, parseOutputColumns, planSummary } from "@/lib/ax/guide";
import { confirmedStateNames, declaredStateCount, isUndecidableStateInvalid, parseStateNames, resolveDecisionPoints, validatedUndecidableState } from "@/lib/ax/decision-points";
import type { AxDiagnosis, AxPlan, DecisionPoint, ExampleResult } from "@/lib/ax/types";
import { diagnosisFixture, planFixture } from "./fixtures/ax";

const dp = (id: DecisionPoint["id"], status: DecisionPoint["status"], detail?: string): DecisionPoint =>
  ({ id, status, ...(detail ? { detail } : {}) }) as DecisionPoint;

const readyDiagnosis = (overrides: Partial<AxDiagnosis> = {}): AxDiagnosis => ({
  ...structuredClone(diagnosisFixture),
  decisionGate: { verdict: "go", reasons: [] },
  technicalChecks: [{ topic: "시스템 접근", status: "확인됨", note: "API 확인 완료" }],
  ...overrides,
});

const withAsIs = (diagnosis: AxDiagnosis, asIs: Partial<NonNullable<AxDiagnosis["asIs"]>>): AxDiagnosis => ({
  ...diagnosis,
  asIs: { ...diagnosis.asIs, ...asIs },
  risks: [],
});

const promptFor = (diagnosis: AxDiagnosis, plan: AxPlan = planFixture, exampleResults: ExampleResult[] = []) =>
  buildAllInOnePrompt(plan, "codex", { diagnosis, taskName: "테스트 업무", context: "", exampleResults });

const sectionOf = (prompt: string, title: string): string => {
  const part = prompt.split(`### ${title}`)[1];
  if (!part) return "";
  return part.split("\n### ")[0];
};

const decisionBlockOf = (prompt: string): string => {
  const part = prompt.split("### 결정 지점 (D1~D7)")[1];
  return part ? part.split("\n## ")[0] : "";
};

/** C01형: D1 검토 필요 vs §4 예외 정산 제외 충돌 + D4 래퍼 표기 + 컬럼 있는 출력. */
const c01Diagnosis = (): AxDiagnosis => withAsIs(readyDiagnosis({
  decisionPoints: [
    dp("D1", "확정", "미등록 판매자는 검토 필요"),
    dp("D2", "확정", "중복 거래ID 합산 제외, 검토 필요"),
    dp("D3", "확정", "음수는 환불로 합산(차감), 0은 유효, 빈칸·비숫자는 검토 필요"),
    dp("D4", "확정", "상태 정확히 3개(지급 후보/검토 필요/정산 제외)"),
    dp("D5", "확정", "검토 필요"),
    dp("D6", "확정", "0행이면 빈 결과와 처리 대상 없음 안내, 헤더만 있어도 오류 없이 처리"),
    dp("D7", "확정", "수수료 MAX(합계×3% HALF_UP, 10,000원), 지급예정액=합계-수수료"),
  ],
}), {
  outputs: ["정산결과.csv (판매자ID, 상태, 정산대상금액_원, 수수료_원, 지급예정액_원, 사유)"],
  exceptions: ["판매자마스터에 누락된 판매자ID → '정산 제외' 처리"],
});

describe("AX 명세 전달 정확성 P0 — D4 파싱·D5 검증", () => {
  it("(a) parseStateNames 변형이 모두 동일 개별 상태 배열이 된다", () => {
    const expected = ["지급 후보", "검토 필요", "정산 제외"];
    expect(parseStateNames("지급 후보/검토 필요/정산 제외")).toEqual(expected);
    expect(parseStateNames("상태 정확히 3개(지급 후보/검토 필요/정산 제외)")).toEqual(expected);
    expect(parseStateNames("상태 정확히 3개(지급 후보, 검토 필요, 정산 제외)만 사용한다")).toEqual(expected);
    expect(parseStateNames("지급 후보, 검토 필요/정산 제외")).toEqual(expected);
    expect(parseStateNames("지급 후보·검토 필요·정산 제외")).toEqual(expected);
    expect(parseStateNames("지급 후보, , 검토 필요,, 정산 제외")).toEqual(expected);
    expect(parseStateNames("지급 후보, 검토 필요, 정산 제외, 3개")).toEqual(expected);
    expect(parseStateNames("1.5 이상, 1.5 미만")).toEqual(["1.5 이상", "1.5 미만"]);
    expect(declaredStateCount("상태 정확히 3개(지급 후보/검토 필요/정산 제외)")).toBe(3);
    expect(declaredStateCount("지급 후보, 검토 필요, 정산 제외")).toBeNull();
  });

  it("(a) D4 래퍼 표기 입력 시 지시문 결정 지점 블록에 개별 상태 목록만 나온다", () => {
    const prompt = promptFor(c01Diagnosis(), { ...planFixture, exceptions: [] });
    expect(decisionBlockOf(prompt)).toContain("D4 결과 상태 — 확정: 지급 후보 · 검토 필요 · 정산 제외");
    expect(decisionBlockOf(prompt)).not.toContain("상태 정확히 3개(");
    expect(prompt).toContain("결과 상태 목록: 지급 후보 · 검토 필요 · 정산 제외 —");
    expect(confirmedStateNames(resolveDecisionPoints(c01Diagnosis()))).toEqual(["지급 후보", "검토 필요", "정산 제외"]);
  });

  it("(b) D5가 D4 목록에 없으면 덩어리·목록 외 상태를 인용하지 않고 'D5 상태명 미확정'으로 표시한다", () => {
    const chunkD5 = readyDiagnosis({
      decisionPoints: [
        dp("D4", "확정", "지급 후보, 검토 필요, 정산 제외"),
        dp("D5", "확정", "상태 정확히 3개(지급 후보/검토 필요/정산 제외)"),
      ],
    });
    expect(isUndecidableStateInvalid(resolveDecisionPoints(chunkD5))).toBe(true);
    expect(validatedUndecidableState(resolveDecisionPoints(chunkD5))).toBeNull();
    const chunkPrompt = promptFor(chunkD5);
    expect(chunkPrompt).toContain("D5 상태명 미확정");
    expect(sectionOf(chunkPrompt, "미확정 항목 처리")).not.toContain("상태 정확히 3개(");
    expect(decisionBlockOf(chunkPrompt)).toContain("D5 판단 불가 — 확정: D5 상태명 미확정");

    const outsideD5 = readyDiagnosis({
      decisionPoints: [
        dp("D4", "확정", "지급 후보, 검토 필요, 정산 제외"),
        dp("D5", "확정", "미확인 상태"),
      ],
    });
    expect(isUndecidableStateInvalid(resolveDecisionPoints(outsideD5))).toBe(true);
    expect(promptFor(outsideD5)).toContain("D5 상태명 미확정");
  });

  it("(b) D5가 D4 목록에 속한 단일 상태명이면 기존대로 인용한다", () => {
    const diagnosis = c01Diagnosis();
    expect(validatedUndecidableState(resolveDecisionPoints(diagnosis))).toBe("검토 필요");
    expect(isUndecidableStateInvalid(resolveDecisionPoints(diagnosis))).toBe(false);
    const prompt = promptFor(diagnosis, { ...planFixture, exceptions: [] });
    expect(prompt).toContain("미확정 규칙에 해당하는 행만 '검토 필요'로 보내고");
  });
});

describe("AX 명세 전달 정확성 P0 — 충돌·외부 행위·출력 미확정", () => {
  it("(c) D1 vs §4 예외 상태 충돌 시 충돌 섹션으로 분리되고 단정적 잔존이 없다", () => {
    const prompt = promptFor(c01Diagnosis());
    expect(prompt).toContain("### 결정 지점·예외 충돌 (확인 필요)");
    expect(sectionOf(prompt, "결정 지점·예외 충돌 (확인 필요)")).toContain("검토 필요 / 정산 제외");
    expect(sectionOf(prompt, "예외")).not.toContain("판매자마스터에 누락된 판매자ID");
    // D 블록 보호 유지: 결정 지점 블록 자체는 그대로 둔다.
    expect(decisionBlockOf(prompt)).toContain("D1 기준과 매칭 — 확정: 미등록 판매자는 검토 필요");
    expect(sectionOf(prompt, "미확정 항목 처리")).toContain("결정 지점·예외 충돌 1건 (확인 필요)");
    expect(prompt).not.toContain("미확정 항목: 없음");
  });

  it("(c) D3 vs §4 예외 특이값 누락(0) 시 충돌 섹션으로 분리된다", () => {
    const diagnosis = withAsIs(readyDiagnosis({
      decisionPoints: [
        dp("D1", "확정", "일요일~토요일 주 그룹화, 구간 2026-09-27~2026-10-31, 출력 5주"),
        dp("D3", "확정", "0·음수·비숫자·빈칸 가격은 해당 주 확인 필요"),
        dp("D4", "확정", "상태 정확히 4개(완료/미완료/확인 필요/데이터 없음)"),
        dp("D5", "확정", "확인 필요"),
        dp("D6", "확정", "데이터 없어도 5주 모두 데이터 없음으로 출력"),
        dp("D7", "확정", "서로 다른 날짜 7개 있는 주만 평균(0.01원 HALF_UP)"),
      ],
    }), {
      outputs: ["주간집계.csv (컬럼: 주시작일, 주종료일, 평균가격, 전주대비증감률, 상태)"],
      exceptions: ["가격 값이 비숫자·음수·빈칸 → 확인 필요"],
    });
    const prompt = promptFor(diagnosis, { ...planFixture, exceptions: [] });
    expect(prompt).toContain("### 결정 지점·예외 충돌 (확인 필요)");
    expect(sectionOf(prompt, "결정 지점·예외 충돌 (확인 필요)")).toContain("특이값(0)");
    expect(sectionOf(prompt, "예외")).not.toContain("가격 값이 비숫자");
    expect(prompt).not.toContain("미확정 항목: 없음");
  });

  it("(d) 미연결 외부 행위 기준은 완료 기준이 아니라 '확인 필요(외부 행위)'로 분리되고 출처가 표시된다", () => {
    const plan: AxPlan = {
      ...planFixture,
      exceptions: [],
      acceptance: ["예외 발생 시 담당자 알림이 정상 전송되어야 함", "모든 결과가 검증 파일과 대조된다"],
    };
    const prompt = promptFor(c01Diagnosis(), plan);
    const external = sectionOf(prompt, "확인 필요(외부 행위)");
    expect(external).toContain("담당자 알림이 정상 전송되어야 함");
    expect(external).toContain("[출처: 계획 acceptance]");
    expect(sectionOf(prompt, "업무 전체 완료 기준")).not.toContain("담당자 알림이 정상 전송되어야 함");
    expect(sectionOf(prompt, "업무 전체 완료 기준")).toContain("모든 결과가 검증 파일과 대조된다");
    expect(sectionOf(prompt, "업무 전체 완료 기준")).toContain("[출처: 계획 acceptance]");
    expect(sectionOf(prompt, "참고 판정 (필수 완료 조건 아님)")).not.toContain("담당자 알림이 정상 전송되어야 함");
  });

  it("(e) 출력 컬럼 미지정 시 '출력 컬럼 미확정'을 명시하고 임의 컬럼명을 만들지 않는다", () => {
    const c04 = withAsIs(readyDiagnosis({
      decisionPoints: [
        dp("D1", "확정", "별칭표 정규화(앞뒤 공백 제거 뒤 정확한 문자열 매칭만, 추측·유사도 금지) 후 운임표 매칭"),
        dp("D2", "확정", "중복 운송ID 2행 이상이면 해당 모든 행 입력 오류"),
        dp("D3", "확정", "CBM 0 이상 숫자만 허용, 음수·빈칸·비숫자·운송ID/거래처명/권역 누락은 입력 오류, CBM=0 유효"),
        dp("D4", "확정", "상태 정확히 4개(계산 완료/거래처 확인 필요/운임 규칙 확인 필요/입력 오류)"),
        dp("D5", "확정", "입력 오류"),
        dp("D6", "확정", "0행이면 빈 결과와 처리 대상 없음 표시, 필수 마스터 누락은 입력 파일 오류로 중단"),
        dp("D7", "확정", "운임=기본운임+CBM×CBM당운임·원 단위 HALF_UP, VAT·할증·최저운임 임의 추가 금지"),
      ],
    }), {
      outputs: ["운임결과.csv (원본 모든 행에 대해 한 행씩)"],
      exceptions: [],
    });
    expect(parseOutputColumns("운임결과.csv (원본 모든 행에 대해 한 행씩)")).toBeNull();
    expect(detectUndeterminedOutputs(["운임결과.csv (원본 모든 행에 대해 한 행씩)"])).toEqual(["운임결과.csv"]);
    const prompt = promptFor(c04, { ...planFixture, exceptions: [] });
    expect(prompt).toContain("출력 컬럼 미확정: 운임결과.csv");
    expect(prompt).toContain("컬럼명을 임의로 만들지 않는다");
    expect(sectionOf(prompt, "미확정 항목 처리")).toContain("출력 컬럼 미확정 (운임결과.csv)");
    expect(prompt).not.toContain("미확정 항목: 없음");
    const summary = planSummary(c04, { ...planFixture, exceptions: [] }, "", {});
    expect(summary.checks.some(check => check.topic === "출력 컬럼 미확정")).toBe(true);

    // 대조: 컬럼이 있는 출력은 미확정 카드·문구가 없다.
    const c01Prompt = promptFor(c01Diagnosis(), { ...planFixture, exceptions: [] });
    expect(c01Prompt).not.toContain("출력 컬럼 미확정");
    const c01Summary = planSummary(c01Diagnosis(), { ...planFixture, exceptions: [] }, "", {});
    expect(c01Summary.checks.some(check => check.topic === "출력 컬럼 미확정")).toBe(false);
  });
});

describe("AX 명세 전달 정확성 P0 — 내용 미확정·도구 대칭·전후 비교", () => {
  it("(f) 내용 미확정이 있으면 '미확정 항목: 없음'이 아니며, 깨끗한 입력에서는 '없음'이 유지된다", () => {
    for (const prompt of [
      promptFor(c01Diagnosis()),
      promptFor(readyDiagnosis({
        decisionPoints: [dp("D4", "확정", "지급 후보, 검토 필요, 정산 제외"), dp("D5", "확정", "미확인 상태")],
      })),
    ]) {
      expect(prompt).not.toContain("미확정 항목: 없음");
      expect(sectionOf(prompt, "미확정 항목 처리")).toContain("내용 미확정:");
    }
    const clean = withAsIs(readyDiagnosis({
      decisionPoints: [
        dp("D1", "확정", "기준 파일 A, 키 주문번호"),
        dp("D2", "확정", "중복 키는 첫 건만 처리"),
        dp("D3", "확정", "음수는 확인 필요"),
        dp("D4", "확정", "정상, 확인 필요"),
        dp("D5", "확정", "확인 필요"),
        dp("D6", "확정", "빈 파일은 오류 없이 빈 결과"),
        dp("D7", "확정", "합계는 소수 둘째 자리 반올림"),
      ],
    }), {
      outputs: ["결과.csv (주문번호, 상태, 금액)"],
      exceptions: ["누락 시 검토"],
    });
    const cleanPrompt = promptFor(clean, { ...planFixture, exceptions: [] });
    expect(cleanPrompt).toContain("미확정 항목: 없음");
    expect(cleanPrompt).not.toContain("내용 미확정:");
  });

  it("(g) 동일 진단 입력 시 Codex·Claude D 블록이 동일하고, 계획 차이(외부 행위)는 도구별로만 갈린다", () => {
    const diagnosis = c01Diagnosis();
    const codexPlan: AxPlan = { ...planFixture, exceptions: [], acceptance: ["예외 발생 시 담당자 알림이 정상 전송되어야 함"] };
    const claudePlan: AxPlan = { ...planFixture, exceptions: [], acceptance: ["모든 결과가 검증 파일과 대조된다"] };
    const opts = { diagnosis, taskName: "테스트 업무", context: "", exampleResults: [] as ExampleResult[] };
    const codex = buildAllInOnePrompt(codexPlan, "codex", opts);
    const claude = buildAllInOnePrompt(claudePlan, "claude", opts);
    expect(decisionBlockOf(codex)).toBe(decisionBlockOf(claude));
    expect(sectionOf(codex, "확인 필요(외부 행위)")).toContain("담당자 알림");
    expect(claude).not.toContain("담당자 알림");
    expect(sectionOf(codex, "결정 지점·예외 충돌 (확인 필요)")).toBe(sectionOf(claude, "결정 지점·예외 충돌 (확인 필요)"));
  });

  it("(h) D4 표기 변형 세트에 대해 결정 지점 블록·미확정 처리 섹션이 동일하다 (의도된 정규화만 존재)", () => {
    const variants = [
      "지급 후보/검토 필요/정산 제외",
      "상태 정확히 3개(지급 후보/검토 필요/정산 제외)",
      "지급 후보, 검토 필요, 정산 제외",
      "지급 후보·검토 필요·정산 제외만 사용한다",
    ];
    const prompts = variants.map(d4 => promptFor(readyDiagnosis({
      decisionPoints: [
        dp("D4", "확정", d4),
        dp("D5", "확정", "검토 필요"),
      ],
    }), { ...planFixture, exceptions: [] }));
    const blocks = prompts.map(decisionBlockOf);
    const undecided = prompts.map(prompt => sectionOf(prompt, "미확정 항목 처리"));
    for (const block of blocks) {
      expect(block).toBe(blocks[0]);
      expect(block).toContain("D4 결과 상태 — 확정: 지급 후보 · 검토 필요 · 정산 제외");
      expect(block).not.toContain("상태 정확히 3개(");
    }
    for (const section of undecided) expect(section).toBe(undecided[0]);
  });
});
