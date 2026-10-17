/**
 * 법률 정확도 평가 실행기 (결정론적, CI 실행 가능).
 *
 * `bun run test:law-accuracy` 로 실행. 실제 프로덕션 함수를 fixture에 적용해
 * 기대 결과와 비교하고, 핵심 지표를 산출한다.
 *
 * 종료 코드: 중대 실패(허위 인용·직접근거 오판·상태 판정 회귀)가 1건이라도
 * 있으면 non-zero → 배포 품질 게이트에서 차단 판정에 사용.
 * 결과는 artifacts/law-accuracy.json (git-ignored)에 기록된다.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { citedHo, lawCitationTarget, versionMatchesVerification } from "../../src/lib/citation-evidence";
import { researchResult } from "../../src/lib/law-research-parse";
import { questionTerms, rankPrecedent, researchEvidenceSources } from "../../src/lib/research-relevance";
import { ACCURACY_SET_VERSION, CASES, type AccuracyCase } from "./cases";

interface CaseResult {
  id: string;
  category: string;
  kind: string;
  pass: boolean;
  critical: boolean;
  detail: string;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** relevance: 각 판례의 rank가 기대와 일치하는지. */
function runRelevance(c: AccuracyCase): CaseResult {
  const input = c.input as {
    precedents: Array<{ id: string; title?: string; summary?: string; excerpt?: boolean; citedArticles?: string[] }>;
    /** 운영처럼 쟁점별로 분리 평가할 때 사용 (A24). */
    issues?: Array<{ query: string; expect: Record<string, string> }>;
  };
  const expected = c.expected as Record<string, string>;
  const failures: string[] = [];
  const adoptedDirect: string[] = [];
  const check = (terms: readonly string[], expect: Record<string, string>) => {
    for (const p of input.precedents) {
      if (!(p.id in expect)) continue;
      const got = rankPrecedent(terms, { title: p.title, summary: p.summary, excerpt: p.excerpt }, p.citedArticles ?? []).rank;
      if (got === "direct") adoptedDirect.push(p.id);
      if (got !== expect[p.id]) failures.push(`${p.id}: expected ${expect[p.id]}, got ${got}`);
    }
  };
  if (input.issues) {
    for (const issue of input.issues) check(questionTerms(issue.query), issue.expect);
  } else {
    check(questionTerms(c.question), expected);
  }
  // 직접 근거 오판: low여야 할 판례가 direct로 승격되면 중대 실패
  const falseDirect = input.precedents.filter((p) => expected[p.id] === "low" && adoptedDirect.includes(p.id));
  return {
    id: c.id, category: c.category, kind: c.kind,
    pass: failures.length === 0,
    critical: falseDirect.length > 0,
    detail: failures.length ? failures.join("; ") : `ranks ok (${input.precedents.length} precedents)`,
  };
}

/** citation: 인용 라벨 파싱이 기대와 일치하는지. */
function runCitation(c: AccuracyCase): CaseResult {
  const input = c.input as { citation?: string; inputText?: string; citations?: string[]; expectedHo?: Array<number | undefined> };
  const labels = input.citations ?? (input.citation ? [input.citation] : []);
  const parsed = labels.map((label) => lawCitationTarget(label));
  const failures: string[] = [];
  if (Array.isArray(c.expected)) {
    const exp = c.expected as Array<Record<string, unknown>>;
    if (parsed.length !== exp.length) {
      failures.push(`expected ${exp.length} citations, got ${parsed.length}`);
    } else {
      parsed.forEach((p, i) => {
        const e = exp[i];
        const pr = p as unknown as Record<string, unknown>;
        for (const key of Object.keys(e)) {
          if (!deepEqual(pr[key], e[key])) {
            failures.push(`[${i}] ${key}: expected ${JSON.stringify(e[key])}, got ${JSON.stringify(pr[key])}`);
          }
        }
      });
    }
  } else {
    const e = c.expected as Record<string, unknown>;
    const p = parsed[0] as unknown as Record<string, unknown> | undefined;
    if (!p) failures.push("citation did not parse");
    else for (const key of Object.keys(e)) {
      if (!deepEqual(p[key], e[key])) failures.push(`${key}: expected ${JSON.stringify(e[key])}, got ${JSON.stringify(p[key])}`);
    }
  }
  // citedHo 복원 검증 (expectedHo가 명시된 경우)
  if (input.expectedHo) {
    const hos = citedHo(input.inputText ?? "", parsed);
    if (!deepEqual(hos, input.expectedHo)) failures.push(`citedHo: expected ${JSON.stringify(input.expectedHo)}, got ${JSON.stringify(hos)}`);
  }
  // 허위 인용: 파싱 자체가 실패하면 중대 실패
  const critical = parsed.some((p) => p === undefined);
  return {
    id: c.id, category: c.category, kind: c.kind,
    pass: failures.length === 0, critical,
    detail: failures.length ? failures.join("; ") : `parsed: ${labels.join(" | ")}`,
  };
}

/** evidence: researchEvidenceSources가 기대 조문을 채택하는지. */
function runEvidence(c: AccuracyCase): CaseResult {
  const input = c.input as { text: string; issues?: string[] };
  const expected = c.expected as { articles: Array<{ law: string; jo: string }> };
  // 운영처럼 쟁점별로 평가 후 합집합 (issues가 없으면 질문 전체로 1회)
  const queries = input.issues ?? [c.question];
  const merged = new Map<string, { law: string; jo: string }>();
  for (const q of queries) {
    for (const a of researchEvidenceSources(input.text, q, undefined).articles) {
      merged.set(`${a.law}\0${a.jo}`, a);
    }
  }
  const got = [...merged.values()];
  const norm = (list: Array<{ law: string; jo: string }>) => list.map((a) => `${a.law} ${a.jo}`).sort();
  const pass = deepEqual(norm(got), norm(expected.articles));
  // 근거 없는 확정: 기대는 비어 있는데 뭔가 채택되면 중대 실패
  const critical = expected.articles.length === 0 && got.length > 0;
  return {
    id: c.id, category: c.category, kind: c.kind,
    pass, critical,
    detail: pass ? `adopted: ${norm(got).join(", ") || "(none)"}`
      : `expected [${norm(expected.articles).join(", ")}], got [${norm(got).join(", ")}]`,
  };
}

/** version: 시행일·버전 판정이 기대와 일치하는지. */
function runVersion(c: AccuracyCase): CaseResult {
  const input = c.input as { effectiveDate: string; verifiedOn: string };
  const expected = c.expected as { matches: boolean };
  const got = versionMatchesVerification(input.effectiveDate, input.verifiedOn);
  return {
    id: c.id, category: c.category, kind: c.kind,
    pass: got === expected.matches, critical: false,
    detail: `effectiveDate=${input.effectiveDate} verifiedOn=${input.verifiedOn} → ${got}`,
  };
}

/** status: researchResult의 section.unavailable 기준 카운트가 PR #204 규칙과 일치하는지. */
function runStatus(c: AccuracyCase): CaseResult {
  const input = c.input as { text: string };
  const expected = c.expected as { unavailableCount: number; statuses: string[] };
  const doc = researchResult(input.text);
  const unavailableCount = doc.sections.filter((s) => s.unavailable).length;
  const statuses = doc.sections.map((s) => s.status);
  const pass = unavailableCount === expected.unavailableCount && deepEqual(statuses, expected.statuses);
  // 상태 판정 회귀는 중대 실패 (PR #204 회귀 방지)
  const critical = !pass;
  return {
    id: c.id, category: c.category, kind: c.kind,
    pass, critical,
    detail: `statuses=[${statuses.join(", ")}] unavailable=${unavailableCount}`,
  };
}

function runCase(c: AccuracyCase): CaseResult {
  switch (c.kind) {
    case "relevance": return runRelevance(c);
    case "citation": return runCitation(c);
    case "evidence": return runEvidence(c);
    case "version": return runVersion(c);
    case "status": return runStatus(c);
  }
}

async function main(): Promise<void> {
  const results = CASES.map(runCase);
  const pass = results.filter((r) => r.pass);
  const fail = results.filter((r) => !r.pass);
  const critical = results.filter((r) => r.critical);

  // ── 핵심 지표 ──
  const relevanceCases = results.filter((r) => r.kind === "relevance");
  const citationCases = results.filter((r) => r.kind === "citation");
  const evidenceCases = results.filter((r) => r.kind === "evidence");
  const statusCases = results.filter((r) => r.kind === "status");

  // 근거 정확률: 채택 판정(direct/관련 조문) 중 기대와 일치한 비율
  // 근거 재현율: 기대 direct/조문 중 찾아낸 비율 — 케이스 단위로 근사
  const metrics = {
    total: results.length,
    passed: pass.length,
    failed: fail.length,
    criticalFailures: critical.length,
    byKind: {
      relevance: { total: relevanceCases.length, passed: relevanceCases.filter((r) => r.pass).length },
      citation: { total: citationCases.length, passed: citationCases.filter((r) => r.pass).length },
      evidence: { total: evidenceCases.length, passed: evidenceCases.filter((r) => r.pass).length },
      version: { total: results.filter((r) => r.kind === "version").length, passed: results.filter((r) => r.kind === "version" && r.pass).length },
      status: { total: statusCases.length, passed: statusCases.filter((r) => r.pass).length },
    },
    // 직접 관련성 오판율: low여야 할 판례가 direct가 된 케이스 비율
    falseDirectRate: relevanceCases.length ? critical.filter((r) => r.kind === "relevance").length / relevanceCases.length : 0,
    // 근거 없는 확정률: 근거가 없어야 할 케이스에서 근거를 채택한 비율
    unfoundedAssertionRate: evidenceCases.length ? critical.filter((r) => r.kind === "evidence").length / evidenceCases.length : 0,
    // 인용 정확성: citation 케이스 통과율
    citationAccuracy: citationCases.length ? citationCases.filter((r) => r.pass).length / citationCases.length : 0,
    // 상태 판정 정확도: status 케이스 통과율
    statusAccuracy: statusCases.length ? statusCases.filter((r) => r.pass).length / statusCases.length : 0,
  };

  let commit = "unknown";
  try {
    commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch { /* git 없는 환경 무시 */ }

  const report = {
    version: ACCURACY_SET_VERSION,
    commit,
    date: new Date().toISOString(),
    metrics,
    failures: fail.map((r) => ({ id: r.id, category: r.category, kind: r.kind, critical: r.critical, detail: r.detail })),
  };

  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/law-accuracy.json", JSON.stringify(report, null, 2));

  console.log(`\n법률 정확도 평가 v${ACCURACY_SET_VERSION} (commit ${commit})`);
  console.log(`총 ${metrics.total}건: 통과 ${metrics.passed}, 실패 ${metrics.failed}, 중대 ${metrics.criticalFailures}`);
  console.log(`- 관련성: ${metrics.byKind.relevance.passed}/${metrics.byKind.relevance.total}`);
  console.log(`- 인용: ${metrics.byKind.citation.passed}/${metrics.byKind.citation.total} (정확성 ${(metrics.citationAccuracy * 100).toFixed(1)}%)`);
  console.log(`- 근거 채택: ${metrics.byKind.evidence.passed}/${metrics.byKind.evidence.total}`);
  console.log(`- 버전·시행일: ${metrics.byKind.version.passed}/${metrics.byKind.version.total}`);
  console.log(`- 상태 판정: ${metrics.byKind.status.passed}/${metrics.byKind.status.total} (정확도 ${(metrics.statusAccuracy * 100).toFixed(1)}%)`);
  console.log(`- 직접관련성 오판율: ${(metrics.falseDirectRate * 100).toFixed(1)}%`);
  console.log(`- 근거없는 확정률: ${(metrics.unfoundedAssertionRate * 100).toFixed(1)}%`);
  for (const f of fail) console.log(`  FAIL [${f.id}] ${f.category}: ${f.detail}${f.critical ? " (CRITICAL)" : ""}`);
  console.log(`보고서: artifacts/law-accuracy.json`);

  if (critical.length > 0) {
    console.error(`\n중대 실패 ${critical.length}건 — 배포 차단 대상`);
    process.exit(1);
  }
  if (fail.length > 0) {
    console.error(`\n실패 ${fail.length}건 (중대 아님)`);
    process.exit(2);
  }
  console.log("\n전체 통과");
}

main().catch((error) => {
  console.error(error);
  process.exit(3);
});
