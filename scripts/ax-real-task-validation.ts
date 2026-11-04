import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { followUpDiagnosisDescription } from "../src/lib/ax/follow-up";
import { registrationContext, taskDetails } from "../src/lib/ax/registration";
import { applyRediagnosis } from "../src/lib/ax/diagnosis-preservation";
import { applyCheckConfirmations, checkConfirmationState } from "../src/lib/ax/check-confirmations";
import { extractReviewableItems, getValidConfirmedReviews, reconcileReviews } from "../src/lib/ax/hitl";
import { automationLevel, executionGate, gatePrerequisites, planAllowed } from "../src/lib/ax/policy";
import { axDiagnosisOutputSchema, axDiagnosisShape, axPlanSchema, confirmedAxDiagnosis } from "../src/lib/ax/schema";
import { buildAgentInstructionModel, buildAllInOnePrompt } from "../src/lib/ax/guide";
import { validateAxGateConsistency, validateAxSemantics } from "../src/lib/ax/semantic";
import type { AxDiagnosis, AxDiagnosisRequest, AxPlan, AxTaskV2 } from "../src/lib/ax/types";
import { axGroundingSchema } from "../src/lib/ax/grounding-schema";
import { currentFactAssessment } from "../src/lib/ax/current-facts";

/** Read-only live evaluator. Artifacts intentionally live outside the repository.
 * Semantic equivalence is never inferred from a substring miss or a keyword blacklist.
 * Exit: 0 = complete measured/evidence checks, 1 = measured failure,
 * 2 = incomplete/infrastructure failure, 3 = semantic review still required.
 */
type Status = "확인" | "실패" | "검증 불가";
type Check = { status: Status; reason: string; evidence?: unknown };
type FailureClass = "코드·계약" | "AI 응답" | "외부 네트워크·제공자" | "구성·접근";
type Call = { request: unknown; response?: unknown; responseText?: string; status?: number; elapsedMs: number; failure?: { category: FailureClass; code: string; detail: string } };
type RunRow = { task: string; run: number; sufficiency?: string; level?: number; gate?: string; checks: Record<string, Check>; plans: unknown[]; failure?: Call["failure"] };
type ConsumerResult = {
  prompt: string; hash: string; model: unknown; effectiveLevel: number; effectiveGate: string;
  validReviewCount: number; reviewLinks: { id: string; status: string }[];
  confirmationStates: { topic: string; state: string }[];
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
const check = (ok: boolean, reason: string, evidence?: unknown): Check => ({ status: ok ? "확인" : "실패", reason, ...(evidence === undefined ? {} : { evidence }) });
const unknown = (reason: string, evidence?: unknown): Check => ({ status: "검증 불가", reason, ...(evidence === undefined ? {} : { evidence }) });

// Keep work facts, but remove obvious direct identifiers from requests AND artifacts.
// This is minimization, not a claim of comprehensive anonymization; artifacts remain private.
function minimize(value: unknown): unknown {
  if (typeof value === "string") return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[이메일 삭제]")
    .replace(/\b01[016789][- .]?\d{3,4}[- .]?\d{4}\b/gu, "[전화번호 삭제]")
    .replace(/\b\d{6}-[1-4]\d{6}\b/gu, "[개인식별번호 삭제]");
  if (Array.isArray(value)) return value.map(minimize);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, minimize(item)]));
  return value;
}
function options() {
  const args = process.argv.slice(2);
  const allowed: Record<string, true> = { "--input": true, "--base": true, "--runs": true, "--out": true, "--targets": true, "--timeout-ms": true };
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!Object.hasOwn(allowed, key) || !value || value.startsWith("--") || values.has(key)) throw new Error(`잘못된 인수: ${key}`);
    values.set(key, value);
  }
  const input = values.get("--input"), base = values.get("--base");
  if (!input || !base) throw new Error("사용법: bun scripts/ax-real-task-validation.ts --input <원본 JSON> --base <격리주소> [--runs 5] [--out <저장소 외부 디렉터리>] [--targets codex,claude] [--timeout-ms 180000]");
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("--base는 인증정보·경로가 없는 격리 서버 origin이어야 합니다.");
  const runs = Number(values.get("--runs") ?? 5), timeoutMs = Number(values.get("--timeout-ms") ?? 180_000);
  if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("runs와 timeout-ms는 양의 정수여야 합니다.");
  const targets = (values.get("--targets") ?? "codex,claude").split(",");
  if (!targets.length || targets.some(target => target !== "codex" && target !== "claude") || new Set(targets).size !== targets.length) throw new Error("targets는 codex,claude 중 중복 없는 목록이어야 합니다.");
  const out = resolve(values.get("--out") ?? resolve(tmpdir(), `worklens-ax-validation-${Date.now()}`));
  const rel = relative(resolve("."), out);
  if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../")) throw new Error("원본·응답 유출 방지를 위해 --out은 저장소 외부여야 합니다.");
  const inputPath = resolve(input);
  if (inputPath === out || dirname(inputPath) === out) throw new Error("--out은 원본과 분리된 새 디렉터리여야 합니다.");
  return { input: inputPath, base: url.origin, runs, out, targets: targets as ("codex" | "claude")[], timeoutMs };
}
function classify(status: number, code: string): FailureClass {
  if (["INVALID_PROVIDER_OUTPUT", "RESULT_TOO_LARGE"].includes(code)) return "AI 응답";
  if (["AI_NOT_CONFIGURED", "OPERATION_CAPACITY"].includes(code) || [401, 403].includes(status)) return "구성·접근";
  if (/AI_(?:TIMEOUT|PROVIDER|RATE_LIMITED)/u.test(code) || [429, 502, 503, 504].includes(status)) return "외부 네트워크·제공자";
  return "코드·계약";
}
async function call(base: string, request: unknown, timeoutMs: number): Promise<Call> {
  const started = performance.now();
  try {
    const response = await fetch(`${base}/api/ai`, {
      method: "POST", headers: { "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify(request), signal: AbortSignal.timeout(timeoutMs), redirect: "error",
    });
    const responseText = await response.text();
    let payload: unknown;
    try { payload = JSON.parse(responseText); } catch { /* Preserve non-JSON evidence; never accept it. */ }
    const result: Call = { request, response: payload, responseText, status: response.status, elapsedMs: Math.round(performance.now() - started) };
    if (!response.ok) {
      const error = object(object(payload).error), code = String(error.code ?? `HTTP_${response.status}`);
      result.failure = { category: classify(response.status, code), code, detail: String(error.message ?? "서버 오류; 응답 artifact 참조") };
    } else if (!payload || !object(payload).data) result.failure = { category: "코드·계약", code: "INVALID_ENVELOPE", detail: "성공 응답 data envelope 없음" };
    return result;
  } catch (error) {
    return { request, elapsedMs: Math.round(performance.now() - started), failure: { category: "외부 네트워크·제공자", code: "FETCH_FAILED", detail: String(error) } };
  }
}
function asIsEvidence(diagnosis: AxDiagnosis, request: AxDiagnosisRequest): Record<string, Check> {
  const sources = [request.name, request.description, ...Object.values(request.details).filter((v): v is string => typeof v === "string")].map(normalize);
  const fields = Object.entries(diagnosis.asIs).map(([field, value]) => {
    const texts = typeof value === "string" ? [value] : value;
    const rows = texts.map(text => ({ text, sourceVerbatim: !!normalize(text) && sources.some(source => source.includes(normalize(text))) }));
    return [field, rows.length && rows.every(row => row.sourceVerbatim)
      ? { status: "확인", reason: "모든 항목이 입력 원문의 연속 인용과 일치; 분류·완전성은 별도 검토", evidence: rows }
      : unknown("빈 항목 또는 원문과 다른 표현: 원문 밖 기능이라고 단정하지 않고 의미·근거 검토 필요", rows)];
  });
  return Object.fromEntries(fields) as Record<string, Check>;
}
function groundingEvidence(candidate: unknown, diagnosis: AxDiagnosis, request: AxDiagnosisRequest): Record<string, Check> {
  const parsed = axGroundingSchema.safeParse(candidate);
  if (!parsed.success) return { grounding: unknown("검증 가능한 grounding 필드 없음 또는 형식 불일치", parsed.error.issues) };
  const grounding = parsed.data;
  const citations = [...grounding.facts, ...grounding.conflicts.flatMap(conflict => [conflict.left, conflict.right])].map(ref => {
    const source = ref.source.startsWith("details.") ? object(request.details)[ref.source.slice(8)] : object(request)[ref.source];
    return { ...ref, matchesSource: typeof source === "string" && normalize(source).includes(normalize(ref.quote)) };
  });
  const assessment = currentFactAssessment(grounding);
  return {
    grounding: check(citations.every(ref => ref.matchesSource), "각 인용을 지정된 입력 source에 직접 대조 (근거 분류의 의미 정확성은 별도)", citations),
    groundedAsIs: check(equal(assessment.asIs, diagnosis.asIs), "원문 인용으로 구성된 현재사실과 서버 최종 AS-IS 비교", { expected: assessment.asIs, actual: diagnosis.asIs }),
    groundedSufficiency: check(assessment.informationSufficiency === diagnosis.informationSufficiency, "근거 기반 충분도 정책값과 최종 응답 비교", { expected: assessment.informationSufficiency, actual: diagnosis.informationSufficiency }),
    extractionCompleteness: unknown("인용이 원문에 있어도 AS-IS 분류·부정·희망/현재 구분 및 원문 사실 누락은 의미 검토 필요", grounding),
  };
}
function inputCoverage(diagnosis: AxDiagnosis, request: AxDiagnosisRequest): Check {
  const output = normalize(Object.values(diagnosis.asIs).flat().join(" "));
  const clauses = [request.name, request.description, ...Object.values(request.details).filter((v): v is string => typeof v === "string")].flatMap(text => text.split(/[\n。.!?]+/u)).map(normalize).filter(Boolean);
  const coverage = clauses.map(text => ({ source: text, verbatimPresent: output.includes(text) }));
  return coverage.every(row => row.verbatimPresent)
    ? { status: "확인", reason: "입력 문장 모두 AS-IS에 직접 보존됨; 의미 분류는 별도 검토", evidence: coverage }
    : unknown("원문 문장 직접 일치만 비교함. 의역·분할·누락 구분은 의미 검토 필요", coverage);
}
function preservation(before: AxTaskV2, after: AxTaskV2): Record<string, Check> {
  const { diagnosis: _bd, updatedAt: _bt, status: _bs, diagnosisRegistration: _br, reviews: _bv, ...b } = before;
  const { diagnosis: _ad, updatedAt: _at, status: _as, diagnosisRegistration: _ar, reviews: _av, ...a } = after;
  const reviews = (before.reviews ?? []).map(review => {
    const next = after.reviews?.find(item => item.id === review.id);
    const { status: _s, updatedAt: _t, ...original } = review;
    const { status: _ns, updatedAt: _nt, ...saved } = next ?? {};
    return { id: review.id, retained: !!next && equal(original, saved), before: review.status, after: next?.status };
  });
  return {
    registration: check(equal(a, b), "재진단 전후 입력·사용자 소유 필드 전체 비교"),
    confirmations: check(equal(before.checkConfirmations, after.checkConfirmations), "기술 확인 기록을 재진단 전후 실제 비교", { before: before.checkConfirmations, after: after.checkConfirmations }),
    hitl: check(reviews.every(row => row.retained) && (after.reviews?.length ?? 0) === (before.reviews?.length ?? 0), "검토 기록 내용·개수 보존, 상태 재평가 별도 기록", reviews),
    decisions: check(equal(before.diagnosis?.decisionPoints, after.diagnosis?.decisionPoints), "사용자 D규칙 실제 보존 비교"),
  };
}
function consumer(task: AxTaskV2, target: "codex" | "claude", plan: AxPlan | undefined): ConsumerResult {
  if (!task.diagnosis) throw new Error("소비자 비교에 진단이 없습니다.");
  const diagnosis = applyCheckConfirmations(task.diagnosis, task.checkConfirmations);
  const withPlan = { ...diagnosis, ...(plan ? target === "codex" ? { planCodex: plan } : { planClaude: plan } : {}) };
  const items = extractReviewableItems(withPlan);
  const reviews = getValidConfirmedReviews({ ...task, diagnosis: withPlan }, items);
  const options = { taskName: task.name, context: registrationContext(task), diagnosis: withPlan, prerequisites: gatePrerequisites(withPlan), hitlReviews: reviews, hitlTool: target, genericRules: task.genericRules };
  const prompt = buildAllInOnePrompt(plan, target, options);
  return { prompt, hash: hash(prompt), model: buildAgentInstructionModel(plan, options), effectiveLevel: automationLevel(withPlan).level, effectiveGate: executionGate(withPlan), validReviewCount: reviews.length,
    reviewLinks: [...reconcileReviews(task.reviews ?? [], items)].map(([id, link]) => ({ id, status: link.status })),
    confirmationStates: withPlan.technicalChecks.map(item => ({ topic: item.topic, state: checkConfirmationState(item, task.checkConfirmations).kind })) };
}
async function main() {
  const config = options();
  const sourceBytes = await readFile(config.input), sourceStat = await stat(config.input);
  const original = JSON.parse(sourceBytes.toString("utf8")) as { exportedAt?: string; format?: string; data?: { tasks?: AxTaskV2[] } };
  if (original.format !== "worklens-ax" || !Array.isArray(original.data?.tasks) || original.data.tasks.length !== 5) throw new Error("worklens-ax 원본의 정확히 5개 업무가 필요합니다.");
  // Exclusive directory creation prevents accidental overwrite of previous evidence.
  await mkdir(config.out, { recursive: false });
  const save = async (name: string, value: unknown) => writeFile(resolve(config.out, name), JSON.stringify(minimize(value), null, 2), { flag: "wx" });
  const tasks = original.data.tasks.map((raw, index) => {
    // Whitelist task-owned fields, excluding original IDs and unrelated export state.
    const keys = ["name", "description", "cycle", "minutesPerRun", "runsPerMonth", "people", "systems", "inputs", "outputs", "humanSteps", "painPoints", "goal", "status", "diagnosis", "checkConfirmations", "reviews", "followUpResponses", "genericRules", "createdAt", "updatedAt"];
    const task = minimize(Object.fromEntries(keys.filter(key => key in raw).map(key => [key, object(raw)[key]]))) as AxTaskV2;
    task.id = `task-${index + 1}`;
    task.reviews = task.reviews?.map((review, j) => ({ ...review, id: `task-${index + 1}-review-${j + 1}` }));
    return task;
  });
  const attachments = original.data.tasks.map((task, index) => ({ task: `task-${index + 1}`, registration: (task.attachmentMetas?.length ?? 0) + (task.attachmentMeta ? 1 : 0), followUp: (task.followUpResponses ?? []).reduce((sum, row) => sum + (row.attachments?.length ?? 0), 0) }));
  await save("source-manifest.json", { exportedAt: original.exportedAt ?? null, sourceModifiedAt: sourceStat.mtime.toISOString(), sourceSha256: hash(sourceBytes.toString("utf8")), sourceBytes: sourceBytes.length, taskTimestamps: tasks.map(task => ({ task: task.id, createdAt: task.createdAt, updatedAt: task.updatedAt })), attachments,
    confirmations: tasks.reduce((n, task) => n + (task.checkConfirmations?.length ?? 0), 0), hitlReviews: tasks.reduce((n, task) => n + (task.reviews?.length ?? 0), 0),
    historicalAttribution: "#407 적용 전후 여부는 export/task timestamp만으로 확정 불가. 원본은 역사적 비교 자료일 뿐 동일 조건 대조군이 아님.",
    privacy: "원본 ID·경로·전체 export 미저장, 이메일/전화/개인식별번호 최소 삭제. 업무 내용·응답이 포함된 비공개 artifact이며 완전 익명화 아님.",
    execution: { base: config.base, runs: config.runs, targets: config.targets, startedAt: new Date().toISOString() } });
  await save("sanitized-tasks.json", tasks);
  const rows: RunRow[] = [];
  for (const task of tasks) {
    const baseline: Record<string, ConsumerResult> = {};
    for (const target of config.targets) if (task.diagnosis) {
      const plan = target === "codex" ? task.diagnosis.planCodex : task.diagnosis.planClaude;
      baseline[target] = consumer(task, target, plan);
    }
    await save(`${task.id}-baseline.json`, baseline);
    for (let run = 1; run <= config.runs; run++) {
      const prefix = `${task.id}-run-${run}`;
      const row: RunRow = { task: task.id, run, checks: {}, plans: [] };
      rows.push(row);
      try {
        const request: AxDiagnosisRequest = { kind: "ax-diagnosis", name: task.name, description: followUpDiagnosisDescription(task.description, task.followUpResponses), details: taskDetails(task) };
        const response = await call(config.base, request, config.timeoutMs);
        await save(`${prefix}-diagnosis.json`, response);
        if (response.failure) { row.failure = response.failure; continue; }
        const data = object(object(response.response).data), rawDiagnosis = object(data.diagnosis);
        const parsed = axDiagnosisOutputSchema.safeParse(Object.fromEntries(Object.keys(axDiagnosisShape).map(key => [key, rawDiagnosis[key]])));
        if (data.kind !== "ax-diagnosis" || !parsed.success) {
          row.failure = { category: "코드·계약", code: "DIAGNOSIS_SCHEMA", detail: parsed.success ? "kind 불일치" : parsed.error.message };
          continue;
        }
        const parsedGrounding = axGroundingSchema.safeParse(rawDiagnosis.grounding);
        const incoming: AxDiagnosis = { ...parsed.data, ...(parsedGrounding.success ? { grounding: parsedGrounding.data } : {}), sourceNote: "실제 격리 API 재진단; 원본 저장 안 함" };
        const next = applyRediagnosis(structuredClone(task), incoming, new Date().toISOString());
        const diagnosis = next.diagnosis!;
        row.sufficiency = diagnosis.informationSufficiency;
        row.level = automationLevel(diagnosis).level;
        row.gate = executionGate(diagnosis);
        const violations = validateAxSemantics(parsed.data, request), gateIssues = validateAxGateConsistency(parsed.data);
        row.checks = { ...preservation(task, next), ...Object.fromEntries(Object.entries(asIsEvidence(diagnosis, request)).map(([key, value]) => [`asIs.${key}`, value])),
          inputFacts: inputCoverage(diagnosis, request), inventedMetrics: check(!violations.length, "기존 의미 검증기로 원문 밖 성능 주장 비교", violations),
          gateConsistency: check(!gateIssues.length, "기존 Gate 의미 규칙과 실제 응답 비교", gateIssues),
          absentFunctions: unknown("전체 AS-IS의 의미상 무근거 기능 부재는 문자열 검사만으로 합격 처리하지 않음. 진단·원문·grounding을 함께 검토"),
          ...groundingEvidence(rawDiagnosis.grounding, diagnosis, request),
        };
        await save(`${prefix}-comparison.json`, { before: { asIs: task.diagnosis?.asIs, sufficiency: task.diagnosis?.informationSufficiency, level: task.diagnosis ? automationLevel(task.diagnosis) : null, gate: task.diagnosis ? executionGate(task.diagnosis) : null }, after: diagnosis, checks: row.checks, groundingFields: Object.fromEntries(Object.entries(rawDiagnosis).filter(([key]) => !(key in axDiagnosisShape))) });
        for (const target of config.targets) {
          if (!planAllowed(applyCheckConfirmations(diagnosis, next.checkConfirmations))) {
            row.plans.push({ target, status: "정책 차단", reason: "UI와 동일하게 blocked 진단의 계획 요청 안 함", prompt: consumer(next, target, undefined) });
            continue;
          }
          const planRequest = { kind: "ax-plan", target, task: { name: next.name, description: request.description, details: taskDetails(next) }, diagnosis: confirmedAxDiagnosis(applyCheckConfirmations(diagnosis, next.checkConfirmations)) };
          const planResponse = await call(config.base, planRequest, config.timeoutMs);
          await save(`${prefix}-plan-${target}.json`, planResponse);
          if (planResponse.failure) { row.plans.push({ target, failure: planResponse.failure }); continue; }
          const planData = object(object(planResponse.response).data), parsedPlan = axPlanSchema.safeParse(planData.plan);
          if (planData.kind !== "ax-plan" || !parsedPlan.success) {
            row.plans.push({ target, failure: { category: "코드·계약", code: "PLAN_SCHEMA", detail: parsedPlan.success ? "kind 불일치" : parsedPlan.error.message } });
            continue;
          }
          const after = consumer(next, target, parsedPlan.data), before = baseline[target];
          const comparison = { target, before, after, promptChanged: before ? before.hash !== after.hash : null,
            semanticEquivalence: unknown("모델·계획·올인원 원문을 기록함. 내용 변화 자체는 실패 아님; 역사적 계획과 신규 계획의 의미 일치·안전성은 검토 필요"),
            preservation: preservation(task, next) };
          await save(`${prefix}-all-in-one-${target}.json`, comparison);
          row.plans.push({ target, status: "생성·비교 기록", promptHash: after.hash, effectiveLevel: after.effectiveLevel, effectiveGate: after.effectiveGate, validReviewCount: after.validReviewCount, promptChanged: comparison.promptChanged });
        }
      } catch (error) {
        row.failure = { category: "코드·계약", code: "RUNNER_EXCEPTION", detail: String(error) };
      } finally {
        await save(`${prefix}-result.json`, row);
        console.log(`${task.id} ${run}/${config.runs}: ${row.failure ? `${row.failure.category} ${row.failure.code}` : `충분도 ${row.sufficiency}, Level ${row.level}, Gate ${row.gate}`}`);
      }
    }
  }
  const finalBytes = await readFile(config.input);
  const sourceUnchanged = sourceBytes.equals(finalBytes);
  const consistency = tasks.map(task => {
    const matching = rows.filter(row => row.task === task.id), completed = matching.filter(row => row.sufficiency);
    const values = [...new Set(completed.map(row => row.sufficiency))];
    return { task: task.id, requested: config.runs, completed: completed.length, values, check: completed.length !== config.runs ? unknown("완료하지 못한 반복이 있어 동일성 확정 불가") : check(values.length === 1, "같은 입력 반복의 실제 충분도 값 비교", values),
      levels: [...new Set(completed.map(row => row.level))], gates: [...new Set(completed.map(row => row.gate))] };
  });
  const failures = rows.flatMap(row => [row.failure, ...row.plans.map(plan => object(plan).failure as Call["failure"])]).filter(Boolean);
  const measuredFailures = rows.flatMap(row => Object.values(row.checks)).filter(item => item.status === "실패").length + consistency.filter(row => row.check.status === "실패").length + (sourceUnchanged ? 0 : 1);
  const unresolved = rows.flatMap(row => Object.values(row.checks)).filter(item => item.status === "검증 불가").length;
  const exitCode = failures.length || rows.some(row => !row.sufficiency) ? 2 : measuredFailures ? 1 : unresolved ? 3 : 0;
  const summary = { language: "ko", requestedDiagnoses: tasks.length * config.runs, completedDiagnoses: rows.filter(row => row.sufficiency).length, sourceUnchanged, sufficiencyConsistency: consistency, failures, measuredFailures, unresolved,
    verdict: failures.length ? "실행 불완전: 원인별 실패 참조" : measuredFailures ? "측정 항목 실패" : "기계 비교 완료; 의미·근거 미확정 항목이 있으므로 전체 합격 선언 불가", exitCode,
    limits: ["AS-IS 7항목(purpose/trigger/inputs/outputs/exceptions/humanDecisions/systems)과 steps를 각각 비교", "단순 문구 배제·특정 수치 기대값으로 품질 합격 처리하지 않음", "입력 원문 직접 인용은 확인 가능하나 의역의 의미·분류·완전성은 미확정", "브라우저 UI·저장소 업로드는 수행하지 않음; 순수 소비자 함수와 격리 API만 호출", "#407 적용 전후 확정 불가; export 시각과 업무 수정 시각은 manifest 참조", "원본 첨부 메타데이터 없는 경우 attachmentSummary 미전송; 실물 첨부가 있었다고 추정하지 않음"], rows };
  await save("summary.json", summary);
  const text = ["AX 실제 5업무 반복 검증", `진단: ${summary.completedDiagnoses}/${summary.requestedDiagnoses}`, `원본 바이트 불변: ${sourceUnchanged ? "확인" : "실패"}`, `측정 실패: ${measuredFailures}, 실행 실패: ${failures.length}, 미확정: ${unresolved}`, ...consistency.map(row => `${row.task}: 충분도 ${row.values.join(" / ") || "미완료"} (${row.check.status}), Level ${row.levels.join("/")}, Gate ${row.gates.join("/")}`), summary.verdict, "#407 적용 전후 여부는 확정 불가.", "상세 근거: source-manifest.json / *-diagnosis.json / *-comparison.json / *-plan-*.json / *-all-in-one-*.json / summary.json", "artifact는 비공개 유지, repo에 커밋하지 마세요."].join("\n");
  await writeFile(resolve(config.out, "summary.txt"), text, { flag: "wx" });
  console.log(`${text}\n저장 위치: ${config.out}`);
  return exitCode;
}
if (import.meta.main) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`실제업무 검증을 완료하지 못했습니다: ${String(error)}`); process.exitCode = 2; }
}
