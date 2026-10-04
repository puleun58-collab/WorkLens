import type { AxDiagnosis, AxPlan, AxTask } from "../../src/lib/ax/types";
import { FACTOR_KEYS, REPOSITORY_FIRST, confirmedAxDiagnosis, axDiagnosisOutputSchema } from "../../src/lib/ax/schema";
export const diagnosisFixture: AxDiagnosis = {
  informationSufficiency: "sufficient", followUpQuestions: [],
  asIs: { purpose: "매월 자료 취합", trigger: "월말", inputs: ["입력 표"], steps: ["자료 수집", "형식 검증", "담당자 승인"], outputs: ["검토용 표"], exceptions: ["누락"], humanDecisions: ["최종 승인"], systems: ["명시된 표 도구"] },
  factors: FACTOR_KEYS.map(key => ({ key, aiValue: key === "humanJudgment" || key === "operationalRisk" ? 2 : 4, rationale: "등록된 반복 업무와 승인 조건 근거" })),
  stepAssessments: [{ step: "자료 수집", verdict: "자동화", owner: "시스템", note: "접근 권한 확인 후 적용" }, { step: "형식 검증", verdict: "AI 보조", owner: "AI", note: "제안 검토" }, { step: "담당자 승인", verdict: "사람 유지", owner: "사용자", note: "최종 승인 유지" }],
  toBe: [{ step: "검토용 표 생성", owner: "시스템", description: "규칙 기반 변환" }, { step: "승인", owner: "사용자", description: "결과 대조 후 승인" }],
  humanInLoop: ["담당자 최종 승인"], technicalChecks: [{ topic: "시스템 접근", status: "확인 필요", note: "API와 권한 실제 확인" }], risks: ["누락 데이터"],
  poc: { hypothesis: "입력 표를 정확히 취합할 수 있다", inScope: ["검토용 표 생성"], outOfScope: ["자동 승인"], inputs: ["샘플 표"], outputs: ["검토용 표"], evaluation: ["수동 결과와 대조"], success: ["대조 통과"], failure: ["누락 발생" ] },
  decisionGate: { verdict: "conditional", reasons: ["권한 확인 후 진행"] }, roadmap: [{ phase: "1", title: "확인", items: ["샘플과 권한 점검"] }],
  operation: { owner: "업무 담당", failureOwner: "운영 담당", maintenanceBurden: "low", fallback: "수동 취합으로 복귀", notes: ["변경 시 규칙 점검"] },
  nextAction: { label: "샘플 확인", detail: "샘플 표와 승인 조건 확인" }, sourceNote: "사용자 등록 정보 기반 진단",
};
export const planFixture: AxPlan = {
  repositoryFirst: REPOSITORY_FIRST, goal: ["검토용 표 생성"], asIs: ["수동 취합"], toBe: ["규칙 기반 취합과 사람 승인"], inScope: ["취합"], outOfScope: ["자동 승인"], prerequisites: ["실제 저장소와 API 확인"], humanInLoop: ["최종 승인"], poc: ["샘플 대조"], implementation: ["저장소 확인", "샘플 실험", "검증 후 구현"], dataFlow: ["입력 → 검증 → 승인"], integrations: ["시스템 접근 확인 필요"], exceptions: ["누락 시 검토"], fallback: ["수동 취합"], security: ["최소 권한"], operation: ["담당자 지정"], tests: ["샘플 대조"], acceptance: ["대조 통과"],
};
export function taskFixture(id = "task-1", diagnosis?: AxDiagnosis): AxTask {
  return { id, name: `업무 ${id}`, description: "매월 입력 표를 취합하고 담당자가 최종 승인합니다.", status: diagnosis ? "diagnosed" : "registered", ...(diagnosis ? { diagnosis } : {}), createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z" };
}
export function outputFixture() { return axDiagnosisOutputSchema.parse(confirmedAxDiagnosis(diagnosisFixture)); }
