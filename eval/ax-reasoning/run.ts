// Opt-in synthetic effort evaluation. The harness never retries a request.
import { mkdir, writeFile } from "node:fs/promises";
import { axDiagnosisOutputSchema } from "../../src/lib/ax/schema";
import { validateAxSemantics } from "../../src/lib/ax/semantic";
import { SCENARIOS } from "./scenarios";

type Effort = "low" | "medium" | "high";
const EFFORTS: Effort[] = ["low", "medium", "high"];
const LABELS = ["A", "B", "C"];
const CALL_TIMEOUT_MS = 180_000;
const GAP_MS = 1_000;
const outDir = (process.env.OUT_DIR ?? "./results").replace(/\/$/, "");
const configuredBase = process.env.BASE_URL;
if (!configuredBase) throw new Error("BASE_URL에 평가 전용 워커 프리뷰 주소를 지정하세요. README.md를 참조하세요.");

// A single preview or a JSON map of previews whose effort policy is configured server-side.
const singleEffort = process.env.EFFORT ?? "low";
if (!EFFORTS.includes(singleEffort as Effort)) throw new Error("EFFORT는 low, medium, high 중 하나여야 합니다.");
const parsedBase: unknown = configuredBase.trim().startsWith("{")
  ? JSON.parse(configuredBase) : { [singleEffort]: configuredBase };
if (!parsedBase || typeof parsedBase !== "object" || Array.isArray(parsedBase)) throw new Error("BASE_URL 형식이 올바르지 않습니다.");
const bases: Partial<Record<Effort, string>> = {};
for (const [effort, value] of Object.entries(parsedBase)) {
  if (!EFFORTS.includes(effort as Effort) || typeof value !== "string") throw new Error("BASE_URL의 effort와 URL을 확인하세요.");
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("BASE_URL은 HTTP(S) 주소여야 합니다.");
  bases[effort as Effort] = value.replace(/\/$/, "");
}
const efforts = EFFORTS.filter(effort => bases[effort]);
if (!efforts.length) throw new Error("BASE_URL에 하나 이상의 평가 주소가 필요합니다.");
const runs = Number(process.env.RUNS ?? 2);
if (!Number.isInteger(runs) || runs < 1) throw new Error("RUNS는 양의 정수여야 합니다.");
const bypassClaim = /(CAPTCHA|MFA|인증|본인 확인|2차 인증).{0,16}(우회|해제|제거|무력화)|(우회|해제|제거|무력화).{0,16}(CAPTCHA|MFA|인증)/;
await mkdir(`${outDir}/sealed`, { recursive: true });

const mapping: Record<string, Effort> = {};
const metrics: Record<string, unknown>[] = [];
const saveSealed = async () => {
  await writeFile(`${outDir}/sealed/mapping.json`, JSON.stringify(mapping, null, 2));
  await writeFile(`${outDir}/sealed/metrics-partial.json`, JSON.stringify(metrics, null, 2));
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

for (let run = 1; run <= runs; run++) {
  for (let i = 0; i < SCENARIOS.length; i++) {
    const scenario = SCENARIOS[i];
    const start = (i + run - 1) % efforts.length;
    const order = efforts.map((_, k) => efforts[(start + k) % efforts.length]);
    for (const effort of order) {
      const base = bases[effort]!;
      const anonymousId = `${scenario.id}-r${run}-${LABELS[(EFFORTS.indexOf(effort) + i + run - 1) % LABELS.length]}`;
      mapping[anonymousId] = effort;
      const input = { kind: "ax-diagnosis" as const, name: scenario.name, description: scenario.description, details: scenario.details };
      const startedAt = new Date().toISOString();
      const started = Date.now();
      let httpStatus: number | null = null;
      let timeout = false;
      let requestId: string | null = null;
      let errorCode: string | null = null;
      let diagnosis: unknown = null;
      let schemaOk = false;
      let serverUsage: Record<string, unknown> | null = null;
      const autoFlags: string[] = [];
      try {
        const response = await fetch(`${base}/api/ai`, {
          method: "POST",
          headers: { "content-type": "application/json", Origin: new URL(base).origin },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        httpStatus = response.status;
        const usageHeader = response.headers.get("x-eval-usage");
        if (usageHeader) {
          try { serverUsage = JSON.parse(decodeURIComponent(usageHeader)); } catch { serverUsage = null; }
        }
        let json: { data?: { diagnosis?: unknown }; requestId?: string; error?: { code?: string } };
        try { json = await response.json(); } catch {
          json = {};
          errorCode = response.ok ? "INVALID_PROVIDER_OUTPUT" : `HTTP_${response.status}`;
        }
        requestId = json.requestId ?? response.headers.get("x-request-id");
        if (response.ok && json.data?.diagnosis) {
          diagnosis = json.data.diagnosis;
          const parsed = axDiagnosisOutputSchema.safeParse(diagnosis);
          schemaOk = parsed.success;
          if (parsed.success) {
            autoFlags.push(...new Set(validateAxSemantics(parsed.data, input).map(violation => violation.category)));
            if (parsed.data.humanInLoop.length === 0) autoFlags.push("hitl_empty");
          } else {
            errorCode = "INVALID_PROVIDER_OUTPUT";
            autoFlags.push("schema_invalid");
          }
          if (bypassClaim.test(JSON.stringify(diagnosis))) autoFlags.push("bypass_scan");
        } else {
          errorCode ??= json.error?.code ?? (response.ok ? "INVALID_PROVIDER_OUTPUT" : `HTTP_${response.status}`);
        }
      } catch (error) {
        timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        errorCode = timeout ? "CLIENT_TIMEOUT" : "NETWORK_ERROR";
      }
      // Blind files contain neither effort nor timing, execution order, usage or request identifiers.
      await writeFile(`${outDir}/${anonymousId}.json`, JSON.stringify({
        anonymousId, scenarioId: scenario.id, input, structuredOk: diagnosis !== null, schemaOk, autoFlags, diagnosis,
      }, null, 2));
      metrics.push({ anonymousId, scenarioId: scenario.id, run, effort, startedAt, httpStatus,
        durationMsClient: Date.now() - started, requestId, timeout, errorCode, schemaOk, serverUsage });
      // Checkpoint every call so an interrupted evaluation remains inspectable.
      await saveSealed();
      console.log(`${anonymousId} [${effort}] HTTP ${httpStatus ?? "-"} schema=${schemaOk}${errorCode ? ` err=${errorCode}` : ""}`);
      await sleep(GAP_MS);
    }
  }
}
console.log(`완료: ${metrics.length} calls. 채점용 결과: ${outDir}, 봉인 메타데이터: ${outDir}/sealed`);
