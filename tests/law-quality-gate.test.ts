/**
 * Quality Gate discovery (law-accuracy-refine, area C).
 *
 * The gate used to run a fixed 15-file list while the repository held many
 * more law-domain tests. Discovery must include every law test, exclude
 * unrelated suites, and pick up a newly added law test without a list edit.
 * The temporary-file probe below removes its file in a finally block; it
 * is created after vitest's collection phase, so it never joins the
 * running suite, and it is a passing test even if cleanup is interrupted.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { discoverLawTests } from "../scripts/law-quality-gate";

describe("law quality gate discovery", () => {
  it("C1: covers the previously missed law tests, not just the old fixed list", () => {
    const found = discoverLawTests();
    for (const file of [
      "tests/law-api.test.ts",
      "tests/citation-claim.test.ts",
      "tests/citation-evidence.test.ts",
      "tests/citation-linebreak.test.ts",
      "tests/decision-followup-trace.test.ts",
      "tests/law-reliability-final.test.ts",
      "tests/law-title-dedup.test.ts",
      "tests/law-v6.test.ts",
      "tests/law-supplement-refine.test.ts",
      "tests/research-relevance.test.ts",
      "tests/ordinance-compare.test.ts",
    ]) {
      expect(found).toContain(file);
    }
    expect(found.length).toBeGreaterThan(15);
  });

  it("C1: does not pull unrelated suites into the law gate", () => {
    const found = discoverLawTests();
    for (const file of found) {
      expect(file).toMatch(/^tests\/(law|citation|research|decision|ordinance)-.*\.test\.ts$/);
    }
    expect(found).not.toContain("tests/ax-guide.test.ts");
    expect(found).not.toContain("tests/document-review-live-gate.test.ts");
  });

  it("C2: a newly added law test file is discovered without a list edit", () => {
    const probe = "tests/law-zz-gate-probe.test.ts";
    try {
      expect(discoverLawTests()).not.toContain(probe);
      writeFileSync(probe, "import { describe, expect, it } from \"vitest\";\n\ndescribe(\"gate probe\", () => {\n  it(\"passes\", () => { expect(1).toBe(1); });\n});\n");
      expect(discoverLawTests()).toContain(probe);
    } finally {
      if (existsSync(probe)) rmSync(probe);
    }
    expect(discoverLawTests()).not.toContain(probe);
  });

  it("C2: an empty or missing tests directory discovers nothing (gate fails closed)", () => {
    expect(discoverLawTests("tests-does-not-exist")).toEqual([]);
  });
});
