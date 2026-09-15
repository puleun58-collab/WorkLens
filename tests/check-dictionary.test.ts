import { describe, expect, it } from "vitest";
import { checkDocument, createDictionary } from "@/lib/check";
import type { NormalizedDocument, SourceRef } from "@/domain/document";

function paragraphDocument(texts: readonly string[]): NormalizedDocument {
  return {
    id: "document:dictionary-check",
    fileId: "dictionary-check",
    kind: "docx",
    metadata: { fileName: "dictionary-check.docx" },
    warnings: [],
    blocks: texts.map((text, index) => {
      const source: SourceRef = {
        fileId: "dictionary-check",
        nodeId: `paragraph:${index + 1}`,
        label: `문단 ${index + 1}`,
        locator: { kind: "docx", part: "body", block: index + 1 },
        quote: text,
      };
      return { type: "paragraph" as const, id: source.nodeId, text, source };
    }),
  };
}

describe("term dictionary", () => {
  it("protects every company term case-insensitively and identifies its scope", () => {
    const dictionary = createDictionary();

    for (const term of dictionary.companyTerms()) {
      expect(dictionary.has(term.toLocaleLowerCase())).toBe(true);
      expect(dictionary.scopeOf(term.toLocaleUpperCase())).toBe("company");
    }
  });

  it("protects personal terms without leaking them into later dictionaries", () => {
    const personal = createDictionary(["foo", "WorkLens"]);
    const fresh = createDictionary();

    expect(personal.has("FOO")).toBe(true);
    expect(personal.scopeOf("foo")).toBe("user");
    expect(personal.scopeOf("worklens")).toBe("company");
    expect(fresh.has("foo")).toBe(false);
    expect(fresh.scopeOf("worklens")).toBe("company");
  });

  it("uses the canonical company spelling when casing drifts", () => {
    const result = checkDocument(paragraphDocument(["WorkLens is ready.", "worklens is ready."]));

    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "terminology-inconsistency",
      ruleId: "consistency/company-term-casing:WorkLens",
      suggestedText: "WorkLens",
    }));
  });

  it("protects the individual words in multi-word company terms", () => {
    const dictionary = createDictionary();

    expect(dictionary.has("ISO 27001")).toBe(true);
    expect(dictionary.has("ISO")).toBe(true);
    expect(dictionary.has("27001")).toBe(true);
    expect(dictionary.scopeOf("iso")).toBe("company");
  });

  it("keeps a user term local while unrelated findings remain actionable", () => {
    const document = paragraphDocument(["Winstal", "winstal", "TODO: complete the review."]);
    const withoutUserTerms = checkDocument(document);
    const withUserTerms = checkDocument(document, { userTerms: ["Winstal"] });

    expect(withoutUserTerms.findings).toContainEqual(expect.objectContaining({
      code: "terminology-inconsistency",
      ruleId: "consistency/casing:winstal",
      normalizedToken: "Winstal",
    }));
    expect(withUserTerms.findings.some((finding) => finding.ruleId === "consistency/casing:winstal")).toBe(false);
    expect(withUserTerms.findings).toContainEqual(expect.objectContaining({
      code: "placeholder-text",
      source: expect.objectContaining({ nodeId: "paragraph:3" }),
    }));
  });
});
