import { describe, expect, it } from "vitest";
import type { SupplementCheck, SupplementDraft } from "@/domain/supplement";
import { parseSupplementReview } from "@/lib/ai/supplement-prompt";
import { buildSupplementDraft } from "@/lib/supplement/engine";
import { finalizeSupplement, type SupplementReviewOutcome } from "@/lib/supplement/finalize";
import { suppliesImplementationCheck, unresolvedImplementationChecks } from "@/lib/supplement/sufficiency";
import { periodOf, periodsCompatible } from "@/lib/supplement/text";
import type { SupplementEvalCase } from "./eval/supplement-cases";
import { loadCase } from "./eval/supplement-harness";
import { SUPPLEMENT_UNRESOLVED_CASES, SUPPLEMENT_UNRESOLVED_REPRESENTATIVE_CASE } from "./eval/supplement-unresolved-cases";

const states: Array<{ check: SupplementCheck; text: string }> = [
  { check: "baseline", text: "피킹 소요시간 31분, 전월 기준 없음" },
  { check: "baseline", text: "설비 고장 3건, 전월 기준 미기재" },
  { check: "owner", text: "지원 인력 정식 담당자 미정" },
  { check: "budget", text: "지원 인력 승인 예산 미확정" },
  { check: "scope", text: "지원 인력 투입 범위 추후 협의" },
  { check: "owner", text: "지원 인력 담당자 추후 결정" },
  { check: "budget", text: "LED 교체 견적 1,800만원, 실제 집행액 별도 정산 필요" },
  { check: "schedule", text: "지원 인력 투입 일정 검토 예정" },
  { check: "target", text: "4분기 정시 납품률 목표를 결정하지 못함" },
  { check: "budget", text: "지원 인력 승인 예산 확정 전" },
  { check: "schedule", text: "지원 인력 투입 일정 예정 없음" },
  { check: "scope", text: "지원 인력 투입 범위 협의 중" },
  { check: "target", text: "4분기 정시 납품률 목표가 정리되지 않음" },
];

const transitions: Array<{ check: SupplementCheck; requirement?: string; before: string; after: string }> = [
  { check: "baseline", before: "피킹 소요시간 31분, 전월 기준 미기재", after: "피킹 소요시간 전월 35분 대비 31분" },
  { check: "owner", before: "지원 인력 담당자 미정", after: "지원 인력 담당: 물류운영팀" },
  { check: "budget", requirement: "승인 예산", before: "지원 인력 승인 예산 미확정", after: "지원 인력 승인 예산: 2,000만원 확정" },
  { check: "budget", requirement: "실제 집행액", before: "LED 교체 실제 집행액 별도 정산 필요", after: "LED 교체 실제 집행액: 1,750만원 정산 완료" },
  { check: "target", before: "정시 납품률 목표 미정", after: "정시 납품률 목표: 95%" },
  { check: "schedule", before: "지원 인력 투입 일정 미정", after: "지원 인력 투입 일정: 2026년 10월 31일 완료" },
  { check: "scope", before: "지원 인력 투입 범위 추후 협의", after: "지원 인력 투입 대상: 1층 피킹 구역 3곳" },
];

async function draftOf(entry: SupplementEvalCase): Promise<SupplementDraft> {
  const documents = await loadCase(entry);
  return buildSupplementDraft(documents.map((document) => ({ document, fileName: document.metadata.fileName })));
}

const matches = (finding: { check: SupplementCheck; scope: string; status: string; locations: string[] }, expected: NonNullable<SupplementEvalCase["must"]>[number]) =>
  finding.check === expected.check
  && (expected.scope === undefined || finding.scope === expected.scope)
  && (expected.status === undefined || finding.status === expected.status)
  && (expected.at === undefined || finding.locations.some((location) => location.includes(expected.at!)));

describe("보완 — 필드별 미확정 상태와 실제 확정값", () => {
  it("분기와 월을 구분하고 해당 분기의 실행 기한만 연결한다", () => {
    const quarter = periodOf("2026년 4분기 스캐너 교체 계획");
    expect(quarter).toEqual({ year: 2026, quarter: 4 });
    expect(periodsCompatible(quarter, periodOf("2026년 10월 31일 완료"))).toBe(true);
    expect(periodsCompatible(quarter, periodOf("2026년 8월 31일 완료"))).toBe(false);
    expect(periodsCompatible(quarter, periodOf("2025년 10월 31일 완료"))).toBe(false);
  });
  it("누적·기간 범위는 같은 해의 단월 실적과 직접 연결하지 않는다", () => {
    const month = periodOf("2026년 9월 인건비");
    for (const title of ["2026년 1~9월 누적 인건비", "2026년 인건비 YTD", "2026년 누계 인건비"]) {
      const cumulative = periodOf(title);
      expect(periodsCompatible(month, cumulative)).toBe(false);
      expect(periodsCompatible(cumulative, month)).toBe(false);
    }
    expect(periodsCompatible(periodOf("2026년 누적 인건비"), periodOf("2026년 누계 인건비"))).toBe(true);
  });

  it("현재 평균의 재언급은 비교 기준값이 아니다", () => {
    expect(suppliesImplementationCheck("baseline", "피킹 소요시간 평균 31분")).toBe(false);
    expect(suppliesImplementationCheck("baseline", "피킹 소요시간 평균 31분, 전월 35분")).toBe(true);
  });

  it.each(states)("$check: $text는 실제 충족값이 아니다", ({ check, text }) => {
    const requirement = text.includes("실제 집행액") ? "실제 집행액" : text.includes("승인 예산") ? "승인 예산" : undefined;
    expect(suppliesImplementationCheck(check, text, requirement)).toBe(false);
    expect(unresolvedImplementationChecks(text)).toContain(check);
  });

  it.each([
    ["target", "정시 납품률 목표: 95%. 설비 고장 없음"],
    ["owner", "담당: 물류운영팀 배정 완료. 추가 투입 예정 없음"],
    ["baseline", "납기 지연은 전월 18건 대비 14건. 추가 조치 없음"],
    ["budget", "승인 예산: 2,000만원 확정. 추가 예산 없음"],
  ] as const)("%s: 다른 필드의 부정 상태가 실제 값을 무효화하지 않는다", (check, text) => {
    expect(suppliesImplementationCheck(check, text)).toBe(true);
    expect(unresolvedImplementationChecks(text)).not.toContain(check);
  });

  it.each(transitions)("$check: 뒤의 실제 값이 앞의 미확정을 해소한다", ({ check, before, after, requirement }) => {
    expect(suppliesImplementationCheck(check, before, requirement)).toBe(false);
    expect(suppliesImplementationCheck(check, `${before}.\n${after}.`, requirement)).toBe(true);
    expect(unresolvedImplementationChecks(`${before}.\n${after}.`)).not.toContain(check);
    expect(suppliesImplementationCheck(check, `${before}.\n${before}.`, requirement)).toBe(false);
    expect(unresolvedImplementationChecks(`${before}.\n${before}.`)).toContain(check);
  });

  it("같은 문장 안의 과거 미정과 현재 확정을 구분한다", () => {
    const text = "지원 인력 담당자는 미정이었으나 담당: 물류운영팀으로 확정했다.";
    expect(suppliesImplementationCheck("owner", text, "정식 책임자")).toBe(true);
    expect(unresolvedImplementationChecks(text)).not.toContain("owner");
  });

  it("견적·승인·정산은 해당 예산 요구사항에만 충족된다", () => {
    const estimate = "LED 교체 견적: 1,800만원";
    const approved = "LED 교체 승인 예산: 2,000만원 확정";
    const actual = "LED 교체 실제 집행액: 1,750만원 정산 완료";
    expect(suppliesImplementationCheck("budget", estimate)).toBe(true);
    expect(suppliesImplementationCheck("budget", estimate, "승인 예산")).toBe(false);
    expect(suppliesImplementationCheck("budget", estimate, "실제 집행액")).toBe(false);
    expect(suppliesImplementationCheck("budget", approved, "승인 예산")).toBe(true);
    expect(suppliesImplementationCheck("budget", approved, "실제 집행액")).toBe(false);
    expect(suppliesImplementationCheck("budget", actual, "실제 집행액")).toBe(true);
  });

  it("임시 배정은 정식 책임자 확정과 구분한다", () => {
    const temporary = "지원 인력 담당: 운영1팀 임시 배정. 정식 책임자는 미정";
    expect(suppliesImplementationCheck("owner", temporary, "정식 책임자")).toBe(false);
    expect(suppliesImplementationCheck("owner", `${temporary}. 정식 책임자: 물류운영팀 확정`, "정식 책임자")).toBe(true);
  });
});

describe("보완 — 실제 파서에서 초안과 최종 결과까지", () => {
  it.each(SUPPLEMENT_UNRESOLVED_CASES)("$id: $purpose", async (entry) => {
    const draft = await draftOf(entry);
    const result = finalizeSupplement(draft, new Map());
    for (const expected of entry.must ?? []) {
      const finding = result.findings.find((item) => matches(item, expected));
      expect(finding, `${entry.id}: ${expected.check}`).toBeDefined();
      expect(finding!.sources.every((source) => draft.files.some((file) => file.fileId === source.fileId))).toBe(true);
      expect(finding!.scope).toBe(expected.scope ?? "all");
      expect(["missing", "unverified"]).toContain(finding!.status);
    }
    for (const expected of entry.mustNot ?? []) expect(result.findings.some((item) => matches(item, expected))).toBe(false);
    if (entry.quiet) expect(result.findings.filter((item) => item.severity !== "suggestion")).toEqual([]);
    for (const [index, coverage] of (entry.coverage ?? []).entries()) {
      expect(result.coverage[index]).toMatchObject({ total: coverage.total, complete: coverage.complete });
      if (coverage.analyzed !== undefined) expect(result.coverage[index].analyzed).toBe(coverage.analyzed);
    }
    if (entry.neverLinkFrom) expect(result.findings.flatMap((item) => item.evidenceLocations ?? []).some((location) => location.startsWith(entry.neverLinkFrom!))).toBe(false);
    if (entry.linkFrom) expect(result.findings.flatMap((item) => item.evidenceLocations ?? []).some((location) => location.startsWith(entry.linkFrom!))).toBe(true);
  }, 30_000);

  it("실제 운영 개선 보고서의 두 비교 기준 누락을 정상 비교값과 분리한다", async () => {
    const draft = await draftOf(SUPPLEMENT_UNRESOLVED_REPRESENTATIVE_CASE);
    const result = finalizeSupplement(draft, new Map());
    const baseline = result.findings.filter((item) => item.check === "baseline");
    expect(baseline.some((item) => /31\s*분/u.test(item.current))).toBe(true);
    expect(baseline.some((item) => /3\s*건/u.test(item.current))).toBe(true);
    expect(baseline.some((item) => /14\s*건|8\s*건/u.test(item.current))).toBe(false);
    expect(result.findings.some((item) => item.check === "target" && /4\s*분기|Q4/u.test(item.current))).toBe(true);
    // A resolved-stage count is not a claim that every needed field was supplied.
    expect(result.findings.some((item) => item.check === "owner")).toBe(true);
    expect(result.findings.some((item) => item.check === "budget")).toBe(true);
    expect(result.findings.some(item => item.check === "scope" && /세부 확대 범위/u.test(item.current))).toBe(true);
  });
});

const semanticFields = [
  { check: "baseline", negative: "피킹 소요시간 31분, 전월 기준 미기재", positive: "피킹 소요시간 전월 35분 대비 31분" },
  { check: "owner", negative: "지원 인력 정식 책임자 미정", positive: "지원 인력 정식 책임자: 물류운영팀 확정" },
  { check: "budget", negative: "지원 인력 승인 예산 미확정", positive: "지원 인력 승인 예산: 2,000만원 확정" },
  { check: "budget", negative: "LED 교체 견적 1,800만원, 실제 집행액 별도 정산 필요", positive: "LED 교체 실제 집행액: 1,750만원 정산 완료" },
  { check: "target", negative: "정시 납품률 목표 미정", positive: "정시 납품률 목표: 95%" },
  { check: "schedule", negative: "지원 인력 투입 일정 미정", positive: "지원 인력 투입 일정: 2026년 10월 31일 완료" },
  { check: "scope", negative: "지원 인력 투입 범위 추후 협의", positive: "지원 인력 투입 대상: 1층 피킹 구역 3곳" },
] as const;

describe("보완 — 의미 재확인 판정과 해소 집계", () => {
  it.each(semanticFields)("$check: $negative에 대한 유효 근거와 판정 정책", async ({ check, negative, positive }) => {
    const entry: SupplementEvalCase = {
      id: `semantic-${check}-${negative}`, category: "missing", purpose: negative,
      files: [{ name: "물류운영보고.docx", docx: [{ heading: "물류 운영 개선 보고" }, "지원 인력 투입 및 LED 교체를 추진한다.", negative] }],
    };
    const documents = await loadCase(entry);
    const original = buildSupplementDraft(documents.map((document) => ({ document, fileName: document.metadata.fileName })));
    const candidate = original.candidates.find((item) => item.check === check && item.current.includes(negative));
    expect(candidate, negative).toBeDefined();
    const negativeBlock = documents[0].blocks.find((block) => block.type === "paragraph" && block.text === negative);
    expect(negativeBlock?.type).toBe("paragraph");
    // Model evidence is canonical parsed content, including a valid handle for the unresolved field.
    const request = { id: "C1", candidateId: candidate!.id, statement: candidate!.current, requirement: candidate!.requirement, handles: ["E1"] };
    const batch = { checks: [request], items: [{ handle: "E1", text: negative }], sources: { E1: negativeBlock!.source } };
    const parsed = parseSupplementReview({ verdicts: [{ id: request.id, verdict: "found", sources: ["E1"] }] }, batch.checks);
    const unsupported: SupplementReviewOutcome = { verdict: parsed[0].verdict, sources: parsed[0].handles.map((handle) => batch.sources[handle as keyof typeof batch.sources]) };
    const draft = { ...original, candidates: [candidate!], reviews: [batch] };
    const found = finalizeSupplement(draft, new Map([[candidate!.id, unsupported]]));
    expect(found.findings).toHaveLength(1);
    expect(found.findings[0]).toMatchObject({ check, scope: "all", status: "unverified" });
    expect(found.resolvedCount).toBe(original.resolvedCount);
    expect(found.confirmedCount).toBe(0);
    expect(found.withheldCount).toBe(0);

    const missing = finalizeSupplement(draft, new Map([[candidate!.id, { verdict: "not_found", sources: [] }]]));
    expect(missing.findings).toHaveLength(1);
    expect(missing.findings[0]).toMatchObject({ check, scope: "all", status: "missing" });
    expect(missing.resolvedCount).toBe(original.resolvedCount);

    const unclear = finalizeSupplement(draft, new Map([[candidate!.id, { verdict: "unclear", sources: [] }]]));
    expect(unclear.findings).toEqual([]);
    expect(unclear.withheldCount).toBe(1);
    expect(unclear.resolvedCount).toBe(original.resolvedCount);

    const weaker = negative.includes("실제 집행액") ? "LED 교체 견적: 1,800만원"
      : negative.includes("승인 예산") ? "지원 인력 예상 비용: 2,000만원"
        : negative.includes("정식 책임자") ? "지원 인력 담당: 운영1팀 임시 배정" : undefined;
    if (weaker) {
      const [weakerDocument] = await loadCase({ ...entry, files: [{ name: entry.files[0].name, docx: [weaker] }] });
      const weakerBlock = weakerDocument.blocks.find((block) => block.type === "paragraph" && block.text === weaker);
      expect(weakerBlock?.type).toBe("paragraph");
      const rejected = finalizeSupplement(draft, new Map([[candidate!.id, { verdict: "found", sources: [weakerBlock!.source] }]]));
      expect(rejected.findings).toHaveLength(1);
      expect(rejected.findings[0]).toMatchObject({ check, status: "unverified", scope: "all" });
      expect(rejected.resolvedCount).toBe(original.resolvedCount);
      expect(rejected.withheldCount).toBe(0);
    }

    // Parse the later actual value rather than borrowing a budget candidate or inventing a quote.
    const [document] = await loadCase({ ...entry, files: [{ name: entry.files[0].name, docx: [{ heading: "물류 운영 개선 보고" }, positive] }] });
    const block = document.blocks.find((block) => block.type === "paragraph" && block.text === positive);
    expect(block?.type).toBe("paragraph");
    const resolved = finalizeSupplement(draft, new Map([[candidate!.id, { verdict: "found", sources: [block!.source] }]]));
    expect(resolved.findings).toEqual([]);
    expect(resolved.resolvedCount).toBe(original.resolvedCount + 1);
    expect(resolved.confirmedCount).toBe(0);
    expect(resolved.withheldCount).toBe(0);
  });
});
