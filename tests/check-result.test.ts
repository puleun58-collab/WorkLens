import { describe, expect, it } from "vitest";
import { checkDocument, MAX_FINDINGS, mergeSemanticFindings, semanticFindings } from "@/lib/check";
import type { NormalizedDocument, SourceRef } from "@/domain/document";

function paragraphDocument(texts: readonly string[]): NormalizedDocument {
  return {
    id: "document:result-check",
    fileId: "result-check",
    kind: "docx",
    metadata: { fileName: "result-check.docx" },
    warnings: [],
    blocks: texts.map((text, index) => {
      const source: SourceRef = {
        fileId: "result-check",
        nodeId: `paragraph:${index + 1}`,
        label: `문단 ${index + 1}`,
        locator: { kind: "docx", part: "body", block: index + 1 },
        quote: text,
      };
      return { type: "paragraph" as const, id: source.nodeId, text, source };
    }),
  };
}

function sum(values: Record<string, number>): number {
  return Object.values(values).reduce((total, value) => total + value, 0);
}

describe("check result assembly", () => {
  it("summarizes all findings before applying the display cap", () => {
    const large = checkDocument(paragraphDocument(
      Array.from({ length: 350 }, (_, index) => `TODO ${index}: API Key: sk_live_1234567890abcdef${index}`),
    ));
    const small = checkDocument(paragraphDocument(["TODO: complete the review."]));

    expect(large.summary.totalFound).toBeGreaterThan(MAX_FINDINGS);
    expect(large.summary.returned).toBe(MAX_FINDINGS);
    expect(large.findings).toHaveLength(MAX_FINDINGS);
    expect(large.summary.truncated).toBe(true);
    expect(small.summary.truncated).toBe(false);
    expect(small.summary.totalFound).toBe(small.summary.returned);
  });

  it("counts every found severity, group, and confidence in the summary", () => {
    const result = checkDocument(paragraphDocument(
      Array.from({ length: 350 }, (_, index) => `TODO ${index}: API Key: sk_live_1234567890abcdef${index}`),
    ));

    expect(sum(result.summary.bySeverity)).toBe(result.summary.totalFound);
    expect(sum(result.summary.byGroup)).toBe(result.summary.totalFound);
    expect(sum(result.summary.byConfidence)).toBe(result.summary.totalFound);
  });

  it("prioritizes severity and confidence, then retains document order for ties", () => {
    const result = checkDocument(paragraphDocument([
      "API Key: sk_live_1234567890abcdef",
      "API Key: sk_live_abcdefghijklmnop",
      "TODO: complete the review.",
    ]));
    const severityRank = { critical: 3, warning: 2, suggestion: 1 } as const;
    const confidenceRank = { high: 3, medium: 2, low: 1 } as const;

    for (let index = 1; index < result.findings.length; index += 1) {
      const previous = result.findings[index - 1];
      const current = result.findings[index];
      expect(severityRank[previous.severity]).toBeGreaterThanOrEqual(severityRank[current.severity]);
      if (previous.severity === current.severity) {
        expect(confidenceRank[previous.confidence]).toBeGreaterThanOrEqual(confidenceRank[current.confidence]);
      }
    }
    expect(result.findings.filter((finding) => finding.code === "privacy-secret").map((finding) => finding.source.nodeId)).toEqual(["paragraph:1", "paragraph:2"]);
  });

  it("honors a caller-provided finding limit", () => {
    const result = checkDocument(paragraphDocument(
      Array.from({ length: 10 }, (_, index) => `TODO ${index}`),
    ), { limit: 5 });

    expect(result.findings).toHaveLength(5);
    expect(result.summary.returned).toBe(5);
    expect(result.summary.truncated).toBe(true);
  });

  it("maps grounded semantic claims and merges only non-colliding suggestions", () => {
    const document = paragraphDocument([
      "This sentence is deliberately long enough to require an editorial review because it keeps adding clauses and qualifiers well beyond the normal concise limit for a submission document.",
      "A separate source remains available for a semantic suggestion.",
    ]);
    const deterministic = checkDocument(document).findings.find((finding) => finding.code === "long-sentence");
    const [colliding, nonColliding] = semanticFindings([
      {
        id: "claim:1",
        kind: "fact",
        proposition: { subject: "sentence", predicate: "contains", object: "wordiness", polarity: "affirmed" },
        text: "Shorten the sentence.",
        evidence: [{ source: document.blocks[0].source, support: "direct" }],
      },
      {
        id: "claim:2",
        kind: "inference",
        text: "Clarify the second sentence.",
        evidence: [{ source: document.blocks[1].source, support: "context" }],
      },
    ]);

    expect(colliding).toMatchObject({
      code: "semantic-writing-suggestion",
      severity: "suggestion",
      confidence: "low",
    });
    expect(deterministic).toBeDefined();
    const merged = mergeSemanticFindings([deterministic!], [colliding, nonColliding]);
    expect(merged).toContain(deterministic);
    expect(merged).not.toContain(colliding);
    expect(merged).toContain(nonColliding);
  });
});
