import { describe, expect, it } from "vitest";
import { followUpContext, followUpDiagnosisDescription, followUpResponse, upsertFollowUpResponse } from "@/lib/ax/follow-up";
import { axFollowUpResponseSchema } from "@/lib/ax/schema";
import type { AxFollowUpResponse } from "@/lib/ax/types";

const record = (id: string, question: string, answer = ""): AxFollowUpResponse => ({ id, question, answer, attachments: [], updatedAt: "2026-11-02T00:00:00.000Z" });
describe("question-owned answers and file references", () => {
  it("keeps exact question connections when order changes and never guesses a reworded question", () => {
    const first = record("a", "현재 양식은 무엇인가요?", "주간 양식");
    const second = record("b", "승인자는 누구인가요?", "담당자");
    const task = { followUpResponses: [second, first] };
    expect(followUpResponse(task, first.question)).toEqual(first);
    expect(followUpResponse(task, "어떤 양식을 사용하나요?")).toBeUndefined();
    expect(upsertFollowUpResponse(task.followUpResponses, { ...first, answer: "변경된 양식" })).toEqual([second, { ...first, answer: "변경된 양식" }]);
    expect(() => upsertFollowUpResponse([first], { ...first, question: second.question })).toThrow("질문 연결");
  });
  it("does not make file-only attachment metadata into a confirmed answer or remote path", () => {
    const fileOnly = { ...record("a", "계산식과 출력 컬럼을 확인해 주세요"), attachments: [{ name: "양식.xlsx", type: "", size: 20, lastModified: 0, fingerprint: "a".repeat(64) }] };
    expect(followUpDiagnosisDescription("현재 가격 취합 업무", [fileOnly])).toBe("현재 가격 취합 업무");
    expect(followUpContext([fileOnly])).toContain("원본을 별도로 제공해야 합니다");
    expect(followUpContext([fileOnly])).toContain(fileOnly.question);
    expect(followUpContext([fileOnly])).not.toContain("https://");
  });
  it("preserves saved answers beyond the latest question list without rewriting registration", () => {
    const description = "현재 업무 등록 내용";
    const records = [record("a", "시작 방식?", "담당자가 직접 시작"), record("b", "누락 대응?", "직접 확인")];
    expect(followUpDiagnosisDescription(description, records)).toBe(`${description}\n추가 확인:\n시작 방식?: 담당자가 직접 시작\n누락 대응?: 직접 확인`);
    expect(description).toBe("현재 업무 등록 내용");
    expect(() => followUpDiagnosisDescription("가".repeat(2999), records)).toThrow("3,000자");
  });
  it("rejects duplicate fingerprint references rather than counting the same file twice", () => {
    const meta = { name: "양식.csv", type: "text/csv", size: 20, lastModified: 0, fingerprint: "b".repeat(64) };
    expect(axFollowUpResponseSchema.safeParse({ ...record("a", "입력 양식?"), attachments: [meta, meta] }).success).toBe(false);
  });
});
