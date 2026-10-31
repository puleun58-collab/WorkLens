import { describe, expect, it } from "vitest";
import { LAW_RESEARCH_TASKS, LAW_RESEARCH_USER_TASKS, isUserVisibleResearchTask } from "@/lib/law-research";

describe("research menu visibility", () => {
  it("hides procedure_detail from the user menu but keeps the API task intact", () => {
    expect(LAW_RESEARCH_USER_TASKS.map((task) => task.value)).toEqual([
      "full_research", "law_system", "action_basis", "dispute_prep",
      "amendment_track", "ordinance_compare", "document_review",
    ]);
    expect(LAW_RESEARCH_TASKS.map((task) => task.value)).toContain("procedure_detail");
    expect(LAW_RESEARCH_TASKS.find((task) => task.value === "procedure_detail")?.label).toBe("절차·서식");
  });

  it("distinguishes user-visible tasks from hidden and unknown tasks", () => {
    expect(isUserVisibleResearchTask("procedure_detail")).toBe(false);
    expect(isUserVisibleResearchTask("law_system")).toBe(true);
    expect(isUserVisibleResearchTask("bogus")).toBe(false);
    expect(isUserVisibleResearchTask(undefined)).toBe(false);
  });
});
