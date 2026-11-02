import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchAdoptionCandidate, ResearchAdoptionVerdict } from "@/lib/research-relevance";
import { verifyResearchAdoption } from "@/server/groq";
import captured from "./fixtures/research-live-eight-adoption.json";

type CapturedCase = { category: string; query: string; issues: Array<{ label: string; query: string }>; candidates: ResearchAdoptionCandidate[] };
const records = captured.results as CapturedCase[];
const context = { requestId: "actual-eight-adoption-regression" };

beforeEach(() => {
  vi.stubEnv("GROQ_API_KEY", "corpus-test-key");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// Explicit semantic-response fixtures: these are not keyword-derived approvals.
// The actual original texts and prior false positives are retained in the JSON.
const decisions: Record<string, { source: string; role: "direct" | "supporting"; quote: string; reason: string }> = {
  임금: { source: "임금채권보장법 제12조", role: "supporting",
    quote: "① 임금등을 지급받지 못한 근로자는 다음 각 호의 어느 하나에 해당하는 경우 고용노동부장관에게 체불 임금등ㆍ사업주 확인서의 발급을 신청할 수 있다.",
    reason: "퇴사자의 체불임금 확인서 발급을 위한 보충 절차이며 임금 지급의 핵심 의무를 정하는 규정은 아니므로 추가 확인이 필요합니다." },
  식품위생: { source: "600527", role: "direct",
    quote: "영업장 면적 변경에 관한 신고의무가 이행되지 않은 영업을 양수한 자가 그 신고의무를 이행하지 않은 채 영업을 계속하는 경우, 시정명령 또는 영업정지 등 제재처분의 대상이 되는지 여부(적극)",
    reason: "일반적인 영업정지 요건을 묻는 질문에 식품영업의 변경신고 미이행이 제재처분 대상이 되는 규율을 직접 설명합니다." },
  계약: { source: "231741", role: "supporting",
    quote: "도급인이 수급인의 채무불이행을 이유로 도급계약 해제의 의사표시를 하였으나 실제로는 채무불이행의 요건을 갖추지 못한 것으로 밝혀진 경우, 당사자 사이에 분쟁이 있었다는 사정만으로 위 의사표시에 민법 제673조에 따른 임의해제의 의사가 포함되어 있다고 볼 수 있는지 여부(소극)",
    reason: "거래처 계약이 도급인지와 해제 의사표시를 했는지는 미확정이므로 조건부 보충자료이며 일반 거래처의 불이행을 확정하지 않습니다." },
  행정처분: { source: "316390", role: "direct",
    quote: "행정청이 법률에 근거하여 행정처분을 한 후 헌법재판소가 그 법률을 위헌으로 결정하였다면 그 행정처분은 법률의 근거가 없이 행하여져 하자가 있다고 할 것이나 객관적으로 명백한 것이라고 할 수 없으므로 특별한 사정이 없는한 이러한 하자는 행정처분의 취소사유에 해당할 뿐 당연무효 사유는 아님",
    reason: "일반적인 행정처분 취소사유를 묻는 질문에 근거 법률의 위헌결정이 취소사유와 무효사유 중 어디에 속하는지 직접 설명합니다." },
};

describe("captured eight-category originals versus final batch decisions", () => {
  it.each(records)("preserves actual $category candidates without lexical auto-adoption", async (record) => {
    const decision = decisions[record.category];
    const selected = decision ? record.candidates.find((candidate) =>
      candidate.precedentId === decision.source || `${candidate.law} ${candidate.jo}` === decision.source) : undefined;
    if (decision) expect(selected).toBeDefined();
    const selections: ResearchAdoptionVerdict[] = selected && decision ? [{ issueIndex: 0, candidateId: selected.id,
      role: decision.role, quote: decision.quote, reason: decision.reason }] : [];
    const fetcher = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: JSON.stringify({ selections }) } }] }));
    vi.stubGlobal("fetch", fetcher);
    const result = await verifyResearchAdoption(record.query, record.issues, record.candidates, context);
    expect(result).toEqual(selections);
    if (record.candidates.length && record.issues.length) expect(fetcher).toHaveBeenCalledOnce();
    else expect(fetcher).not.toHaveBeenCalled();
    const adopted = result.map((selection) => record.candidates.find((candidate) => candidate.id === selection.candidateId));
    expect(adopted.some((candidate) => candidate?.precedentId === "232017" || candidate?.precedentId === "613509"
      || candidate?.precedentId === "240951" || candidate?.law === "선원법"
      || candidate?.law === "남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률")).toBe(false);
  });
});
