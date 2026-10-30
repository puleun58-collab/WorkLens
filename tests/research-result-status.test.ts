import { describe, expect, it } from "vitest";
import type { LawResearchData } from "@/lib/law-research";
import { researchConfirmationGap } from "@/lib/research-result-status";

const base = { found: true, task: "action_basis", text: "", markers: [] } satisfies LawResearchData;
describe("existing required confirmation gaps", () => {
  it.each([
    ["found", "viewed", "적용 요건 확인 필요"],
    ["none", "found", "처분 근거 확인 필요"],
    ["none", "viewed", "추가 확인 필요"],
  ] as const)("distinguishes independent action checks %s / %s", (basis, requirement, badge) => {
    const data: LawResearchData = { ...base, actionBasis: { status: "partial", items: [
      { label: "처분·허가 근거", status: basis }, { label: "적용 요건", status: requirement },
    ] } };
    const before = structuredClone(data);
    expect(researchConfirmationGap(data, "partial")?.badge).toBe(badge);
    expect(data).toEqual(before);
  });
  it("retains completion with only reference reads missing, and never overrides failure or document review", () => {
    const complete: LawResearchData = { ...base, actionBasis: { status: "matched", items: [{ label: "처분·허가 근거", status: "found" }, { label: "적용 요건", status: "found" }] }, followup: { status: "partial", attempted: 2, failed: 0, missing: 1, limited: true } };
    expect(researchConfirmationGap(complete, "matched")).toBeUndefined();
    expect(researchConfirmationGap({ ...complete, task: "document_review" }, "partial")).toBeUndefined();
    expect(researchConfirmationGap(complete, "failed")).toBeUndefined();
  });
  it("uses actual tier findings to name an unresolved delegation", () => {
    expect(researchConfirmationGap({ ...base, task: "law_system", lawSystem: { status: "partial", items: [{ label: "시행령", status: "found" }, { label: "시행규칙", status: "viewed" }] } }, "partial")).toMatchObject({ badge: "위임관계 확인 필요", text: expect.stringContaining("시행규칙") });
  });
  it("keeps a partial requirement lookup failure distinct from no evidence", () => {
    const data: LawResearchData = { ...base, task: "procedure_detail", procedure: {
      overall: "partial", incomplete: true, annexTruncated: false, annexOriginStage: "list-only", failedSections: 1, steps: [],
      requirements: [{ label: "수수료", kind: "cost", status: "failed", articles: [], annexCount: 0, annexOriginStage: "list-only", annexRelatedCandidates: [] }],
    } };
    expect(researchConfirmationGap(data, "partial")).toMatchObject({ text: expect.stringContaining("수수료의 자료 조회가 실패") });
    expect(researchConfirmationGap(data, "partial")?.text).toContain("조회 실패는 근거가 없다는 뜻이 아닙니다.");
    expect(data.procedure?.requirements[0].status).toBe("failed");
  });
  it("treats mandatory, conditional or directly requested form originals separately from reference originals", () => {
    const procedure: NonNullable<LawResearchData["procedure"]> = { overall: "partial", incomplete: true, annexTruncated: false, annexOriginStage: "list-only", failedSections: 0, steps: [], requirements: [{ label: "제출 서식", kind: "forms", status: "found", articles: [], annexCount: 1, annexOriginStage: "list-only", annexRelatedCandidates: [], classifiedForms: [{ title: "신청서", duty: "required", original: "missing", articles: [], direct: false }] }] };
    const data: LawResearchData = { ...base, task: "procedure_detail", procedure };
    expect(researchConfirmationGap(data, "partial")?.badge).toBe("서식 원문 확인 필요");
    procedure.requirements[0].classifiedForms![0].duty = "reference";
    expect(researchConfirmationGap(data, "partial")).toBeUndefined();
    procedure.requirements[0].classifiedForms![0].direct = true;
    expect(researchConfirmationGap(data, "partial")?.badge).toBe("서식 원문 확인 필요");
  });
});
