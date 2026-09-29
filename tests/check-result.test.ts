import { describe, expect, it } from "vitest";
import { checkDocument, createDictionary, MAX_FINDINGS, mergeSemanticFindings, semanticFindings } from "@/lib/check";
import { resummarize } from "@/lib/check/merge";
import type { GroundedClaim } from "@/domain/ai";
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
    ], createDictionary());

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

  it("classifies an English typo from sentence review exactly like the rule finding and reports it once", () => {
    const document = paragraphDocument([
      "We should re-check teh assumptions before send the final file.",
      "Please make sure every attachement are included.",
      "The KPI dashboard show a incorrect forecast value.",
      "Contact the WorkLnes team or the Recievr desk.",
    ]);
    const claim = (text: string, block: number, confidence: "high" | "medium" | "low" = "high"): GroundedClaim => ({
      id: `claim:${text}`,
      kind: "inference",
      text: `추론: ${text}`,
      confidence,
      evidence: [{ source: document.blocks[block].source, support: "context" }],
    });
    const deterministic = checkDocument(document, { userTerms: ["Recievr"] });
    const semantic = semanticFindings([
      claim("‘teh’는 ‘the’로 표기해야 합니다.", 0),
      claim("‘attachement’는 ‘attachment’로 표기해야 합니다.", 1),
      claim("‘show’는 ‘shows’로 표기해야 합니다.", 2),
      claim("‘WorkLnes’는 ‘WorkLens’로 표기해야 합니다.", 3),
      claim("‘Recievr’는 ‘Receiver’로 표기해야 합니다.", 3),
    ], createDictionary(["Recievr"]));
    const merged = mergeSemanticFindings(deterministic.findings, semantic);

    const spelling = merged.filter((finding) => finding.code === "english-spelling");
    expect(spelling.map((finding) => [finding.normalizedToken, finding.severity])).toEqual([
      ["teh", "warning"],
      ["attachement", "warning"],
      ["WorkLnes", "suggestion"],
    ]);
    const rule = spelling[0];
    const reviewed = spelling[1];
    expect(reviewed).toMatchObject({
      ruleId: "writing/english/spelling:attachement",
      category: "spelling",
      confidence: "high",
      issue: rule.issue,
      message: "\"attachement\"의 철자를 확인하세요.",
      recommendation: "\"attachment\"(으)로 교정하세요.",
      suggestedText: "Please make sure every attachment are included.",
      source: document.blocks[1].source,
      dictionaryEligible: true,
    });
    expect(spelling[2]).toMatchObject({ message: "\"WorkLnes\" 표기가 맞는지 확인하세요.", recommendation: "\"WorkLens\" 표기인지 확인하세요." });
    expect(spelling[2]).not.toHaveProperty("suggestedText");
    // A word-form edit stays a sentence-review suggestion; no finding shows how grounding labelled the claim.
    expect(merged.find((finding) => finding.code === "semantic-writing-suggestion")).toMatchObject({
      severity: "suggestion",
      message: "‘show’는 ‘shows’로 표기해야 합니다.",
    });
    expect(merged.some((finding) => finding.message.includes("추론"))).toBe(false);

    const summary = resummarize(deterministic.summary, deterministic.findings, merged);
    const shown = { critical: 0, warning: 0, suggestion: 0 };
    for (const finding of merged) shown[finding.severity] += 1;
    expect(summary.bySeverity).toEqual(shown);
    expect(summary.totalFound).toBe(merged.length);
    expect(sum(summary.byGroup)).toBe(merged.length);
    expect(sum(summary.byConfidence)).toBe(merged.length);
  });

  it("keeps a sentence-review correction uncertain when it offers several candidates or low confidence", () => {
    const document = paragraphDocument(["The quaterly report is late."]);
    const evidence = [{ source: document.blocks[0].source, support: "context" as const }] as [{ source: SourceRef; support: "context" }];
    const [several, unsure] = semanticFindings([
      { id: "a", kind: "inference", text: "‘quaterly’는 ‘quarterly’ 또는 ‘quartely’로 표기해야 합니다.", confidence: "high", evidence },
      { id: "b", kind: "inference", text: "‘quaterly’는 ‘quarterly’로 표기해야 합니다.", confidence: "low", evidence },
    ], createDictionary());
    expect(several).toMatchObject({ code: "english-spelling", severity: "suggestion", message: "\"quaterly\" 표기가 맞는지 확인하세요." });
    expect(unsure).toMatchObject({ code: "english-spelling", severity: "suggestion", confidence: "low" });
  });
});
