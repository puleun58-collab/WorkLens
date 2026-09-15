import { describe, expect, it } from "vitest";
import { normalizeTerm } from "@/server/company-terms";
import { checkDocument, createDictionary } from "@/lib/check";
import type { NormalizedDocument, SourceRef } from "@/domain/document";

function paragraphDocument(texts: readonly string[]): NormalizedDocument {
  return {
    id: "document:terms",
    fileId: "terms",
    kind: "docx",
    metadata: { fileName: "용어.docx" },
    warnings: [],
    blocks: texts.map((text, index) => {
      const source: SourceRef = {
        fileId: "terms",
        nodeId: `paragraph:${index + 1}`,
        label: `문단 ${index + 1}`,
        quote: text,
      };
      return { type: "paragraph" as const, id: source.nodeId, text, source };
    }),
  };
}

describe("central company dictionary", () => {
  it("collapses casing, width and spacing when normalizing a term", () => {
    expect(normalizeTerm("  WorkLens ")).toBe("worklens");
    expect(normalizeTerm("WORKLENS")).toBe("worklens");
    expect(normalizeTerm("ＷｏｒｋLens")).toBe("worklens");
    expect(normalizeTerm("ISO   27001")).toBe("iso 27001");
  });

  it("replaces the seed list when company terms are supplied at runtime", () => {
    const runtime = createDictionary([], ["Winstal"]);
    expect(runtime.has("Winstal")).toBe(true);
    expect(runtime.scopeOf("winstal")).toBe("company");
    // A seed-only term is no longer protected once the central list takes over.
    expect(runtime.has("CFMS")).toBe(false);
  });

  it("suppresses casing findings for central terms but still reports duplication", () => {
    const document = paragraphDocument(["Winstal", "winstal", "Winstal Winstal 입니다."]);
    const withoutCentral = checkDocument(document);
    const withCentral = checkDocument(document, { companyTerms: ["Winstal"] });

    expect(withoutCentral.findings.some((finding) => finding.ruleId === "consistency/casing:winstal")).toBe(true);
    expect(withCentral.findings.some((finding) => finding.ruleId === "consistency/casing:winstal")).toBe(false);
    expect(withCentral.findings.some((finding) => finding.code === "repeated-word")).toBe(true);
  });
});
