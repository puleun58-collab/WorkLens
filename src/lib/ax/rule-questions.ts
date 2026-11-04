/**
 * 업무 규칙 확인 — 통합 목록 도출 (고정 D1~D7 표시의 대체).
 *
 * 원칙 (지시문 §4):
 * - 고정 목록을 모든 업무에 무조건 표시하지 않는다. 질문은 진단 데이터의 구조적
 *   필드(등록·목적·입출력·AS-IS 단계·진단·단계별 판단·구현/제외 범위·기존 확정·
 *   HITL·미확정)에서만 도출하고, 업무명·자유 텍스트 키워드만으로 유형을 확정하지 않는다.
 * - AI 제안 ≠ 자동 확정. 도출된 행은 후보(미확정 / 적용 여부 미확정)로만 표시하고,
 *   근거 없는 자동 확정·자동 해당 없음은 하지 않는다.
 * - 기존 D1~D7 ID·의미·확정 상태·상세를 보존한다. 저장된 행이 있는 측면은 후보를
 *   만들지 않으며, 의미가 일부만 겹치는 규칙은 자동 병합하지 않는다.
 * - 완료 현황은 실제 확인 대상 기준이다. 고정 7을 분모로 쓰지 않고, 숨김으로
 *   완료율을 높이지 않으며, 적용 여부 미확정 규칙과 미터치 후보도 분모에 포함한다.
 */
import { DECISION_POINT_IDS } from "./schema";
import type { AxDiagnosis, DecisionPoint, DecisionPointId, DecisionPointStatus, GenericRule, GenericRuleApplicability, GenericRuleCategory, GenericRuleStatus } from "./types";
import { genericRuleConditionKey, resolveGenericRules } from "./generic-rules";
import type { RuleProgress } from "./generic-rules";
import { parseStateNames } from "./decision-points";

/** 표시 전용 D1~D7 제목·설명. 지시문 생성은 기존 DEFS 제목을 쓰므로 여기를 바꿔도 지시문은 바뀌지 않는다. */
export const DECISION_DISPLAY: Record<DecisionPointId, { title: string; question: string }> = {
  D1: { title: "대조 기준", question: "어떤 자료와 항목을 기준으로 비교하나요?" },
  D2: { title: "중복 처리", question: "동일한 항목이 여러 번 나타나면 어떻게 처리하나요?" },
  D3: { title: "예외 처리", question: "비정상 값·형식 오류·조건 불일치가 발생하면 어떻게 처리하나요?" },
  D4: { title: "결과 상태", question: "처리 결과를 어떤 상태로 구분하나요?" },
  D5: { title: "판단 불가 처리", question: "정보가 부족하거나 판단할 수 없을 때 어떻게 처리하나요?" },
  D6: { title: "빈 입력 처리", question: "수신할 파일이나 데이터가 없을 때 어떻게 처리하나요?" },
  D7: { title: "계산 기준", question: "합계·반올림·단위의 기준은 무엇인가요?" },
};

/** 표시 전용: D카드별 상세 입력 제목·안내 문구 (지시문 생성과 무관). 모든 카드에 '대조 기준'을 반복하지 않는다. */
export const DECISION_DETAIL_FIELD: Record<DecisionPointId, { label: string; placeholder: string }> = {
  D1: { label: "대조 기준", placeholder: "기준 파일·시트·대조 키·누락·초과 판단 방향을 적으세요" },
  D2: { label: "중복 처리 기준", placeholder: "같은 항목이 여러 번 나타날 때 판단 키와 처리 방법을 적으세요" },
  D3: { label: "예외 처리 기준", placeholder: "비정상 값·형식 오류·조건 불일치의 처리 방법을 적으세요" },
  D4: { label: "상태 구분 기준", placeholder: "처리 결과를 어떤 상태로 구분할지 적으세요" },
  D5: { label: "판단 불가 처리 기준", placeholder: "정보 부족·판단 불가 상황의 처리 기준을 적으세요" },
  D6: { label: "빈 입력 처리 기준", placeholder: "파일 미수신·빈 파일과 데이터 없음 상황을 구분해 적으세요" },
  D7: { label: "계산 기준", placeholder: "합계·반올림·단위 기준을 적으세요" },
};
export function decisionPanelLabel(id: string, kind: "상태" | "상세"): string {
  return kind === "상세" ? DECISION_DETAIL_FIELD[id as DecisionPointId]?.label ?? "처리 기준" : kind;
}

export type UnifiedRuleOrigin = "stored" | "candidate" | "user";

export interface UnifiedDecisionDraft {
  kind: "decision";
  id: DecisionPointId;
  status: DecisionPointStatus;
  /** 화면 표시용 상세. 미확정 행의 detail은 표시만 하고 생성 경로에서는 버려진다. */
  detail: string;
  origin: UnifiedRuleOrigin;
  /** 후보일 때만 있다. */
  sourceLabel?: string;
  /** 후보일 때만 있다. 도출 근거 문장. */
  provenance?: string;
  displayTitle?: string;
  displayQuestion?: string;
}

export interface UnifiedGenericDraft {
  kind: "generic";
  /** 후보는 아직 id가 없다. 저장 시 nextGenericRuleId로 부여한다. */
  id: string | null;
  name: string;
  category: GenericRuleCategory;
  applicability: GenericRuleApplicability;
  status: GenericRuleStatus;
  detail: string;
  source: string;
  step: string;
  linkedDecisionId?: DecisionPointId;
  origin: UnifiedRuleOrigin;
  sourceLabel?: string;
  provenance?: string;
  /** 이름·근거 표시 문구와 독립적인 후보 식별자. 저장 ID와 별도 공간이다. */
  candidateKey?: string;
  /**
   * 컴포넌트 로컬 플래그. 저장 페이로드 판정용이다 (저장되지 않음):
   * - stored 행은 항상 페이로드에 포함한다 (제외하면 저장된 규칙이 삭제되기 때문).
   * - user 행(모달 추가)은 사용자가 직접 추가했으므로 페이로드에 포함한다.
   * - candidate 행은 사용자가 건드린 경우에만 페이로드에 포함한다. 건드리지 않은
   *   후보를 저장하면 사용자의 저장 의도와 무관하게 도출물이 저장 기록으로 바뀌므로,
   *   미터치 후보는 저장에서 빼고 다음 렌더링에서 다시 도출되게 한다.
   */
  touched?: boolean;
}

export type UnifiedRuleDraft = UnifiedDecisionDraft | UnifiedGenericDraft;

const normalize = (value: string): string => value.replace(/\s+/gu, " ").trim();
const cleanList = (list?: readonly string[] | null): string[] =>
  (list ?? []).map(item => (typeof item === "string" ? item.trim() : "")).filter(Boolean);

/** 직접 의문 어미(…나요?·…까요·…습니까·…인가 등). 끝의 마침표·물음표는 별도로 허용한다. */
const DIRECT_QUESTION_ENDING = /(?:나요|까요|가요|습니까|읍니까|입니까|ㅂ니까|합니까|됩니까|있나|없나|인가|는가|은가|을까|일까|할까|될까|는지요|인지요|은지요|을지요)$/u;
/** 간접 의문·확인 요청(…인지 확인 필요·…할지 문의·…여부 확인 등): 처리 기준이 아니라 답을 요구한다. */
const INDIRECT_QUESTION_ENDING = /(?:인지|는지|은지|을지|할지|될지|일지|여부)\s*(?:를|을)?\s*(?:확인|문의|질문|결정|파악)?\s*(?:이|가)?\s*(?:필요|요청|필요함|필요합니다|해\s*주세요|하세요|바랍니다)?$/u;

/**
 * 확인 질문(정보 요청) 판정. 물음표 유무만으로 판단하지 않고 문장의 목적(직접 의문 어미,
 * "…인지·…할지·…여부 확인" 같은 간접 의문·확인 요청)으로 구분한다. 조건·처리·결과를
 * 진술하는 문장(…한다·…함·명사형 기준)은 질문이 아니다. 질문은 답변할 질문 영역에서
 * 다루며, 처리 기준이 없는 질문은 업무 규칙 후보로 승격하지 않는다.
 */
export function isConfirmationQuestion(text: string): boolean {
  const value = normalize(text);
  if (!value) return false;
  if (/[?？]$/u.test(value)) return true;
  const body = value.replace(/[.。!]+$/u, "").trim();
  return DIRECT_QUESTION_ENDING.test(body) || INDIRECT_QUESTION_ENDING.test(body);
}

/** 저장된 D 행. id·상태가 유효한 것만 남기고, 중복 id는 첫 항목만 유지한다. */
function storedDecisionRows(diagnosis: AxDiagnosis): UnifiedDecisionDraft[] {
  const seen = new Set<string>();
  const out: UnifiedDecisionDraft[] = [];
  for (const point of diagnosis.decisionPoints ?? []) {
    if (!point || !(DECISION_POINT_IDS as readonly string[]).includes(point.id)) continue;
    if (seen.has(point.id)) continue;
    if (point.status !== "확정" && point.status !== "미확정" && point.status !== "해당 없음") continue;
    seen.add(point.id);
    out.push({
      kind: "decision",
      id: point.id,
      status: point.status,
      detail: typeof point.detail === "string" ? point.detail : "",
      origin: "stored",
    });
  }
  return out;
}

interface RuleEvidence {
  text: string;
  source: string;
  step: string;
}

const meaningful = (text: string): boolean =>
  Boolean(text.trim()) && !/^(?:(?:예외|특이사항|오류)\s*(?:사항)?\s*)?(?:없음|해당\s*없음|없다|불필요|미해당|해당하지\s*않음)[.。]?$/u.test(text.trim());

/** 업무명·확장자·입력 개수가 아니라, 처리 단계와 그 조건을 함께 읽는다. */
function processEvidence(diagnosis: AxDiagnosis): RuleEvidence[] {
  const asIs = diagnosis.asIs;
  const rows: RuleEvidence[] = [];
  const add = (text: string | undefined, source: string, step = ""): void => {
    if (text && meaningful(text) && !isConfirmationQuestion(text)) rows.push({ text: text.trim(), source, step });
  };
  add(asIs?.purpose, "AS-IS 목적");
  add(asIs?.trigger, "AS-IS 시작 조건");
  for (const step of cleanList(asIs?.steps)) add(step, "AS-IS 업무 단계", step);
  for (const item of diagnosis.stepAssessments ?? []) {
    add(item.step, "단계별 판단", item.step);
    add(item.note, "단계별 판단 근거", item.step);
  }
  for (const item of diagnosis.toBe ?? []) {
    add(item.step, "TO-BE 업무 단계", item.step);
    add(item.description, "TO-BE 처리 조건", item.step);
  }
  for (const item of cleanList(diagnosis.poc?.inScope)) add(item, "PoC 구현 범위");
  for (const item of cleanList(diagnosis.risks)) {
    if (RUNTIME.test(item) || UNKNOWN.test(item)) add(item, "진단 위험·처리 조건");
  }
  return rows;
}

const EXCEPTION = /누락|누설|비정상|오류|불일치|미일치|잘못|유효하지|불충족|미충족|위험\s*(?:징후|발생|감지)|초과|미달|음수|빈칸|결측|이상\s*값|실패|중단/u;
const UNKNOWN = /정보(?:가|는)?\s*(?:부족|누락)|자료(?:가|는)?\s*(?:부족|미비)|판단\s*(?:불가|불능|어려)|판정\s*(?:불가|불능)|(?:판단|판정)(?:할)?\s*수\s*없|확인\s*불가|불명확|알\s*수\s*없|근거(?:가|는)?\s*(?:부족|없)|누락|미비/u;
const CALCULATION = /계산|집계|합산|합계|산출|산식|평균|반올림|절사|가동\s*(?:률|율)|비율|수치\s*판(?:단|정)|수량.*(?:초과|미달)|(?:금액|수치|측정값|온도|압력).*(?:이상|이하|초과|미만|임계|기준값)/u;
const REVIEW = /검토|심사|승인|결재|판단|판정|안전\s*점검|위험.*(?:평가|점검)|점검.*위험/u;
const DUPLICATE = /중복|재접수|재요청|이중|반복\s*(?:요청|실행|접수)|동일한?.*(?:요청|거래|건|입력).*(?:여러|다시|재실행)/u;
const INTAKE = /(?:파일|데이터|자료|기록|내역|피드|로그|응답|표).*(?:수신|수집|취합|업로드|불러|읽|입력받|전송받)|(?:수신|수집|취합|업로드|불러|읽).*(?:파일|데이터|자료|기록|내역|피드|로그|표)/u;
const RUNTIME = /(?:실패|오류|누락|불가|위험|중복|초과|미달|미충족|불일치|기한|마감|지연|반려|승인|검토).*(?:시(?:에는|에|는)?|하면|되면|경우|후|전|유지|한다|처리|기록|알림|재시도|중단|보류|배정|분리)|(?:재시도|오류\s*기록|담당자\s*알림|수동\s*처리)/u;

/** 기술 선행 조건은 그대로 확인 영역에 남기고, 명시된 실행 중 처리 절만 규칙으로 읽는다. */
function runtimeCheckEvidence(diagnosis: AxDiagnosis): RuleEvidence[] {
  const out: RuleEvidence[] = [];
  for (const check of diagnosis.technicalChecks ?? []) {
    for (const text of [check.topic, check.note]) {
      const clauses = text.split(/[;；\n]|[.。](?:\s|$)|\s+및\s+|(?:API|권한)[^;；\n.。]*?확인(?:하고|한\s*후|과|,)\s*/u);
      for (const clause of clauses) {
        if (meaningful(clause) && !isConfirmationQuestion(clause) && RUNTIME.test(clause)) {
          out.push({ text: clause.trim(), source: `기술적 확인 항목 "${check.topic}"`, step: "" });
        }
      }
    }
  }
  return out;
}

/**
 * 진단에서 통합 목록 초안을 도출한다.
 * - 저장된 D 행(상태 무관) + 저장된 범용 규칙은 그대로 두고, 없는 측면만 후보로 채운다.
 * - 후보는 미확정 / 적용 여부 미확정 상태로만 만든다 (자동 확정·자동 해당 없음 없음).
 */
export function deriveUnifiedRules(diagnosis: AxDiagnosis, storedGeneric?: readonly GenericRule[] | null): UnifiedRuleDraft[] {
  const asIs = diagnosis.asIs ?? {};
  const poc = diagnosis.poc ?? {};
  const process = processEvidence(diagnosis);
  const inputs = cleanList(asIs.inputs);
  const outputs = cleanList(asIs.outputs);
  const exceptions: RuleEvidence[] = cleanList(asIs.exceptions).filter(meaningful)
    .filter(text => !isConfirmationQuestion(text)).map(text => ({ text, source: "AS-IS 예외", step: "" }));
  const human: RuleEvidence[] = [
    ...cleanList(asIs.humanDecisions).map(text => ({ text, source: "AS-IS 사람 판단", step: "" })),
    ...cleanList(diagnosis.humanInLoop).map(text => ({ text, source: "사람 개입(HITL)", step: "" })),
  ].filter(item => meaningful(item.text) && !isConfirmationQuestion(item.text));
  const runtime = runtimeCheckEvidence(diagnosis);
  const conditions = [...process, ...exceptions, ...human, ...runtime];
  const outcomes: RuleEvidence[] = [
    ...cleanList(poc.success).map(text => ({ text, source: "PoC 성공 기준", step: "" })),
    ...cleanList(poc.failure).map(text => ({ text, source: "PoC 실패 기준", step: "" })),
  ].filter(item => meaningful(item.text) && !isConfirmationQuestion(item.text));
  const storedDMap = new Map(storedDecisionRows(diagnosis).map(row => [row.id, row]));
  const signals = new Map<DecisionPointId, RuleEvidence[]>();
  const signal = (id: DecisionPointId, rows: RuleEvidence[]): void => {
    if (rows.length) signals.set(id, rows);
  };
  // 대조 동작과 실제 대상이 모두 필요하다. 시스템 수·확장자·명칭만으로는 도출하지 않는다.
  const comparisons = process.filter(item => /비교|대조|대사|매칭/u.test(item.text));
  signal("D1", comparisons.filter(item => new Set(inputs.map(normalize)).size >= 2
    || /(?:기준|원본|수동\s*결과|두\s*(?:자료|표|데이터)|서로|내역.*(?:와|과)|대장.*(?:와|과)).*(?:비교|대조|대사|매칭)|(?:비교|대조).*(?:기준|원본|대상)/u.test(item.text)));
  signal("D2", conditions.filter(item => DUPLICATE.test(item.text)));
  signal("D3", [...exceptions, ...conditions.filter(item => EXCEPTION.test(item.text) && RUNTIME.test(item.text))]);
  signal("D4", [...outcomes, ...conditions.filter(item => /(?:상태|결과).*(?:구분|분류|표시|판정)|(?:승인|반려|정상|위험|보류).*(?:구분|분류)/u.test(item.text))]);
  // 구현 권한·API 확인 필요(Gate)와 실행 중 정보 부족은 서로 다른 문제다.
  signal("D5", conditions.filter(item => UNKNOWN.test(item.text)
    && (REVIEW.test(item.text) || conditions.some(row => REVIEW.test(row.text)) || /판단|판정|확인\s*불가/u.test(item.text))));
  const intake = process.filter(item => INTAKE.test(item.text));
  const emptyInput = exceptions.filter(item => /빈\s*(?:파일|입력|데이터)|파일.*(?:없|미수신)|데이터.*없|수신.*없/u.test(item.text));
  signal("D6", intake.length ? [...intake, ...emptyInput] : []);
  signal("D7", conditions.filter(item => CALCULATION.test(item.text)));

  const dRows: UnifiedDecisionDraft[] = [];
  for (const id of DECISION_POINT_IDS) {
    const stored = storedDMap.get(id);
    if (stored) { dRows.push(stored); continue; }
    const evidence = signals.get(id);
    if (!evidence) continue;
    const fileIntake = id === "D6" && intake.some(item => /파일|업로드/u.test(item.text));
    const provenance = [...new Set(evidence.map(item => `${item.source}${item.step ? ` · 단계 "${item.step}"` : ""}: ${item.text}`))].join(" / ");
    dRows.push({
      kind: "decision", id, status: "미확정", detail: "", origin: "candidate",
      sourceLabel: "진단에서 도출", provenance,
      ...(id === "D6" ? {
        displayTitle: fileIntake ? "빈 파일 처리" : "빈 데이터 처리",
        displayQuestion: fileIntake
          ? "파일 미수신과 수신한 파일의 데이터가 빈 경우를 각각 어떻게 처리하나요?"
          : "수신·수집할 데이터가 없거나 입력이 비어 있으면 어떻게 처리하나요?",
      } : {}),
    });
  }

  const resolvedStored = resolveGenericRules(storedGeneric);
  const genericRows: UnifiedGenericDraft[] = resolvedStored.map(rule => ({
    kind: "generic", id: rule.id, name: rule.name, category: rule.category,
    applicability: rule.applicability, status: rule.status, detail: rule.detail ?? "",
    source: rule.source ?? "", step: rule.step ?? "",
    ...(rule.linkedDecisionId ? { linkedDecisionId: rule.linkedDecisionId } : {}),
    origin: "stored",
  }));
  const pushCandidate = (evidence: RuleEvidence, category: GenericRuleCategory, name = evidence.text): void => {
    if (!meaningful(name) || isConfirmationQuestion(name)) return;
    const key = genericRuleConditionKey(evidence.text);
    // 이름만으로 병합하지 않는다. 명시된 전체 조건과 업무 단계가 충돌하지 않아야 한다.
    const existing = genericRows.find(row => {
      if (row.step && evidence.step && normalize(row.step) !== normalize(evidence.step)) return false;
      if (row.candidateKey === JSON.stringify([key, normalize(row.step)])) return true;
      const generatedSource = /^(?:AS-IS 사람 판단|사람 개입\(HITL\)|기술적 확인 항목 "[^"]*"|AS-IS 업무 단계|단계별 판단(?: 근거)?|TO-BE (?:업무 단계|처리 조건)|AS-IS 예외): (.+)$/u.exec(row.source);
      // 도출 근거는 저장 후에도 유지된다. 사용자 추가 기준이 원래 후보의 식별을 가리지 않게 한다.
      // 도출 근거가 없는 기존 규칙은 상세·이름 순서로 비교한다.
      return genericRuleConditionKey(generatedSource?.[1] || row.detail || row.name) === key;
    });
    const provenance = `${evidence.source}${evidence.step ? ` · 단계 "${evidence.step}"` : ""}: ${evidence.text}`;
    if (existing) {
      existing.provenance = existing.provenance ? `${existing.provenance} / ${provenance}` : provenance;
      return;
    }
    genericRows.push({
      kind: "generic", id: null, name: name.slice(0, 120), category,
      applicability: "적용 여부 미확정", status: "미확정", detail: "",
      source: `${evidence.source}: ${evidence.text}`.slice(0, 500), step: evidence.step.slice(0, 500),
      origin: "candidate", sourceLabel: "진단에서 도출", provenance,
      candidateKey: JSON.stringify([key, normalize(evidence.step)]),
    });
  };
  for (const item of human) pushCandidate(item, "권한·검토 기준");
  // 선행 확인은 규칙으로 승격하지 않는다. 실행 중 처리 조건만 보존한다.
  for (const item of runtime) pushCandidate(item, "예외·확인 기준");
  for (const item of process) {
    if (!item.step || !RUNTIME.test(item.text)
      || /(?:상태|결과).*(?:구분|분류)|(?:구분|분류).*상태/u.test(item.text)) continue;
    if (REVIEW.test(item.text)) pushCandidate(item, "권한·검토 기준");
    else if (EXCEPTION.test(item.text) || /알림|재시도|마감|기한/u.test(item.text)) pushCandidate(item, "처리·판단 기준");
  }
  for (const item of exceptions) {
    if (RUNTIME.test(item.text)) pushCandidate(item, "예외·확인 기준");
  }
  if (outputs.length && !cleanList(poc.success).filter(meaningful).length) {
    pushCandidate({ text: "완료 기준 정리", source: `AS-IS 출력: ${outputs.join(", ")} · 성공 기준 미정`, step: "" }, "출력·완료 기준");
  }
  return [...dRows, ...genericRows];
}

/** 후보가 없을 때에만 사용하는 정보 충족 판정. 구현 가능 여부나 검토 완료 판정은 아니다. */
export function hasDerivationSignals(diagnosis: AxDiagnosis): boolean {
  return diagnosis.informationSufficiency === "sufficient"
    && Boolean(diagnosis.asIs?.purpose?.trim())
    && cleanList(diagnosis.asIs?.steps).some(meaningful)
    && !(diagnosis.followUpQuestions ?? []).some(question => question.trim());
}

/**
 * 업무 규칙 검토 완료율. 화면에 표시된 모든 검토 항목(카드 1장 = 1건)이 분모다.
 * 검토가 끝난 항목만 완료로 센다:
 * - D: 확정 또는 해당 없음(미적용) 결정 → 완료, 미확정 → 미완료.
 * - 범용: 해당 없음(미적용) 결정 또는 적용+확정 → 완료, 적용+미확정·적용 여부 미확정(선택 전) → 미완료.
 * 연계 D가 있어도 별도 카드로 각각 검토하므로 분모에서 빼지 않는다. 이 값은 검토 완료율이며
 * 구현 가능 여부(Gate·필수 조건)와는 별개다. applicabilityPending은 내부 참고용 건수다.
 */
export function unifiedRuleProgress(items: readonly UnifiedRuleDraft[]): RuleProgress {
  let done = 0;
  let applicabilityPending = 0;
  for (const item of items) {
    if (item.kind === "decision") {
      if (item.status !== "미확정") done += 1;
    } else if (item.applicability === "해당 없음" || (item.applicability === "적용" && item.status === "확정")) done += 1;
    else if (item.applicability === "적용 여부 미확정") applicabilityPending += 1;
  }
  return { done, total: items.length, applicabilityPending };
}

/** 통합 초안을 저장 페이로드로 변환한다. 기존 저장 계약을 유지한다. */
export function unifiedSavePayloads(
  drafts: readonly UnifiedRuleDraft[],
  storedGeneric: readonly GenericRule[],
): { points: DecisionPoint[]; rules: GenericRule[] } {
  // D: 저장된 미확정 상태·메모와 작성한 후보 메모도 보존한다 (§5.4).
  // 손대지 않은 빈 미확정 후보만 제외한다. 생성 경로의 확정 규칙 판정은 그대로 유지한다.
  const points: DecisionPoint[] = drafts
    .filter((item): item is UnifiedDecisionDraft => item.kind === "decision"
      && (item.status !== "미확정" || item.origin === "stored" || Boolean(item.detail.trim())))
    .map(item => ({
      id: item.id,
      status: item.status,
      ...(item.detail.trim() ? { detail: item.detail.trim() } : {}),
    }));
  // 범용: 이름 있는 행만 저장한다. 저장 행은 항상, 사용자 추가 행은 항상,
  // 후보 행은 사용자가 건드린 경우에만 저장한다 (미 터치 후보는 다음 렌더링에서 다시 도출된다).
  // id 부여는 저장된 id와 이미 부여된 초안 id 전체를 예약한 뒤 최대값+1부터 순차 부여한다.
  // (후보를 먼저 처리해도 모달에서 부여된 id와 충돌하지 않는다.)
  const reservedIds = new Set<string>([
    ...storedGeneric.map(rule => rule.id),
    ...drafts.filter((item): item is UnifiedGenericDraft => item.kind === "generic" && Boolean(item.id)).map(item => item.id as string),
  ]);
  let maxId = 0;
  for (const id of reservedIds) {
    const match = /^R(\d+)$/u.exec(id);
    if (match) maxId = Math.max(maxId, Number(match[1]));
  }
  const pushedIds = new Set<string>();
  const rules: GenericRule[] = [];
  for (const item of drafts) {
    if (item.kind !== "generic") continue;
    if (!item.name.trim()) continue;
    if (item.origin === "candidate" && !item.touched) continue;
    let id = item.id;
    if (!id) {
      maxId += 1;
      id = `R${maxId}`;
    }
    if (pushedIds.has(id)) continue;
    pushedIds.add(id);
    rules.push({
      id,
      name: item.name.trim(),
      category: item.category,
      ...(item.detail.trim() ? { detail: item.detail.trim() } : {}),
      ...(item.source.trim() ? { source: item.source.trim() } : {}),
      ...(item.step.trim() ? { step: item.step.trim() } : {}),
      applicability: item.applicability,
      status: item.status,
      ...(item.linkedDecisionId ? { linkedDecisionId: item.linkedDecisionId } : {}),
    });
  }
  return { points, rules };
}

/** D4 확정 상태 목록 (초안 기준). D5 선택형 UI용. confirmedStateNames와 동일한 의미다. */
export function draftStateNames(drafts: readonly UnifiedRuleDraft[]): string[] | null {
  const d4 = drafts.find((item): item is UnifiedDecisionDraft => item.kind === "decision" && item.id === "D4");
  if (!d4 || d4.status !== "확정" || !d4.detail.trim()) return null;
  const names = parseStateNames(d4.detail);
  return names.length ? names : null;
}
