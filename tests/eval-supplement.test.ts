import { describe, expect, it } from "vitest";
import { SUPPLEMENT_EVAL_CASES } from "./eval/supplement-cases";
import { SUPPLEMENT_REALISTIC_CASES } from "./eval/supplement-realistic";
import { SUPPLEMENT_ZERO_CASES } from "./eval/supplement-zero";
import { FAILURE_SEVERITY, formatSummary, runSupplementCase, summarize, type EvalOutcome } from "./eval/supplement-harness";

/**
 * 보완 quality gate on the fixed and realistic development sets, without the
 * model: the model can only cancel candidates, so this run shows the
 * deterministic pipeline's worst case. Meaning-dependent cases are checked for
 * critical failures only. The holdout set is never part of this gate.
 * `bun scripts/supplement-eval.ts --set …` runs a set with the live model.
 */
describe("보완 eval (deterministic)", () => {
  it("has no critical failure and holds precision on the fixed set", async () => {
    const outcomes: EvalOutcome[] = [];
    for (const entry of [...SUPPLEMENT_EVAL_CASES, ...SUPPLEMENT_REALISTIC_CASES, ...SUPPLEMENT_ZERO_CASES]) outcomes.push(await runSupplementCase(entry));
    const summary = summarize(outcomes);
    console.info(formatSummary("보완 eval (deterministic)", summary));
    const critical = summary.failures.filter((failure) => FAILURE_SEVERITY[failure.kind] === "critical");
    expect(critical).toEqual([]);
    expect(summary.byKind["false-positive"]).toBe(0);
    expect(summary.byKind.duplicate).toBe(0);
    expect(summary.recall).toBeGreaterThanOrEqual(95);
    expect(summary.failed).toBe(0);
  }, 120_000);
});

// Adversarial found evidence is scored separately from the established deterministic set.
import { suppliesImplementationCheck } from "@/lib/supplement/sufficiency";
import type { SupplementCheck } from "@/domain/supplement";
const insufficient: Array<[SupplementCheck, string]> = [
  ["baseline", "매출 120억 달성"], ["target", "매출 120억 달성"],
  ["period", "작성일: 2026년 9월 1일"], ["unit", "매출 120. 이동 거리 30km."],
  ["cause", "매출이 15% 감소했다"], ["cause", "원인 분석"],
  ["impact", "영향/기대 효과"], ["response", "향후 대응할 예정이다"],
  ["conclusion", "향후 개선이 기대된다"],
  ["owner", "관련 부서 협의"], ["owner", "담당자 추후 결정"],
  ["schedule", "추후 추진"], ["schedule", "협의 후 실시"],
  ["scope", "필요한 장소에 설치"], ["scope", "세부 범위 추후 결정"],
  ["budget", "견적 후 확정"], ["budget", "예산 추후 결정"],
];
describe("보완 adversarial found sufficiency", () => {
  it.each(insufficient)("%s rejects %s", (check, evidence) => {
    expect(suppliesImplementationCheck(check, evidence)).toBe(false);
  });
  it("부분 해소: 담당만 추가하면 일정·범위·예산은 충족되지 않는다", () => {
    expect(suppliesImplementationCheck("owner", "담당: 경영지원팀")).toBe(true);
    for (const check of ["schedule", "scope", "budget"] as const) expect(suppliesImplementationCheck(check, "담당: 경영지원팀")).toBe(false);
  });
});

import { loadCase } from "./eval/supplement-harness";
import { buildSupplementDraft } from "@/lib/supplement/engine";
import { finalizeSupplement } from "@/lib/supplement/finalize";
import type { SupplementEvalCase } from "./eval/supplement-cases";
describe("보완 adversarial linking", () => {
  for (const [name, origin, explanation] of [
    ["다른 기간", "9월 운송비가 전월 대비 20% 증가했다.", "8월 운송비 증가 원인은 유가 상승 때문이다."],
    ["다른 대상", "고객 A 매출이 전월 대비 20% 감소했다.", "고객 B 매출 감소 원인은 주문 취소 때문이다."],
    ["같은 금액", "9월 운송비 500만원이 전월 대비 20% 증가했다.", "9월 교육비 500만원 증가 원인은 교육 인원 확대 때문이다."],
  ]) {
    it(name, async () => {
      const entry: SupplementEvalCase = { id: name, category: "missing", purpose: name, files: [{ name: "월간보고.docx", docx: [{ heading: "월간 비용 보고" }, origin, explanation] }] };
      const documents = await loadCase(entry);
      const draft = buildSupplementDraft(documents.map((document) => ({ document, fileName: document.metadata.fileName })));
      const candidate = draft.candidates.find((item) => item.check === "cause");
      expect(candidate).toBeDefined();
      const offered = draft.reviews.flatMap((batch) => batch.checks.filter((check) => check.candidateId === candidate!.id).flatMap((check) => check.handles.map((handle) => batch.sources[handle].quote)));
      expect(offered).not.toContain(explanation);
      const result = finalizeSupplement(draft, new Map());
      expect(result.findings.some((item) => item.check === "cause")).toBe(true);
    });
  }
});

describe("보완 adversarial found finalization", () => {
  it("insufficient found evidence preserves candidates; concrete evidence resolves each check", async () => {
    const { SUPPLEMENT_ZERO_CASES } = await import("./eval/supplement-zero");
    const documents = await loadCase(SUPPLEMENT_ZERO_CASES[0]);
    const original = buildSupplementDraft(documents.map((document) => ({ document, fileName: document.metadata.fileName })));
    const template = original.candidates.find((candidate) => candidate.check === "budget")!;
    for (const [check, quote] of insufficient) {
      const candidate = { ...template, check };
      const result = finalizeSupplement({ ...original, candidates: [candidate] }, new Map([[candidate.id, { verdict: "found", sources: [{ ...candidate.sources[0], quote }] }]]));
      expect(result.findings, `${check}: ${quote}`).toHaveLength(1);
      expect(result.findings[0].status).toBe("unverified");
    }
    const sufficient: Array<[SupplementCheck, string]> = [
      ["baseline", "매출은 전월 100억원 대비 120억원으로 증가했다."],
      ["target", "매출 목표: 130억원"], ["period", "9월 매출은 120억원이다."],
      ["unit", "매출은 120억원이다."], ["cause", "주문 취소 때문에 매출이 감소했다."],
      ["impact", "납품 지연으로 고객 생산이 중단되었다."],
      ["response", "온도 센서 교체를 10월까지 추진할 예정이다."],
      ["conclusion", "신규 계약 체결을 확인하여 매출 회복이 예상된다."],
      ["owner", "담당: 경영지원팀"], ["schedule", "추진 일정: 10월 설치 완료"],
      ["scope", "설치 대상: 로비 안내판 3개"], ["budget", "예산: 450만원"],
    ];
    for (const [check, quote] of sufficient) {
      const candidate = { ...template, check };
      const result = finalizeSupplement({ ...original, candidates: [candidate] }, new Map([[candidate.id, { verdict: "found", sources: [{ ...candidate.sources[0], quote }] }]]));
      expect(result.findings, `${check}: ${quote}`).toEqual([]);
    }
  });
});

it("같은 금액의 다른 파일 항목은 원인 근거로 연결하지 않는다", async () => {
  const entry: SupplementEvalCase = { id: "amount-cross-file", category: "linking", purpose: "동액 다른 항목", files: [
    { name: "운송비보고.docx", docx: [{ heading: "9월 운송비 보고" }, "9월 운송비 500만원이 전월 대비 20% 증가했다."] },
    { name: "교육비분석.docx", docx: [{ heading: "9월 교육비 분석" }, "9월 교육비 500만원 증가 원인은 교육 인원 확대 때문이다."] },
  ] };
  const documents = await loadCase(entry);
  const draft = buildSupplementDraft(documents.map((document) => ({ document, fileName: document.metadata.fileName })));
  const candidate = draft.candidates.find((item) => item.check === "cause" && item.fileId === documents[0].fileId)!;
  expect(candidate).toBeDefined();
  expect(candidate.evidence ?? []).toEqual([]);
  const result = finalizeSupplement(draft, new Map());
  expect(result.findings.some((item) => item.check === "cause" && item.fileId === documents[0].fileId && item.scope === "all")).toBe(true);
});
