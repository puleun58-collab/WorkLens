import { describe, expect, it } from "vitest";
import { selectStressCases } from "./bench/large-documents";

/**
 * The stress benchmark holds gigabytes while it builds a single fixture, so
 * the CLI itself is a safety device: nothing may run unless it was asked for
 * by name. These tests pin that contract; they never run a benchmark.
 */
describe("bench:stress CLI", () => {
  it("runs nothing and explains itself when no case is named", () => {
    const selection = selectStressCases([]);
    expect(selection.cases).toBeUndefined();
    expect(selection.usage).toContain("--format");
    expect(selection.usage).toContain("--all");
  });

  it("selects exactly one case for one format and one size", () => {
    const selection = selectStressCases(["--stress", "--format=xlsx", "--size=50"]);
    expect(selection.cases?.map((entry) => entry.label)).toEqual(["xlsx-50mib"]);
  });

  it("accepts the separated argument form", () => {
    const selection = selectStressCases(["--stress", "--format", "pdf", "--size", "100"]);
    expect(selection.cases?.map((entry) => entry.label)).toEqual(["pdf-100mib"]);
  });

  it("sweeps every format and size only behind --all", () => {
    const selection = selectStressCases(["--stress", "--all"]);
    expect(selection.cases).toHaveLength(15);
    expect(selection.cases?.[0].label).toBe("csv-50mib");
  });

  it("refuses an unknown format or size instead of guessing one", () => {
    expect(selectStressCases(["--stress", "--format=zip", "--size=50"]).usage).toContain("unknown --format");
    expect(selectStressCases(["--stress", "--format=csv", "--size=250"]).usage).toContain("unknown --size");
  });

  it("does not build a fixture while the case list is assembled", () => {
    const selection = selectStressCases(["--stress", "--format=csv", "--size=100"]);
    // `build` is still a closure: selecting a case must allocate nothing.
    expect(typeof selection.cases?.[0].build).toBe("function");
  });
});
