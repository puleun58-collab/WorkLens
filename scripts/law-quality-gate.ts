/**
 * 법령 배포 품질 게이트 (9순위).
 *
 * `bun run test:law-quality-gate` 로 실행. 배포 전 검증 단계를 순서대로 수행하고
 * CI 승인/차단 판정과 운영 라이브 검증 상태를 구분해 기록한다.
 *
 * 1단계: 코드 품질 (타입 검사·린트·빌드) — 결정론적
 * 2단계: 법령 회귀 (법령 단위 테스트 전체 — tests/에서 패턴으로 발견) — 결정론적
 * 3단계: 법률 정확도 평가 (7순위 고정 평가셋, 결정론적) — 결정론적
 * 4단계: 실데이터 검증 (law-live-smoke — 수동 실행이므로 이 스크립트에서는 미실행으로 기록)
 *
 * 단계 상태: PASS / FAIL / NOT_RUN
 * - CI 판정(ciVerdict): 1~3단계 기준. 전부 PASS → APPROVED, 하나라도 FAIL → BLOCKED
 * - 운영 검증(liveVerification): 4단계 기준. COMPLETED(성공) / FAILED(핵심 회귀) /
 *   HOLD(외부 장애로 검증 불가) / PENDING(미실행)
 *
 * CI 승인과 운영 검증 완료는 서로 다른 상태다. 라이브 미실행을 성공으로 기록하지 않는다.
 * `--live-result=pass|fail|hold` 로 별도 실행한 라이브 스모크 결과를 반영할 수 있다.
 *
 * 결과는 artifacts/law-quality-gate.json에 기록된다.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { execSync } from "node:child_process";

type StageStatus = "PASS" | "FAIL" | "NOT_RUN";
type StageKind = "deterministic" | "live";
type StageResult = { name: string; status: StageStatus; kind: StageKind; detail: string; ms: number };
type CiVerdict = "APPROVED" | "BLOCKED";
/** 운영 라이브 검증 상태. PENDING=미실행, HOLD=외부 장애로 검증 불가. */
type LiveVerification = "COMPLETED" | "FAILED" | "HOLD" | "PENDING";

function run(command: string, name: string): StageResult {
  const started = Date.now();
  try {
    const output = execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    const tail = output.trim().split("\n").slice(-3).join(" | ");
    return { name, status: "PASS", kind: "deterministic", detail: tail.slice(0, 300), ms: Date.now() - started };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const out = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim().split("\n").slice(-8).join("\n").slice(0, 800);
    return { name, status: "FAIL", kind: "deterministic", detail: out || err.message || "failed", ms: Date.now() - started };
  }
}

/**
 * Law-domain unit tests are discovered from tests/, not listed by hand:
 * a fixed list silently dropped every law test added after the list was
 * written (citation-claim, law-reliability-final, law-title-dedup,
 * decision-followup-trace, citation-linebreak, law-v6, ...). The patterns
 * cover the law domain's file naming only — ax-*, learn-*, guide-* and
 * other suites stay in their own CI jobs and are never pulled in here.
 * E2E (tests/e2e) likewise stays in the integration job, not this gate.
 */
export const LAW_TEST_PATTERNS = [
  /^law-.*\.test\.ts$/,
  /^citation-.*\.test\.ts$/,
  /^research-.*\.test\.ts$/,
  /^decision-.*\.test\.ts$/,
  /^ordinance-.*\.test\.ts$/,
];

export function discoverLawTests(testsDir = "tests"): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(testsDir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => LAW_TEST_PATTERNS.some((pattern) => pattern.test(entry)))
    .sort()
    .map((entry) => `${testsDir}/${entry}`);
}

/** `--live-result=pass|fail|hold` 파싱. 미지정 시 라이브 검증은 미실행(PENDING). */
function parseLiveResult(argv: string[]): LiveVerification {
  const arg = argv.find((a) => a.startsWith("--live-result="));
  if (!arg) return "PENDING";
  const value = arg.slice("--live-result=".length);
  if (value === "pass") return "COMPLETED";
  if (value === "fail") return "FAILED";
  if (value === "hold") return "HOLD";
  console.error(`알 수 없는 --live-result 값: ${value} (pass|fail|hold 중 선택)`);
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--list-tests")) {
    for (const file of discoverLawTests()) console.log(file);
    return;
  }
  const liveVerification = parseLiveResult(argv);
  const stages: StageResult[] = [];
  console.log("=== 1단계: 코드 품질 ===");
  stages.push(run("bun x tsc --noEmit", "typecheck"));
  stages.push(run("bun x eslint src/lib/law-*.ts src/lib/research-*.ts src/lib/citation-*.ts src/app/api/law scripts/law-accuracy scripts/law-quality-gate.ts", "lint:law"));
  stages.push(run("bun run build", "build"));

  console.log("=== 2단계: 법령 회귀 (단위) ===");
  const lawTests = discoverLawTests();
  if (!lawTests.length) {
    stages.push({ name: "law unit tests", status: "FAIL", kind: "deterministic", detail: "no law tests discovered in tests/", ms: 0 });
  } else {
    stages.push(run(`bun x vitest run ${lawTests.join(" ")}`, "law unit tests"));
  }

  console.log("=== 3단계: 법률 정확도 평가 ===");
  stages.push(run("bun scripts/law-accuracy/evaluate.ts", "accuracy evaluation"));

  console.log("=== 4단계: 실데이터 검증 ===");
  // law-live-smoke는 운영 API·외부 MCP에 의존하므로 CI가 아닌 수동 단계.
  // 미실행을 성공으로 기록하지 않는다 — 상태는 NOT_RUN, 운영 검증은 PENDING.
  const liveDetail =
    liveVerification === "PENDING"
      ? "not run in CI (manual: bun run test:law-live)"
      : `recorded via --live-result (${liveVerification})`;
  stages.push({ name: "live smoke", status: "NOT_RUN", kind: "live", detail: liveDetail, ms: 0 });

  const deterministic = stages.filter((s) => s.kind === "deterministic");
  const failed = deterministic.filter((s) => s.status === "FAIL");
  // CI 판정은 결정론적 단계만으로 결정. 라이브 미실행(PENDING)·보류(HOLD)는 CI를 차단하지 않는다.
  const ciVerdict: CiVerdict = failed.length ? "BLOCKED" : "APPROVED";
  // 기존 보고서 호환: verdict는 CI 판정을 그대로 유지.
  const verdict = ciVerdict;

  let commit = "unknown";
  try { commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { /* ignore */ }

  const report = {
    commit,
    date: new Date().toISOString(),
    verdict,
    ciVerdict,
    liveVerification,
    stages: stages.map((s) => ({
      name: s.name,
      status: s.status,
      // 하위 호환: 기존 소비 코드가 pass(boolean)를 읽을 수 있도록 유지.
      // NOT_RUN은 pass:false로 매핑하되 status로 미실행임을 구분한다.
      pass: s.status === "PASS",
      kind: s.kind,
      ms: s.ms,
      detail: s.detail.slice(0, 500),
    })),
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/law-quality-gate.json", JSON.stringify(report, null, 2));

  console.log("\n=== 판정 ===");
  for (const s of stages) console.log(`${s.status}  ${s.name} (${(s.ms / 1000).toFixed(1)}s)`);
  console.log(`\nCI 판정: ${ciVerdict}`);
  console.log(`운영 라이브 검증: ${liveVerification}`);
  if (ciVerdict === "BLOCKED") {
    console.error("차단 사유:");
    for (const s of failed) console.error(`- ${s.name}: ${s.detail.slice(0, 300)}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
