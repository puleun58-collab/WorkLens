import { describe, expect, it } from "vitest";
import { parseEvalArgs } from "../scripts/supplement-eval-args";

describe("보완 eval command line", () => {
  it("reads the documented options", () => {
    expect(parseEvalArgs(["--set", "development", "--repeat", "3", "--budget", "600", "--plan"])).toMatchObject({
      set: "development", repeat: 3, budgetSeconds: 600, planOnly: true, offline: false, endpoint: "", model: "openai/gpt-oss-120b",
    });
    expect(parseEvalArgs([])).toMatchObject({ set: "fixed", repeat: 1, budgetSeconds: 1200 });
  });

  it("stops on an unknown option instead of evaluating something else", () => {
    expect(() => parseEvalArgs(["--sets", "holdout"])).toThrow("지원하지 않는 옵션: --sets");
    expect(() => parseEvalArgs(["holdout"])).toThrow("알 수 없는 인자");
  });

  it("rejects missing values and out-of-range settings", () => {
    expect(() => parseEvalArgs(["--set"])).toThrow("--set에 값이 필요합니다.");
    expect(() => parseEvalArgs(["--set", "--offline"])).toThrow("--set에 값이 필요합니다.");
    expect(() => parseEvalArgs(["--set", "all"])).toThrow("--set은");
    expect(() => parseEvalArgs(["--repeat", "0"])).toThrow("--repeat");
    expect(() => parseEvalArgs(["--repeat", "2.5"])).toThrow("--repeat");
    expect(() => parseEvalArgs(["--budget", "-1"])).toThrow("--budget");
  });

  it("refuses combinations that would mislabel a run", () => {
    expect(() => parseEvalArgs(["--offline", "--endpoint", "https://example.test"])).toThrow("함께 쓸 수 없습니다");
    expect(() => parseEvalArgs(["--set", "holdout", "--save-baseline"])).toThrow("--set fixed에서만");
  });
});

describe("보완 eval key policy", () => {
  it("needs an explicit flag to use the production key", () => {
    expect(parseEvalArgs([]).sharedKey).toBe(false);
    expect(parseEvalArgs(["--shared-key"]).sharedKey).toBe(true);
  });
});
