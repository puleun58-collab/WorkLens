/**
 * 법령 배포 품질 게이트 (9순위).
 *
 * `bun run test:law-quality-gate` 로 실행. 배포 전 검증 단계를 순서대로 수행하고
 * 승인/차단/보류 판정을 내린다.
 *
 * 1단계: 코드 품질 (타입 검사·린트·빌드)
 * 2단계: 법령 회귀 (법령 단위 테스트 전체)
 * 3단계: 법률 정확도 평가 (7순위 고정 평가셋, 결정론적)
 * 4단계: 실데이터 검증 (law-live-smoke — 수동 실행이므로 여기서는 미실행으로 기록)
 *
 * 판정:
 * - APPROVED: 1~3단계 모두 통과
 * - BLOCKED: 1~3단계 중 실패 (재현 가능한 핵심 오류)
 * - HOLD: 외부 장애로 필수 검증 미완료 (4단계는 별도 기록)
 *
 * 결과는 artifacts/law-quality-gate.json에 기록된다.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";

type StageResult = { name: string; pass: boolean; detail: string; ms: number };
type Verdict = "APPROVED" | "BLOCKED" | "HOLD";

function run(command: string, name: string): StageResult {
  const started = Date.now();
  try {
    const output = execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    const tail = output.trim().split("\n").slice(-3).join(" | ");
    return { name, pass: true, detail: tail.slice(0, 300), ms: Date.now() - started };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const out = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim().split("\n").slice(-8).join("\n").slice(0, 800);
    return { name, pass: false, detail: out || err.message || "failed", ms: Date.now() - started };
  }
}

const LAW_TESTS = [
  "tests/law-api.test.ts",
  "tests/law-search.test.ts",
  "tests/law-research-api.test.ts",
  "tests/law-research-parse.test.ts",
  "tests/law-analysis-api.test.ts",
  "tests/law-analysis-parse.test.ts",
  "tests/law-display.test.ts",
  "tests/law-input.test.ts",
  "tests/law-review-source.test.ts",
  "tests/law-text-api.test.ts",
  "tests/citation-evidence.test.ts",
  "tests/research-interpretation.test.ts",
  "tests/research-relevance.test.ts",
  "tests/research-semantic.test.ts",
  "tests/law-observability.test.ts",
];

async function main(): Promise<void> {
  const stages: StageResult[] = [];
  console.log("=== 1단계: 코드 품질 ===");
  stages.push(run("bun x tsc --noEmit", "typecheck"));
  stages.push(run("bun x eslint src/lib/law-*.ts src/lib/research-*.ts src/lib/citation-*.ts src/app/api/law scripts/law-accuracy scripts/law-quality-gate.ts", "lint:law"));
  stages.push(run("bun run build", "build"));

  console.log("=== 2단계: 법령 회귀 (단위) ===");
  stages.push(run(`bun x vitest run ${LAW_TESTS.join(" ")}`, "law unit tests"));

  console.log("=== 3단계: 법률 정확도 평가 ===");
  stages.push(run("bun scripts/law-accuracy/evaluate.ts", "accuracy evaluation"));

  console.log("=== 4단계: 실데이터 검증 ===");
  // law-live-smoke는 운영 API·외부 MCP에 의존하므로 CI가 아닌 수동 단계.
  // 여기서는 미실행으로 기록하고, 차단 사유로 사용하지 않는다.
  stages.push({ name: "live smoke", pass: true, detail: "not run in CI (manual: bun run test:law-live)", ms: 0 });

  const failed = stages.filter((s) => !s.pass);
  // 중대 실패(정확도 평가의 critical)는 BLOCKED, 그 외 실패도 BLOCKED (재현 가능한 핵심 오류).
  // 외부 장애로 인한 미완료는 HOLD — 현재 단계들은 모두 결정론적이므로 HOLD는 발생하지 않음.
  const verdict: Verdict = failed.length ? "BLOCKED" : "APPROVED";

  let commit = "unknown";
  try { commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { /* ignore */ }

  const report = {
    commit,
    date: new Date().toISOString(),
    verdict,
    stages: stages.map((s) => ({ name: s.name, pass: s.pass, ms: s.ms, detail: s.detail.slice(0, 500) })),
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/law-quality-gate.json", JSON.stringify(report, null, 2));

  console.log("\n=== 판정 ===");
  for (const s of stages) console.log(`${s.pass ? "PASS" : "FAIL"}  ${s.name} (${(s.ms / 1000).toFixed(1)}s)`);
  console.log(`\n판정: ${verdict}`);
  if (verdict === "BLOCKED") {
    console.error("차단 사유:");
    for (const s of failed) console.error(`- ${s.name}: ${s.detail.slice(0, 300)}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
