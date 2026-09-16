import { describe, expect, it } from "vitest";
import type { NormalizedDocument } from "@/domain/document";
import { buildEvidenceNodes } from "@/lib/ai/grounding";
import { askRelevance } from "@/lib/ai/retrieval";
import { EVAL_CASES, type EvalCase } from "./eval/cases";
import { evalDocuments } from "./eval/fixtures";
import { percentage, runRetrieval } from "./eval/harness";

/**
 * Retrieval evaluation.
 *
 * Measures whether the evidence that actually answers each question reaches
 * the prompt window, independent of any model. When Ask quality regresses this
 * is the first place to look: a Recall drop is a retrieval problem, a stable
 * Recall with bad answers is a generation problem.
 */
const answerable = EVAL_CASES.filter((entry) => !entry.refuse);
const unanswerable = EVAL_CASES.filter((entry) => entry.refuse);

async function candidatesFor(entry: EvalCase) {
  const documents = await evalDocuments();
  const document = documents.get(entry.format);
  if (!document) throw new Error(`missing eval fixture for ${entry.format}`);
  return buildEvidenceNodes([document]);
}

/** A handful of paragraphs: the case the gate must not wave through. */
function smallDocument(id: string, lines: readonly string[]): NormalizedDocument {
  return {
    id: `document:${id}`,
    fileId: id,
    kind: "docx",
    metadata: { fileName: `${id}.docx` },
    blocks: lines.map((text, index) => ({
      type: "paragraph" as const,
      id: `${id}:p${index}`,
      text,
      source: { fileId: id, nodeId: `${id}:p${index}`, label: `Paragraph ${index + 1}`, quote: text },
    })),
    warnings: [],
  };
}

describe("retrieval eval", () => {
  it("keeps every answerable case reachable in the evidence index", async () => {
    const missing: string[] = [];
    for (const entry of answerable) {
      const outcome = await runRetrieval(entry);
      if (!outcome.present) missing.push(entry.id);
    }
    // A missing case means the fixture or the expectation is wrong, not the ranker.
    expect(missing).toEqual([]);
  });

  it("reports Recall@5, Recall@10 and Recall@20 over the fixed case set", async () => {
    const hits: Record<number, number> = { 5: 0, 10: 0, 20: 0 };
    const missed: string[] = [];
    for (const entry of answerable) {
      for (const limit of [5, 10, 20]) {
        const outcome = await runRetrieval(entry, limit);
        if (outcome.hit) hits[limit] += 1;
        else if (limit === 20) missed.push(entry.id);
      }
    }
    const summary = {
      cases: answerable.length,
      "recall@5": percentage(hits[5], answerable.length),
      "recall@10": percentage(hits[10], answerable.length),
      "recall@20": percentage(hits[20], answerable.length),
      missed,
    };
    console.info("retrieval eval", summary);
    expect(summary["recall@20"]).toBeGreaterThanOrEqual(95);
    expect(summary["recall@10"]).toBeGreaterThanOrEqual(90);
    expect(summary["recall@5"]).toBeGreaterThanOrEqual(80);
  });

  it("does not surface evidence for questions the documents cannot answer", async () => {
    const leaked: string[] = [];
    for (const entry of unanswerable) {
      const outcome = await runRetrieval(entry);
      if (outcome.present) leaked.push(entry.id);
    }
    console.info("unanswerable eval", { cases: unanswerable.length, leaked });
    expect(leaked).toEqual([]);
  });
});

/**
 * Ask answerability gate. The thresholds in `askRelevance` are only valid if
 * they keep every answerable case answerable, so recall is measured first and
 * abstention second — never the other way round.
 */
describe("ask relevance gate", () => {
  it("keeps every answerable question through the gate", async () => {
    const blocked: string[] = [];
    for (const entry of answerable) {
      if (entry.request.operation !== "ask") continue;
      const nodes = await candidatesFor(entry);
      if (!askRelevance(nodes, entry.request.question).supported) blocked.push(entry.id);
    }
    expect(blocked).toEqual([]);
  });

  it("abstains on questions the documents cannot support", async () => {
    const admitted: string[] = [];
    for (const entry of unanswerable) {
      if (entry.request.operation !== "ask") continue;
      const nodes = await candidatesFor(entry);
      if (askRelevance(nodes, entry.request.question).supported) admitted.push(entry.id);
    }
    const rate = percentage(unanswerable.length - admitted.length, unanswerable.length);
    console.info("ask gate", { unanswerable: unanswerable.length, abstained: rate, admitted });
    // Lexically similar wording can still reach the model, which then has to
    // abstain itself; the gate must catch the clearly unsupported majority.
    expect(rate).toBeGreaterThanOrEqual(80);
  });

  it("judges small documents on relevance, not on size", () => {
    const invoice = smallDocument("invoice", [
      "2026-03-15 청구서",
      "서울 운임 158,000원",
      "부산 운임 90,000원",
    ]);
    const nodes = buildEvidenceNodes([invoice]);
    expect(nodes.length).toBeLessThan(10);

    // Answerable: value, date and money questions all clear the gate.
    expect(askRelevance(nodes, "서울 운임은 얼마인가요?").supported).toBe(true);
    expect(askRelevance(nodes, "청구서 날짜는 언제인가요?").supported).toBe(true);
    expect(askRelevance(nodes, "부산 운임 금액은 얼마인가요?").supported).toBe(true);

    // Unanswerable: a short document is not an answer to everything.
    expect(askRelevance(nodes, "광주 운임은 얼마인가요?").supported).toBe(false);
    expect(askRelevance(nodes, "담당자 이메일 주소는 무엇인가요?").supported).toBe(false);
  });

  it("keeps a lookalike document for the model to refuse, not for retrieval to hide", () => {
    const lookalike = smallDocument("lookalike", [
      "운임 정책 안내",
      "운임은 지역별로 다르게 책정됩니다.",
      "자세한 금액은 별도 표를 참고하세요.",
    ]);
    const nodes = buildEvidenceNodes([lookalike]);
    // Real wording overlap: the gate stays conservative and lets it through,
    // because rejecting it would also reject legitimate paraphrases.
    expect(askRelevance(nodes, "제주 운임 금액은 얼마인가요?").supported).toBe(true);
    // A value the document never mentions carries no shared terms at all.
    expect(askRelevance(nodes, "서울 운임 158,000원이 맞나요?").supported).toBe(true);
    expect(askRelevance(nodes, "창고 보관료 단가는 얼마인가요?").supported).toBe(false);
  });

  it("matches Korean nouns carrying particles", () => {
    const report = smallDocument("report", [
      "3분기 매출은 158,000원입니다.",
      "운영 비용은 52,000원입니다.",
    ]);
    const nodes = buildEvidenceNodes([report]);
    expect(askRelevance(nodes, "매출이 얼마인가요?").supported).toBe(true);
    expect(askRelevance(nodes, "운영 비용을 알려주세요").supported).toBe(true);
    expect(askRelevance(nodes, "인건비는 얼마인가요?").supported).toBe(false);
  });
});
