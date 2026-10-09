import { afterEach, describe, expect, it, vi } from "vitest";
import { PLAN_ADDITIONS, SUPPLEMENT_ZERO_CASES } from "./eval/supplement-zero";
import { loadCase, runSupplementCase } from "./eval/supplement-harness";
import { reviewSupplementServerAi } from "@/client/server-ai-client";
import { buildSupplementDraft } from "@/lib/supplement/engine";
import { finalizeSupplement, type SupplementReviewOutcome } from "@/lib/supplement/finalize";
import { parseSupplementReview } from "@/lib/ai/supplement-prompt";

afterEach(() => { vi.unstubAllGlobals(); });
describe("보완 0건 회귀", () => {
  for (const evidence of ["empty", "deferred"] as const) {
    it(`비용 found의 ${evidence} 근거는 누락을 해소하지 않고 확인 필요로 남긴다`, async () => {
      const documents = await loadCase(SUPPLEMENT_ZERO_CASES[0]);
      const draft = buildSupplementDraft(documents.map((document) => ({ document, fileName: document.metadata.fileName })));
      const budget = draft.candidates.find((candidate) => candidate.check === "budget")!;
      const result = finalizeSupplement(draft, new Map([[budget.id, { verdict: "found", sources: evidence === "empty" ? [] : budget.sources }]]));
      const finding = result.findings.find((candidate) => candidate.check === "budget");
      expect(finding).toMatchObject({ status: "unverified", severity: "warning" });
    });
  }
  for (const check of ["owner", "schedule", "scope"] as const) {
    it(`${check}: 협의·미정 언급은 보존하고 실제 After 정보는 AI 반증으로 수용한다`, async () => {
      const before = (await loadCase(SUPPLEMENT_ZERO_CASES[0]))[0];
      const after = (await loadCase(SUPPLEMENT_ZERO_CASES[1]))[0];
      const draft = buildSupplementDraft([{ document: before, fileName: before.metadata.fileName }]);
      const candidate = draft.candidates.find((item) => item.check === check)!;
      const deferred = finalizeSupplement(draft, new Map([[candidate.id, { verdict: "found", sources: candidate.sources }]]));
      expect(deferred.findings.find((finding) => finding.check === check)).toMatchObject({ status: "unverified", severity: "warning" });
      const answer = after.blocks.find((block) => block.type === "paragraph" && block.text === PLAN_ADDITIONS[check])!;
      const sufficient = finalizeSupplement(draft, new Map([[candidate.id, { verdict: "found", sources: [{ ...answer.source, fileId: before.fileId }] }]]));
      expect(sufficient.findings.some((finding) => finding.check === check)).toBe(false);
    });
  }
  it("비용 found가 실제 After 금액 원문을 가리키면 비용 후보를 해소한다", async () => {
    const before = (await loadCase(SUPPLEMENT_ZERO_CASES[0]))[0];
    const after = (await loadCase(SUPPLEMENT_ZERO_CASES[1]))[0];
    const draft = buildSupplementDraft([{ document: before, fileName: before.metadata.fileName }]);
    const budget = draft.candidates.find((candidate) => candidate.check === "budget")!;
    const amount = after.blocks.find((block) => block.type === "paragraph" && block.text.includes("450만원"))!;
    const result = finalizeSupplement(draft, new Map([[budget.id, { verdict: "found", sources: [{ ...amount.source, fileId: before.fileId }] }]]));
    expect(result.findings.some((finding) => finding.check === "budget")).toBe(false);
  });
  it("provider found의 빈 sources는 unclear veto로 바뀌지 않고 비용 확인을 보존한다", async () => {
    const documents = await loadCase(SUPPLEMENT_ZERO_CASES[0]);
    const draft = buildSupplementDraft(documents.map((document) => ({ document, fileName: document.metadata.fileName })));
    const outcomes = new Map<string, SupplementReviewOutcome>();
    for (const batch of draft.reviews) {
      const answers = parseSupplementReview({ verdicts: batch.checks.map((check) => ({ id: check.id, verdict: "found", sources: [] })) }, batch.checks);
      for (const answer of answers) {
        const check = batch.checks.find((item) => item.id === answer.id)!;
        outcomes.set(check.candidateId, { verdict: answer.verdict, sources: answer.handles.map((handle) => batch.sources[handle]) });
      }
    }
    const result = finalizeSupplement(draft, outcomes);
    expect(result.findings.find((finding) => finding.check === "budget")).toMatchObject({ status: "unverified", severity: "warning" });
    expect(result.semanticReview).toBe("partial");
  });
  it("HTTP 200의 빈 handles·일부 unclear 응답을 받은 뒤 같은 앵커의 3개 누락으로 종료한다", async () => {
    const documents = await loadCase(SUPPLEMENT_ZERO_CASES[0]);
    const draft = buildSupplementDraft(documents.map((document) => ({ document, fileName: document.metadata.fileName })));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { kind: "supplement-review", verdicts: [
      { id: "C1", verdict: "not_found", handles: [] }, { id: "C2", verdict: "not_found", handles: [] },
      { id: "C3", verdict: "not_found", handles: [] }, { id: "C4", verdict: "unclear", handles: [] },
    ] } }), { status: 200 })));
    const outcomes = new Map<string, SupplementReviewOutcome>();
    for (const batch of draft.reviews) {
      const answers = await reviewSupplementServerAi(batch.checks, batch.items);
      for (const answer of answers) {
        const check = batch.checks.find((entry) => entry.id === answer.id);
        if (check) outcomes.set(check.candidateId, { verdict: answer.verdict, sources: answer.handles.map((handle) => batch.sources[handle]).filter(Boolean) });
      }
    }
    const result = finalizeSupplement(draft, outcomes);
    expect(result.findings.map((finding) => finding.check).sort()).toEqual(["owner", "schedule", "scope"]);
    expect(result.findings.every((finding) => finding.locations[0] === "추진 방법")).toBe(true);
    expect(result.withheldCount).toBe(1);
    expect(result.semanticReview).toBe("complete");
  }, 2_000);
  it("정의된 Must-Find가 모두 사라지면 critical gate가 실패한다", async () => {
    const outcome = await runSupplementCase(SUPPLEMENT_ZERO_CASES[0], async (batch) => batch.checks.map((check) => ({ id: check.id, verdict: "unclear" as const, handles: [] })));
    expect(outcome.result.findings).toEqual([]);
    expect(outcome.failures.some((failure) => failure.kind === "zero-result")).toBe(true);
  });
  for (const failure of ["timeout", "rate-limit", "network", "provider-unavailable", "malformed", "parse-failure", "retry-exhausted"]) {
    it(`${failure}: deterministic 후보 보존, 시스템 영향과 품질 분리`, async () => {
      const outcome = await runSupplementCase(SUPPLEMENT_ZERO_CASES[0], async () => { throw new Error(failure); });
      expect(outcome.systemAffected).toBe(true);
      expect(outcome.expected).toBe(0);
      expect(outcome.result.semanticReview).toBe("partial");
      expect(outcome.result.findings.map((finding) => finding.check).sort()).toEqual(["budget", "owner", "schedule", "scope"]);
      expect(outcome.result.findings.every((finding) => finding.status === "unverified")).toBe(true);
    });
  }
});

