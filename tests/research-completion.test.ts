import { beforeEach, describe, expect, it, vi } from "vitest";
import { runLegalResearch } from "@/server/law-research-mcp";
import { callLawTool } from "@/server/law-mcp";
import { enrichResearch } from "@/server/research-enrichment";
import { retrieveResearchFollowup } from "@/server/research-followup";
import { retrieveAnnexes } from "@/server/research-annex";

vi.mock("@/server/law-mcp", async (original) => ({ ...await original<typeof import("@/server/law-mcp")>(), callLawTool: vi.fn() }));
vi.mock("@/server/research-enrichment", async (original) => ({ ...await original<typeof import("@/server/research-enrichment")>(), enrichResearch: vi.fn() }));
vi.mock("@/server/research-followup", async (original) => ({ ...await original<typeof import("@/server/research-followup")>(), retrieveResearchFollowup: vi.fn() }));
vi.mock("@/server/research-annex", async (original) => ({ ...await original<typeof import("@/server/research-annex")>(), retrieveAnnexes: vi.fn() }));
const basis = `═══ 처분 근거 확인: 식품위생법 ═══\n▶ 법령 체계\n[법률] 식품위생법 제75조 (영업정지)\n영업정지 처분을 할 수 있다. 영업정지 요건은 해당 기준에 따른다.`;
const system = `═══ 법체계 확인: 개인정보 보호법 ═══\n▶ 3단 비교 (법률·시행령·시행규칙)\n[시행령] 개인정보 보호법 시행령 제45조 (행사 방법)\n법 제38조에 따라 청구한다.\n[시행규칙] 개인정보 보호법 시행규칙 제8조 (행사 방법)\n법 제38조에 따른 청구서이다.`;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(enrichResearch).mockResolvedValue({});
  vi.mocked(retrieveAnnexes).mockResolvedValue([]);
  vi.mocked(retrieveResearchFollowup).mockResolvedValue({ articles: [], report: { status: "partial", attempted: 3, failed: 0, missing: 1, limited: true } });
});
describe("server core completion versus additional retrieval", () => {
  it.each(["law_system", "action_basis"] as const)("keeps %s complete when all required checks passed and only extra reads are capped", async (task) => {
    vi.mocked(callLawTool).mockResolvedValue({ text: task === "law_system" ? system : basis, isError: false });
    const result = await runLegalResearch({ task, query: task === "law_system" ? "개인정보 보호법 제38조 위임관계" : "식품위생법 영업정지 근거와 요건" }, { requestId: "completion-unit" });
    expect(result).toMatchObject({ found: true, [task === "law_system" ? "lawSystem" : "actionBasis"]: { status: "matched" }, followup: { limited: true, missing: 1 } });
  });
  it("keeps a missing application requirement partial despite an available basis", async () => {
    vi.mocked(callLawTool).mockResolvedValue({ text: basis.replace(" 영업정지 요건은 해당 기준에 따른다.", ""), isError: false });
    expect(await runLegalResearch({ task: "action_basis", query: "식품위생법 영업정지 근거와 요건" }, { requestId: "completion-unit" })).toMatchObject({ actionBasis: { status: "partial", items: [{ status: "found" }, { status: "viewed" }] } });
  });
  it.each(["law_system", "action_basis"] as const)("preserves confirmed %s checks even when extra candidate reads fail", async (task) => {
    vi.mocked(callLawTool).mockResolvedValue({ text: task === "law_system" ? system : basis, isError: false });
    vi.mocked(retrieveResearchFollowup).mockResolvedValue({ articles: [], report: { status: "failed", attempted: 2, failed: 2, missing: 2, limited: false } });
    const result = await runLegalResearch({ task, query: task === "law_system" ? "개인정보 보호법 제38조 위임관계" : "식품위생법 영업정지 근거와 요건" }, { requestId: "completion-unit" });
    expect(result).toMatchObject({ [task === "law_system" ? "lawSystem" : "actionBasis"]: { status: "matched" }, followup: { status: "failed", failed: 2 } });
  });
  it("does not upgrade an unresolved delegation when additional reads are incomplete", async () => {
    vi.mocked(callLawTool).mockResolvedValue({ text: system.replace("법 제38조에 따른 청구서이다.", "법 제39조에 따른 청구서이다."), isError: false });
    expect(await runLegalResearch({ task: "law_system", query: "개인정보 보호법 제38조 위임관계" }, { requestId: "completion-unit" })).toMatchObject({ lawSystem: { status: "partial", items: [{ status: "found" }, { status: "found" }, { status: "viewed" }] } });
  });
  it("retains conservative status for an unverified original, and preserves the actual failure", async () => {
    vi.mocked(callLawTool).mockResolvedValue({ text: basis, isError: false });
    vi.mocked(retrieveAnnexes).mockResolvedValue([{ law: "식품위생법", label: "별표 1", citation: "별표 1", sourceArticle: "제75조", status: "failed" }]);
    expect(await runLegalResearch({ task: "action_basis", query: "영업정지 근거와 요건" }, { requestId: "completion-unit" })).toMatchObject({ actionBasis: { status: "partial" }, annexes: [{ status: "failed" }] });
  });
  it("does not erase confirmed checks or primary-section failures", async () => {
    vi.mocked(callLawTool).mockResolvedValue({ text: `${basis}\n▶ 조문 조회 [NOT_FOUND / FAILED]\n사유: [FAILED] 원문 조회 실패`, isError: false });
    expect(await runLegalResearch({ task: "action_basis", query: "영업정지 근거와 요건" }, { requestId: "completion-unit" })).toMatchObject({ actionBasis: { status: "partial" } });
  });
});
