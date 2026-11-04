import { describe, expect, it } from "vitest";
import { buildAllInOnePrompt, detectUndeterminedOutputs, planSummary } from "@/lib/ax/guide";
import { diagnosisFixture } from "./fixtures/ax";

const answer = "ledger.csv의 컬럼은 거래일, 합계금액입니다. 순서는 거래일 다음 합계금액이며 거래일은 YYYY-MM-DD 날짜 문자열, 합계금액은 원 단위 숫자입니다. 입력 거래일별 금액을 합산해 합계금액에 넣습니다.";
const outputs = ["ledger.csv", "ledger.csv의 컬럼은 거래일, 합계금액"];
const context = (value: string) => `결과는 ledger.csv로 저장합니다. 컬럼명·순서·타입은 아직 정하지 않았습니다.\n추가 확인:\n산출물 명세: ${value}`;
function diagnosis(values = outputs) {
  return { ...structuredClone(diagnosisFixture), asIs: { ...diagnosisFixture.asIs, outputs: values }, poc: { ...diagnosisFixture.poc, outputs: [] }, technicalChecks: [] };
}
describe("같은 파일의 최신 답변을 소비하는 출력 명세 검사", () => {
  it("완전 답변은 원문 미정 기록을 삭제하지 않고 컬럼 조건만 해소한다", () => {
    const evidence = context(answer);
    expect(detectUndeterminedOutputs(outputs, evidence)).toEqual([]);
    expect(planSummary(diagnosis(), undefined, evidence).checks).toEqual([]);
    const prompt = buildAllInOnePrompt(undefined, "codex", { diagnosis: diagnosis(), context: evidence });
    expect(prompt).not.toContain("출력 컬럼 미확정");
    expect(prompt).toContain("실제 데이터로 검증");
    expect(evidence).toContain("아직 정하지 않았습니다");
  });
  it.each([
    "ledger.csv의 컬럼은 거래일, 합계금액입니다.",
    "ledger.csv의 컬럼은 거래일, 합계금액입니다. 순서는 거래일 다음 합계금액입니다.",
    "ledger.csv의 컬럼은 거래일, 합계금액입니다. 순서는 거래일 다음 합계금액이며 거래일은 날짜 문자열, 합계금액은 숫자입니다.",
    "오늘 점심은 김밥입니다.",
  ])("부분·무관 답변은 유지한다: %s", value => {
    const evidence = context(value);
    expect(detectUndeterminedOutputs(outputs, evidence)).toEqual(["ledger.csv"]);
    expect(planSummary(diagnosis(), undefined, evidence).checks.some(check => check.topic === "출력 컬럼 미확정")).toBe(true);
    expect(buildAllInOnePrompt(undefined, "codex", { diagnosis: diagnosis(), context: evidence })).toContain("출력 컬럼 미확정");
  });
  it("다른 파일과 불명확한 파일 없는 답변으로 해소하지 않는다", () => {
    expect(detectUndeterminedOutputs(["ledger.csv", "second.csv"], context(answer))).toEqual(["second.csv"]);
    expect(detectUndeterminedOutputs(["second.csv"], context(answer))).toEqual(["second.csv"]);
    expect(detectUndeterminedOutputs(["ledger.csv"], answer.replace("ledger.csv의 ", ""))).toEqual(["ledger.csv"]);
  });
  it("컬럼·순서·타입 상충은 자동 선택하지 않는다", () => {
    expect(detectUndeterminedOutputs([...outputs, "ledger.csv (컬럼: 거래일, 금액)"], context(answer))).toEqual(["ledger.csv"]);
    expect(detectUndeterminedOutputs([...outputs, "ledger.csv (컬럼: 합계금액, 거래일)"], context(answer))).toEqual(["ledger.csv"]);
    expect(detectUndeterminedOutputs(outputs, `${context(answer)}\n\n사용자 답변: ledger.csv의 합계금액은 문자열입니다.`)).toEqual(["ledger.csv"]);
  });
  it("구조화된 같은 파일의 명세도 bare 파일명과 합친다", () => {
    expect(detectUndeterminedOutputs(["ledger.csv", "ledger.csv (컬럼: 거래일, 금액; 타입: 거래일=날짜, 금액=숫자)"])).toEqual([]);
  });
});
