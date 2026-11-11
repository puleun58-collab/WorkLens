/** Manual, read-only API measurement. Never treats retrieval success as legal correctness. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const CASES = [
  { id: "labor-absence", task: "full_research", representative: true, query: "직원이 갑자기 무단퇴사해서 연락이 안 됨", focus: "근로관계와 회사 구성원·출자관계를 구분. 연락 두절을 사직·퇴직 완료로 확정하거나 원문에 없는 임금 체불을 만들지 않는지." },
  { id: "post-employment-wages", task: "full_research", representative: true, query: "회사를 그만둔 지 한 달이 지났는데 마지막 달에 일한 임금을 받지 못했습니다. 퇴직 뒤 임금을 언제까지 지급해야 하는지와 받기 위한 절차를 알고 싶습니다.", focus: "퇴직 후 금품청산 의무와 회수 절차를 구분. 지급기한 연장 합의 등 미확정 조건, 특별 배상 요건을 일반 체불에 자동 적용하지 않는지." },
  { id: "monthly-wages", task: "full_research", representative: true, query: "계속 근무 중인데 회사가 이번 달 월급 지급일이 지나도 월급을 주지 않습니다. 회사의 지급 의무와 제가 요구할 수 있는 조치를 알고 싶습니다.", focus: "재직 중 정기 임금지급 의무가 직접 근거인지. 퇴직 상황을 추가하지 않고 확인서·융자·가중 배상만으로 의무를 확인했다고 하지 않는지." },
  { id: "contract-breach", task: "full_research", representative: true, query: "사업자끼리 물품 공급계약을 맺었는데 상대방이 약속한 날에 물품을 공급하지 않았습니다. 이행을 요구하거나 손해배상을 청구하려면 어떤 요건이 필요한가요?", focus: "계약상 이행·채무불이행 책임과 손해배상 방법을 구분. 귀책·손해·인과관계 및 면책 조건을 사실로 만들어내지 않는지." },
  { id: "contract-rescission", task: "full_research", representative: true, query: "물품 공급계약의 납품기한이 지났습니다. 계약을 해제하려면 먼저 상당한 기간을 정해 이행을 요구해야 하나요? 바로 해제할 수 있는 경우와 이미 지급한 대금의 처리도 알고 싶습니다.", focus: "해제의 일반 요건과 예외, 해제 효과를 분리. 최고 필요 여부와 특별한 목적·이행불능 등 조건을 단정하지 않는지." },
  { id: "procurement-change", task: "full_research", representative: false, query: "국가기관과 공사계약을 체결한 업체입니다. 발주기관의 설계변경으로 공사량이 늘었는데 계약금액을 조정할 수 있는 요건과 절차를 알고 싶습니다.", focus: "국가계약과 민간·지방계약 관계를 구분. 설계변경에 따른 계약금액 조정 요건이 직접 근거인지, 일반 변경 절차만 채택했는지." },
  { id: "procurement-sanction", task: "full_research", representative: false, query: "국가기관과 체결한 물품계약을 제때 이행하지 못했습니다. 입찰참가자격 제한을 받을 수 있는 요건과 처분 전 의견을 낼 수 있는 절차를 알고 싶습니다.", focus: "이행 지체와 제재 사유·귀책·예외를 분리. 제재 근거와 청문·의견제출 보조 절차, 다른 법률관계의 제재를 혼동하지 않는지." },
  { id: "delegation-system", task: "law_system", representative: false, query: "개인정보를 처리하는 사업자의 안전조치 의무에 관하여 법률이 시행령에 위임한 내용과 그 아래 고시로 구체화된 기준의 연결 관계를 알고 싶습니다.", focus: "법률·시행령·고시의 실제 위임 연결과 적용 시점 확인. 단순 유사 제목 목록을 위임 근거로 단정하지 않는지." },
  { id: "business-suspension", task: "action_basis", representative: false, query: "일반음식점을 운영하는 영업자입니다. 위생 관련 의무 위반으로 영업정지 처분을 받을 수 있는 법적 근거와 위반 유형별 처분기준, 처분 전에 의견을 낼 절차를 알고 싶습니다.", focus: "식품 영업자·업종과 위반 사실의 범위를 유지. 실체 처분 근거·하위 처분기준·사전 절차를 분리하고 위반행위가 확정됐다고 하지 않는지." },
  { id: "administrative-appeal-documents", task: "procedure_detail", representative: false, query: "행정기관의 영업정지 처분에 불복하여 행정심판을 청구하려고 합니다. 청구기간, 제출할 청구서와 첨부서류, 집행정지를 별도로 신청해야 하는지 알고 싶습니다.", focus: "심판 청구와 집행정지의 요건·서류를 분리. 필수 첨부와 상황별 자료, 청구기간 기산점·예외를 구분하고 심판만으로 집행정지를 단정하지 않는지." },
] as const;

type Outcome = "response" | "external_failure" | "api_failure" | "missing" | "transport_failure";
interface Observation {
  interpretation: unknown; interpretationFailure: unknown; issues: unknown; adoptionReviews: ObjectValue[];
  candidateCount: number; candidateRoles: { direct: number; supporting: number; identity: number; rejected: number };
  sourceIdentities: ObjectValue[]; fetchedArticleIdentities: ObjectValue[]; fetchedDecisionIdentities: ObjectValue[];
  finalEvidence: unknown; taskEvidence: ObjectValue; finalIdentities: unknown[]; evidenceSignature: string;
  semanticVerdict: "manual-review-required";
}
type Measurement = Observation & { caseId: string; run: number; task: string; httpStatus?: number; outcome: Outcome; failure?: unknown; durationMs: number; availableMetadata: ObjectValue; rawArtifact: string };
const EXTERNAL: Record<string, true | undefined> = { LAW_AUTH_FAILED: true, LAW_RATE_LIMITED: true, LAW_UPSTREAM_TIMEOUT: true,
  LAW_UPSTREAM_UNAVAILABLE: true, LAW_UPSTREAM_NO_DATA: true, OPERATION_CAPACITY: true, AI_RATE_LIMITED: true, AI_UNAVAILABLE: true };

function options() {
  const args = process.argv.slice(2);
  const allowed: Record<string, true | undefined> = { "--base": true, "--runs": true, "--out": true, "--cases": true, "--baseline": true, "--timeout-ms": true };
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed[args[i]] || !args[i + 1] || args[i + 1].startsWith("--") || values.has(args[i])) throw new Error("Invalid or duplicate option");
    values.set(args[i], args[i + 1]);
  }
  if (!values.has("--base") || !values.has("--out")) throw new Error("Required: --base origin --out directory");
  const base = new URL(values.get("--base")!);
  if (!/^https?:$/u.test(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("--base must be an HTTP(S) origin without credentials/path/query");
  const runs = Number(values.get("--runs") ?? "5");
  const timeout = Number(values.get("--timeout-ms") ?? "180000");
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20 || !Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 600000) throw new Error("Invalid runs (1..20) or timeout-ms (1000..600000)");
  const selector = values.get("--cases") ?? "all";
  const ids = selector.split(",");
  if (selector !== "all" && selector !== "representative" && ids.some((id) => !CASES.some((item) => item.id === id))) throw new Error("Unknown case selector");
  const cases = CASES.filter((item) => selector === "all" || (selector === "representative" ? item.representative : ids.includes(item.id)));
  return { base: base.origin, out: resolve(values.get("--out")!), runs, timeout, cases, baseline: values.get("--baseline") };
}

function metadata(...values: unknown[]): ObjectValue {
  const result: ObjectValue = {};
  for (const value of values) for (const [key, entry] of Object.entries(object(value))) {
    if (/^(?:retries|retryCount|requestStats|requestStatistics|timing|timings|durationMs|outcome|requestId)$/u.test(key)) result[key] = entry;
  }
  return result;
}

function inspect(body: unknown): Observation {
  const data = object(object(body).data);
  const enrichment = object(data.enrichment);
  const reviews = array(enrichment.adoptionReviews).map((value) => {
    const review = object(value);
    const candidates = ["articles", "precedents", "decisions"].flatMap((kind) => array(review[kind]).map((entry): ObjectValue => {
      const candidate = object(entry);
      const text = typeof candidate.excerpt === "string" ? candidate.excerpt : typeof candidate.body === "string" ? candidate.body : undefined;
      return { kind, ...candidate, recordedTextChars: text?.length ?? null, modelWindow: candidate.window ?? null,
        completeness: candidate.partial === true ? "partial" : candidate.partial === false ? "reported-complete" : "not-reported" };
    }));
    return { ...review, candidateCount: candidates.length, candidates };
  });
  const candidates = reviews.flatMap((review) => review.candidates);
  const identity = (entry: ObjectValue) => Object.fromEntries(Object.entries(entry).filter(([key]) => /^(?:law|jo|id|key|domain|title|effectiveDate|date|source|stage|currency|mst|lawId|efYd|version)$/u.test(key)));
  const evidence = object(data.evidence);
  const articles = array(evidence.articles).map((entry) => identity(object(entry)));
  const finalIdentities = [...articles, ...array(evidence.precedents), ...array(evidence.decisions)];
  const taskEvidence = Object.fromEntries(["procedure", "lawSystem", "actionBasis", "dispute", "amendment", "followup"].filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
  return {
    interpretation: data.interpretation ?? null, interpretationFailure: data.interpretationFailure ?? null,
    issues: evidence.issues ?? null, adoptionReviews: reviews, candidateCount: candidates.length,
    candidateRoles: { direct: candidates.filter((item) => item.adopted === true && item.role === "direct").length,
      supporting: candidates.filter((item) => item.adopted === true && item.role === "supporting").length,
      identity: candidates.filter((item) => item.adopted === true && item.role === "identity").length,
      rejected: candidates.filter((item) => item.adopted === false).length },
    sourceIdentities: candidates.map(identity),
    fetchedArticleIdentities: array(object(enrichment.supplement).articles).map((entry) => identity(object(entry))),
    fetchedDecisionIdentities: Object.entries(object(enrichment.decisionOriginals)).map(([key, entry]) => ({ key, ...identity(object(entry)), partial: object(entry).partial ?? null })),
    finalEvidence: data.evidence ?? null, taskEvidence, finalIdentities,
    evidenceSignature: JSON.stringify({ status: evidence.status ?? null, finalIdentities, taskEvidence }),
    semanticVerdict: "manual-review-required" as const,
  };
}

function metrics(rows: Measurement[]) {
  const durations = rows.map((row) => row.durationMs).sort((a, b) => a - b);
  const outcomes = Object.fromEntries((["response", "external_failure", "api_failure", "missing", "transport_failure"] as Outcome[]).map((kind) => [kind, rows.filter((row) => row.outcome === kind).length]));
  return { requests: rows.length, outcomes, meanMs: rows.length ? Math.round(durations.reduce((a, b) => a + b, 0) / rows.length) : null,
    p50Ms: durations[Math.max(0, Math.ceil(durations.length * .5) - 1)] ?? null, p95Ms: durations[Math.max(0, Math.ceil(durations.length * .95) - 1)] ?? null,
    candidateMean: rows.length ? rows.reduce((sum, row) => sum + row.candidateCount, 0) / rows.length : null,
    signatures: new Set(rows.filter((row) => row.outcome === "response").map((row) => row.evidenceSignature)).size };
}

async function main() {
  const config = options();
  // Fail closed on reuse: no previous baseline/raw responses are overwritten.
  await mkdir(config.out, { recursive: false, mode: 0o700 });
  const baseline = config.baseline ? object(JSON.parse(await readFile(resolve(config.baseline), "utf8"))) : undefined;
  if (baseline && (baseline.schemaVersion !== 1 || !Array.isArray(baseline.measurements))) throw new Error("Unsupported baseline summary");
  const measurements: Measurement[] = [];
  const startedAt = new Date().toISOString();
  for (const testCase of config.cases) for (let run = 1; run <= config.runs; run++) {
    const started = performance.now();
    let payload: unknown;
    let raw: string | undefined;
    let httpStatus: number | undefined;
    let outcome: Outcome = "transport_failure";
    let failure: unknown;
    const headers: ObjectValue = {};
    try {
      // Only this search route is allowed. No uploads, saved searches, auth mutations, or evaluator retries.
      const response = await fetch(`${config.base}/api/law/research`, { method: "POST", redirect: "error",
        headers: { "content-type": "application/json", origin: config.base, "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ task: testCase.task, query: testCase.query }), signal: AbortSignal.timeout(config.timeout) });
      httpStatus = response.status;
      const requestId = response.headers.get("x-request-id");
      if (requestId) headers.requestId = requestId;
      raw = await response.text();
      try { payload = JSON.parse(raw); } catch { failure = { kind: "invalid-json" }; }
      const envelope = object(payload);
      const error = object(envelope.error);
      const code = typeof error.code === "string" ? error.code : undefined;
      if (!response.ok || envelope.error) {
        outcome = (code && EXTERNAL[code]) || response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504 ? "external_failure" : "api_failure";
        failure = envelope.error ?? { kind: "http", status: response.status };
      } else if (failure || typeof object(envelope.data).found !== "boolean") {
        outcome = "api_failure";
        failure ??= { kind: "missing-data-contract" };
      } else if (object(envelope.data).found === false) {
        outcome = "missing";
        failure = { kind: "not-found" };
      } else outcome = "response";
    } catch (error) {
      failure = { kind: "transport", name: error instanceof Error ? error.name : "UnknownError" };
    }
    const durationMs = Math.round(performance.now() - started);
    const rawArtifact = `${testCase.id}-${run}.private.json`;
    await writeFile(join(config.out, rawArtifact), JSON.stringify({ caseId: testCase.id, run, request: { task: testCase.task, query: testCase.query },
      httpStatus, response: payload ?? null, ...(payload === undefined && raw !== undefined ? { unparsedResponse: raw } : {}), failure }, null, 2), { flag: "wx", mode: 0o600 });
    const envelope = object(payload);
    measurements.push({ caseId: testCase.id, run, task: testCase.task, httpStatus, outcome, failure, durationMs,
      availableMetadata: { ...metadata(envelope, object(envelope.data), envelope.meta, envelope.stats), ...headers }, rawArtifact, ...inspect(payload) });
    // IDs, outcome and timing only: never print questions, source text, API errors, or credentials.
    console.log(`${testCase.id} ${run}/${config.runs}: ${outcome} ${measurements.at(-1)!.durationMs}ms`);
  }
  const baselineRows = baseline ? array(baseline.measurements) as Measurement[] : [];
  const comparisons = config.cases.map((item) => {
    const after = metrics(measurements.filter((row) => row.caseId === item.id));
    const beforeRows = baselineRows.filter((row) => row.caseId === item.id);
    const before = beforeRows.length ? metrics(beforeRows) : null;
    return { caseId: item.id, before, after, meanDeltaMs: before?.meanMs !== null && before?.meanMs !== undefined && after.meanMs !== null ? after.meanMs - before.meanMs : null,
      note: before ? "Unequal sample sizes and external conditions; descriptive comparison, not causal proof or accuracy PASS." : "No matching baseline case." };
  });
  const report = { schemaVersion: 1, startedAt, completedAt: new Date().toISOString(), base: config.base, runs: config.runs,
    semanticVerdict: "manual-review-required", baseline: baseline ? { base: baseline.base, startedAt: baseline.startedAt, path: resolve(config.baseline!) } : null,
    cases: config.cases, totals: metrics(measurements), comparisons, measurements };
  await writeFile(join(config.out, "summary.private.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  const lines = ["# 법령 정확도 API 관측 — 수동 의미 검토 필요", "", "검색 응답 성공은 근거 정확도 PASS가 아니다. 원문·조건·당사자·직접/보조 역할은 private JSON을 대조하여 검토한다.", "",
    "| Case | Requests | response/external/api/missing/transport | Mean/P95 ms | Baseline mean → after (Δ ms) | Response signatures |",
    "|---|---:|---|---|---|---:|", ...comparisons.map(({ caseId, before, after, meanDeltaMs }) => `| ${caseId} | ${after.requests} | ${Object.values(after.outcomes).join("/")} | ${after.meanMs}/${after.p95Ms} | ${before?.meanMs ?? "n/a"} → ${after.meanMs} (${meanDeltaMs ?? "n/a"}) | ${after.signatures} |`), "",
    "signature 차이는 관측된 반복 차이일 뿐 오류 확정이 아니며, 동일 signature도 정답 보장이 아니다. 서로 다른 표본 수·시점의 성능 비교는 기술통계다.", ""];
  for (const item of config.cases) {
    lines.push(`## ${item.id}`, item.focus, "");
    for (const row of measurements.filter((entry) => entry.caseId === item.id)) {
      const statuses = array(row.issues).map((issue) => object(issue).status).join(",") || "not-reported";
      lines.push(`- 회차 ${row.run}: ${row.outcome}; issue=${statuses}; 후보 ${row.candidateCount}; direct/supporting/identity/rejected=${Object.values(row.candidateRoles).join("/")}; interpretation=${row.interpretation ? "present" : "absent"}; 원문·버전·window·채택이유: ${row.rawArtifact}, summary.private.json`);
    }
    lines.push("");
  }
  lines.push("## 검토 기록", "관계/쟁점 누락, 후보 확보, 모델 입력 window, 직접/보조 채택, 미확정 조건, 공식 원문 식별자·시점, 최종 근거 연결을 각각 판정한다. 미노출 retries/requestStats 또는 원문 완전성은 0/완전으로 추정하지 않는다. 본 측정기는 법률 정답을 자동 판정하지 않는다.");
  await writeFile(join(config.out, "summary.md"), lines.join("\n"), { flag: "wx", mode: 0o600 });
  console.log(`Recorded ${measurements.length} requests; semantic review REQUIRED; summary.md and private JSON saved.`);
  process.exitCode = measurements.some((row) => row.outcome === "api_failure" || row.outcome === "transport_failure") ? 1 : measurements.some((row) => row.outcome !== "response") ? 2 : 0;
}

await main().catch(() => { console.error("Evaluator stopped; check arguments, private artifact path/access, or baseline schema. No response contents printed."); process.exitCode = 1; });
