import { describe, expect, it } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import type { NormalizedDocument } from "@/domain/document";
import type { SupplementDraft } from "@/domain/supplement";
import { parseDocument } from "@/lib/parsers";
import { buildSupplementDraft } from "@/lib/supplement/engine";
import { finalizeSupplement } from "@/lib/supplement/finalize";
import { parseSupplementReview } from "@/lib/ai/supplement-prompt";
import { createPptxSlides, createUnicodePdf, type PdfLineSpec } from "./fixtures";

async function parse(fileName: string, bytes: Uint8Array): Promise<NormalizedDocument> {
  return parseDocument({ fileId: fileName, fileName, bytes });
}

async function deck(slides: string[][], name = "보고.pptx"): Promise<SupplementDraft> {
  return buildSupplementDraft([{ document: await parse(name, createPptxSlides(slides)), fileName: name }]);
}

const h = (text: string): PdfLineSpec => ({ text, size: 16 });
const p = (text: string): PdfLineSpec => ({ text });

/** Deterministic outcome only: the semantic re-check abstained. */
const titles = (draft: SupplementDraft) => finalizeSupplement(draft, new Map()).findings.map((finding) => finding.title);

describe("보완 — gap detection on PPTX/PDF", () => {
  it("flags a large cost increase whose cause is nowhere in the deck", async () => {
    const draft = await deck([
      ["3분기 비용 보고", "운영 현황을 공유합니다."],
      ["비용 현황", "3분기 물류비가 전분기 대비 18% 증가했습니다."],
      ["향후 계획", "운송사 단가 재협상을 11월까지 물류팀이 진행할 예정입니다."],
    ]);
    const result = finalizeSupplement(draft, new Map());
    const cause = result.findings.find((finding) => finding.check === "cause");
    expect(cause?.title).toBe("원인 설명 확인 필요");
    expect(cause?.severity).toBe("critical");
    expect(cause?.locations).toEqual(["2P"]);
    expect(cause?.message).toBe("물류비가 전분기 대비 18% 증가했다고 제시되어 있지만 현재 자료에서 주요 증가 원인 설명을 확인하지 못했습니다.");
    expect(cause?.question).toBe("왜 물류비가 18% 증가했습니까?");
    expect(result.findings.some((finding) => finding.check === "response" || finding.check === "owner" || finding.check === "schedule")).toBe(false);
  });

  it("accepts a cause and a response stated on other slides", async () => {
    const draft = await deck([
      ["3분기 비용 보고", "운영 현황을 공유합니다."],
      ["비용 현황", "3분기 물류비가 전분기 대비 18% 증가했습니다."],
      ["증가 배경", "유가 상승 및 운송거리 증가로 비용 확대"],
      ["향후 계획", "운송사 단가 재협상 예정 (물류팀, 11월)"],
    ]);
    expect(titles(draft)).toEqual([]);
    expect(draft.resolvedCount).toBeGreaterThan(0);
  });

  it("recognises a cause written without the word 원인", async () => {
    const draft = await deck([
      ["물류비 보고", "물류비가 전월 대비 18% 증가했습니다."],
      ["분석", "물동량 증가와 단가 상승이 주요 증가 요인입니다."],
    ]);
    expect(titles(draft)).not.toContain("원인 설명 확인 필요");
  });

  it("asks for a response to a problem with no follow-up anywhere", async () => {
    const draft = await deck([
      ["9월 이슈 보고", "주요 이슈를 공유합니다."],
      ["납기 이슈", "고객사 A 납기 지연 12건 발생"],
      ["기타", "10월 생산 계획은 전월과 동일합니다."],
    ]);
    const result = finalizeSupplement(draft, new Map());
    expect(result.files[0].docType).toBe("issue");
    const response = result.findings.find((finding) => finding.check === "response");
    expect(response?.title).toBe("대응 확인 필요");
    expect(response?.severity).toBe("critical");
    expect(response?.locations).toEqual(["2P"]);
    expect(result.findings.find((finding) => finding.check === "impact")?.title).toBe("영향 설명 확인 필요");
  });

  it("reports nothing for a complete issue report", async () => {
    const draft = await deck([
      ["9월 이슈 보고", "주요 이슈를 공유합니다."],
      ["납기 이슈", "고객사 A 납기 지연 12건 발생", "원인: 설비 고장으로 생산 라인 2일 중단", "영향: 고객 클레임 3건, 지체상금 1,200만원 예상"],
      ["대응 계획", "예비 설비 확보 및 정기 점검 강화", "담당: 생산팀 김OO 팀장", "완료 목표: 2026.10.31"],
    ]);
    expect(titles(draft)).toEqual([]);
  });

  it("does not demand response, owner or schedule from a normal KPI report", async () => {
    const draft = await deck([
      ["3분기 영업 실적 보고", "3분기 실적을 보고드립니다."],
      ["매출 실적", "매출 1,250억 원, 목표 1,200억 원 대비 104% 달성", "영업이익 전년 동기 대비 3% 증가"],
      ["고객 지표", "고객 만족도 88점 (목표 85점, 전년 84점)"],
      ["향후 전망", "4분기에도 목표 수준의 실적이 유지될 것으로 예상됩니다. 수주 잔고 1,800억 원 확보로 매출 기반이 안정적입니다."],
    ]);
    expect(finalizeSupplement(draft, new Map()).findings).toEqual([]);
  });

  it("asks for evidence behind an unsupported forecast", async () => {
    const draft = await deck([
      ["비용 현황 보고", "3분기 운송비 42억 원 집행"],
      ["결론", "향후 비용 부담은 제한적일 것으로 예상됩니다."],
    ]);
    const conclusion = finalizeSupplement(draft, new Map()).findings.find((finding) => finding.check === "conclusion");
    expect(conclusion?.title).toBe("결론 근거 확인 필요");
    expect(conclusion?.message).toBe("현재 자료에서 이 결론을 직접 뒷받침하는 근거를 충분히 확인하지 못했습니다.");
    expect(conclusion?.locations).toEqual(["2P"]);
  });

  it("merges the same unexplained increase repeated on several slides", async () => {
    const draft = await deck([
      ["비용 보고", "3분기 비용 현황"],
      ["요약", "물류비 전월 대비 18% 증가"],
      ["세부 1", "물류비가 전월 대비 18% 증가했습니다."],
      ["세부 2", "운송비는 전월 대비 12% 증가했습니다."],
    ]);
    const causes = finalizeSupplement(draft, new Map()).findings.filter((finding) => finding.check === "cause");
    expect(causes).toHaveLength(1);
    expect(causes[0].title).toBe("비용 증가 원인 설명 확인 필요");
    expect(causes[0].locations).toEqual(["2P", "3P", "4P"]);
  });

  it("never states a gap as proven when slides could not be read", async () => {
    const draft = await deck([
      ["비용 보고", "3분기 물류비가 전분기 대비 18% 증가했습니다."],
      [],
    ]);
    const result = finalizeSupplement(draft, new Map());
    expect(result.coverage[0]).toMatchObject({ unit: "슬라이드", total: 2, analyzed: 1, complete: false });
    const cause = result.findings.find((finding) => finding.check === "cause");
    expect(cause?.status).toBe("unverified");
    expect(cause?.message).toContain("현재 읽은 범위에서");
    expect(cause?.limitation).toContain("2P");
  });

  it("marks chart content as unread and withholds certainty", async () => {
    const files = unzipSync(createPptxSlides([["비용 보고", "3분기 물류비가 전분기 대비 18% 증가했습니다."]]));
    files["ppt/charts/chart1.xml"] = strToU8("<c:chartSpace/>");
    const document = await parse("chart.pptx", zipSync(files));
    const result = finalizeSupplement(buildSupplementDraft([{ document, fileName: "chart.pptx" }]), new Map());
    expect(result.coverage[0].complete).toBe(false);
    expect(result.coverage[0].notes).toContain("차트 안의 값과 설명은 읽지 않았습니다.");
    expect(result.findings.every((finding) => finding.status === "unverified")).toBe(true);
  });

  it("reads a PDF across pages and reports page locations", async () => {
    const bytes = await createUnicodePdf([
      [h("월간 운영 보고"), p("고객 만족도 87점")],
      [h("주요 이슈"), p("설비 고장으로 라인 중단 3회 발생")],
      [h("대응"), p("설비 교체를 추진할 예정입니다.")],
    ]);
    const document = await parse("운영.pdf", bytes);
    const result = finalizeSupplement(buildSupplementDraft([{ document, fileName: "운영.pdf" }]), new Map());
    expect(result.coverage[0]).toMatchObject({ unit: "페이지", total: 3, analyzed: 3, complete: true });
    const baseline = result.findings.find((finding) => finding.check === "baseline");
    expect(baseline?.title).toBe("비교 기준 확인 필요");
    expect(baseline?.locations).toEqual(["1페이지"]);
    expect(result.findings.find((finding) => finding.check === "response")).toBeUndefined();
    const owner = result.findings.find((finding) => finding.check === "owner");
    const schedule = result.findings.find((finding) => finding.check === "schedule");
    expect(owner?.locations).toEqual(["3페이지"]);
    expect(schedule?.locations).toEqual(["3페이지"]);
    expect(owner?.id).not.toBe(schedule?.id);
  });

  it("does not claim a scanned PDF page was analysed", async () => {
    const bytes = await createUnicodePdf([[h("비용 보고"), p("3분기 물류비가 전분기 대비 18% 증가했습니다.")], []]);
    const result = finalizeSupplement(buildSupplementDraft([{ document: await parse("scan.pdf", bytes), fileName: "scan.pdf" }]), new Map());
    expect(result.coverage[0]).toMatchObject({ total: 2, analyzed: 1, complete: false });
    expect(result.coverage[0].notes[0]).toContain("2페이지");
  });

  it("stays quiet on a long, number-heavy deck without real gaps", async () => {
    const slides = [["연간 운영 실적", "연간 운영 실적을 정리했습니다."]];
    for (let month = 1; month <= 24; month += 1) {
      slides.push([`${month}월 실적`, `처리 건수 ${1000 + month}건 (목표 1,000건 대비 달성)`, `평균 처리시간 ${3 + (month % 3)}일 (전월 ${3 + ((month + 1) % 3)}일)`, `인원 ${20 + month}명`]);
    }
    const result = finalizeSupplement(await deck(slides), new Map());
    expect(result.coverage[0]).toMatchObject({ total: 25, analyzed: 25, complete: true });
    expect(result.findings).toEqual([]);
  });

  it("drops candidates the meaning-level re-check found elsewhere and withholds unclear ones", async () => {
    const draft = await deck([
      ["9월 이슈 보고", "주요 이슈를 공유합니다."],
      ["납기 이슈", "고객사 A 납기 지연 12건 발생"],
      ["고객 대응", "고객사 A 납기 관련 협력사와 협의 중이며 생산 순서를 바꿨습니다."],
      ["물류", "물류비가 전월 대비 20% 증가했습니다.", "운송 노선 변경 효과가 컸습니다."],
    ]);
    expect(draft.reviews.length).toBeGreaterThan(0);
    const verdicts = new Map(draft.reviews.flatMap((batch) => batch.checks.map((check) => [check.candidateId, { verdict: "found" as const, sources: [batch.sources[check.handles[0]]] }])));
    const result = finalizeSupplement(draft, verdicts);
    expect(result.findings.filter((finding) => draft.reviews.some((batch) => batch.checks.some((check) => check.candidateId === finding.id)))).toEqual([]);
    const unclear = finalizeSupplement(draft, new Map([...verdicts].map(([id]) => [id, { verdict: "unclear" as const, sources: [] }])));
    expect(unclear.withheldCount).toBe(verdicts.size);
  });
});

describe("보완 — review answer parsing", () => {
  const checks = [
    { id: "C1", statement: "물류비 18% 증가", requirement: "원인", handles: ["E1", "E2"] },
    { id: "C2", statement: "납기 지연", requirement: "대응", handles: ["E3"] },
  ];

  it("accepts found only with a handle from the check's own evidence", () => {
    expect(parseSupplementReview({ verdicts: [
      { id: "C1", verdict: "found", sources: ["e2"] },
      { id: "C2", verdict: "found", sources: ["E1"] },
    ] }, checks)).toEqual([
      { id: "C1", verdict: "found", handles: ["E2"] },
      { id: "C2", verdict: "unclear", handles: [] },
    ]);
  });

  it("ignores unknown ids and verdict labels", () => {
    expect(parseSupplementReview({ verdicts: [
      { id: "C9", verdict: "found", sources: ["E1"] },
      { id: "C1", verdict: "maybe", sources: [] },
      { id: "C2", verdict: "not_found", sources: [] },
    ] }, checks)).toEqual([{ id: "C2", verdict: "not_found", handles: [] }]);
  });
});
