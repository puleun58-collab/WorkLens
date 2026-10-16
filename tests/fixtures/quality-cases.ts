import type { AxDiagnosis, AxPlan } from "../../src/lib/ax/types";
import { FACTOR_KEYS, REPOSITORY_FIRST } from "../../src/lib/ax/schema";
import type { AxAgentCase } from "./ax-agent-cases";

type Factors = [repetition: number, regularity: number, dataStructure: number, systemAccess: number, humanJudgment: number, operationalRisk: number];
type Step = AxDiagnosis["stepAssessments"][number];
const step = (name: string, verdict: Step["verdict"], owner: Step["owner"], note: string): Step => ({ step: name, verdict, owner, note });
const factors = (values: Factors) => FACTOR_KEYS.map((key, index) => ({ key, aiValue: values[index], rationale: "등록된 업무 설명 근거" }));
const newPlan = (patch: Partial<AxPlan>): AxPlan => ({
  repositoryFirst: REPOSITORY_FIRST, goal: [], asIs: [], toBe: [], inScope: [], outOfScope: [], prerequisites: [], humanInLoop: [], poc: [],
  implementation: [], dataFlow: [], integrations: [], exceptions: [], fallback: [], security: [], operation: [], tests: [], acceptance: [], ...patch,
});
const base = (patch: Omit<Partial<AxDiagnosis>, "factors">, factorValues: Factors = [4, 4, 3, 2, 4, 3]): AxDiagnosis => ({
  informationSufficiency: "partial", followUpQuestions: [],
  asIs: { purpose: "", trigger: "", inputs: [], steps: [], outputs: [], exceptions: [], humanDecisions: [], systems: [] },
  factors: factors(factorValues),
  stepAssessments: [], toBe: [], humanInLoop: [], technicalChecks: [], risks: [],
  poc: { hypothesis: "", inScope: [], outOfScope: [], inputs: [], outputs: [], evaluation: [], success: [], failure: [] },
  decisionGate: { verdict: "conditional", reasons: ["샘플 확인 후 진행"] }, roadmap: [],
  operation: { owner: "업무 담당", failureOwner: "운영 담당", maintenanceBurden: "medium", fallback: "기존 수동 절차로 처리", notes: [] },
  nextAction: { label: "샘플 확인", detail: "" }, sourceNote: "사용자 등록 정보 기반 진단",
  ...patch,
});

/** 3. PDF·문서 파일 처리 — Level 1 */
export const pdfCase: AxAgentCase = {
  name: "계약서 PDF 검토 항목 추출",
  description: "계약서 PDF에서 주요 조항을 추출해 검토 항목 목록을 만들고 담당자가 확인합니다.",
  diagnosis: base({
    asIs: {
      purpose: "계약서 주요 조항을 빠짐없이 검토", trigger: "계약서 접수 시",
      inputs: ["계약서 PDF 파일"], steps: ["PDF 텍스트 추출", "조항 분류", "검토 항목 목록 생성", "담당자 확인"],
      outputs: ["검토 항목 목록"], exceptions: ["스캔 PDF", "표·이미지 포함 조항"], humanDecisions: ["검토 항목 확정"], systems: ["문서 관리 시스템"],
    },
    stepAssessments: [
      step("PDF 텍스트 추출", "자동화", "시스템", "PDF 텍스트 추출 라이브러리 사용"),
      step("조항 분류", "AI 보조", "AI", "조항 유형 후보 분류"),
      step("검토 항목 목록 생성", "자동화", "시스템", "분류 결과로 검토 항목 목록 생성"),
      step("담당자 확인", "사람 유지", "사용자", "담당자가 검토 항목 확정"),
    ],
    toBe: [
      { step: "PDF 텍스트 추출", owner: "시스템", description: "PDF에서 텍스트 추출" },
      { step: "검토 항목 목록 생성", owner: "시스템", description: "조항 분류 결과로 목록 생성" },
      { step: "담당자 확인", owner: "사용자", description: "담당자 확정" },
    ],
    humanInLoop: ["검토 항목 확정"],
    technicalChecks: [{ topic: "PDF 추출", status: "확인 필요", note: "스캔 PDF 대응 방식 확인" }],
    poc: { hypothesis: "조항 분류 후보가 검토 시간을 줄인다", inScope: [], outOfScope: ["법적 판단 자동화"], inputs: ["계약서 PDF 샘플"], outputs: ["검토 항목 목록"], evaluation: ["담당자 분류와 대조"], success: ["검토 항목 목록이 담당자 목록과 일치"], failure: ["추출 실패 조항이 정상 목록에 섞임"] },
  }),
  plan: newPlan({
    goal: ["계약서 PDF에서 검토 항목 목록을 추출하는 기능 구현"],
    inScope: ["PDF 텍스트 추출", "조항 분류 후보", "검토 항목 목록 생성"],
    outOfScope: ["법적 판단 자동화"],
    implementation: ["PDF 텍스트 추출", "조항 분류 후보", "검토 항목 목록 생성"],
    tests: ["스캔 PDF 처리", "추출 실패 분리"],
    acceptance: ["검토 항목 목록이 담당자 목록과 일치"],
    humanInLoop: ["검토 항목 확정"],
  }),
};

/** 5. 정기 보고서 생성 — Level 2 */
export const reportCase: AxAgentCase = {
  name: "월간 영업 실적 보고서",
  description: "월간 영업 데이터를 집계해 실적 보고서를 생성하고 담당자가 검토합니다.",
  diagnosis: base({
    decisionGate: { verdict: "go", reasons: [] },
    asIs: {
      purpose: "월간 영업 실적을 보고서로 정리", trigger: "매월 초",
      inputs: ["영업 데이터 Excel", "보고서 템플릿"], steps: ["데이터 집계", "실적 계산", "보고서 생성", "담당자 검토"],
      outputs: ["월간 영업 실적 보고서"], exceptions: ["데이터 누락"], humanDecisions: ["보고서 확정"], systems: ["Excel"],
    },
    stepAssessments: [
      step("데이터 집계", "자동화", "시스템", "Excel 데이터 집계"),
      step("실적 계산", "자동화", "시스템", "확정 계산식으로 실적 계산"),
      step("보고서 생성", "자동화", "시스템", "템플릿에 결과 입력"),
      step("담당자 검토", "사람 유지", "사용자", "담당자 검토"),
    ],
    toBe: [
      { step: "데이터 집계", owner: "시스템", description: "Excel 데이터 집계" },
      { step: "보고서 생성", owner: "시스템", description: "보고서 생성" },
      { step: "담당자 검토", owner: "사용자", description: "담당자 검토" },
    ],
    humanInLoop: ["보고서 확정"],
    technicalChecks: [{ topic: "보고서 템플릿", status: "확인됨", note: "템플릿 확보됨" }],
    poc: { hypothesis: "보고서 생성을 자동화할 수 있다", inScope: [], outOfScope: ["보고서 자동 발송"], inputs: ["영업 데이터 샘플"], outputs: ["월간 영업 실적 보고서"], evaluation: ["담당자 수동 보고서와 대조"], success: ["보고서 수치가 수동 집계와 일치"], failure: ["누락 데이터가 정상 집계에 포함"] },
  }, [5, 4, 4, 4, 3, 2]),
  plan: newPlan({
    goal: ["월간 영업 실적 보고서를 생성하는 기능 구현"],
    inScope: ["데이터 집계", "실적 계산", "보고서 생성"],
    outOfScope: ["보고서 자동 발송"],
    implementation: ["데이터 집계", "실적 계산", "보고서 생성"],
    tests: ["누락 데이터 분리", "계산 대조"],
    acceptance: ["보고서 수치가 수동 집계와 일치"],
    humanInLoop: ["보고서 확정"],
  }),
};
