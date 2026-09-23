import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import type { NormalizedDocument } from "@/domain/document";
import type { AiEvidenceNode } from "@/lib/ai/contract";
import { buildEvidenceNodes } from "@/lib/ai/grounding";
import { selectEvidence } from "@/lib/ai/retrieval";
import { documentAnalysisTopics } from "@/lib/analysis-presentation";
import { parseDocument } from "@/lib/parsers";

/**
 * The real FSC Forecast guide: neighbouring sections share vocabulary
 * (산정, 선택, 재계산, 전환), which is exactly where a lexical retriever picks
 * an adjacent answer instead of the direct one.
 */
let document: NormalizedDocument;
let nodes: AiEvidenceNode[];

beforeAll(async () => {
  const bytes = new Uint8Array(await readFile("tests/data/fsc-forecast-guide.pdf"));
  document = await parseDocument({ fileId: "fsc", fileName: "FSC Forecast_주차별 예측값 산정 및 변경 가이드.pdf", bytes });
  nodes = buildEvidenceNodes([document]);
});

/** A tight window: only the most direct evidence survives it. */
const ask = (question: string) =>
  selectEvidence(nodes, { operation: "ask", question }, { limit: 4 }).map((node) => node.text.replace(/\s+/gu, " "));

describe("FSC Forecast guide", () => {
  it("lists every real section and never a synthetic overflow row", () => {
    const topics = documentAnalysisTopics(document).map((topic) => topic.text);
    for (const section of [
      "Forecast 값은 무엇인가요?",
      "주차별 Forecast 값은 어떻게 산정되나요?",
      "두바이유와 환율도 반영되나요?",
      "주차별 상세 데이터의 값 선택 순서",
      "Forecast 값은 왜 계속 바뀌나요?",
    ]) expect(topics).toContain(section);
    expect(topics.some((topic) => /외\s*\d+개/u.test(topic))).toBe(false);
  });

  it("answers each question from its own section, not the adjacent one", () => {
    expect(ask("산정 방식").some((text) => text.includes("최근 8 개 주간 평균 유가"))).toBe(true);
    expect(ask("값 선택 순서").some((text) => /주간 Forecast → 월간 Forecast → 직전 Forecast/u.test(text))).toBe(true);
    expect(ask("Forecast는 왜 바뀌나요?").some((text) => text.includes("새로운 오 피넷 Actual"))).toBe(true);
    expect(ask("Actual이 확보되면?").some((text) => text.includes("더 이상 Forecast 를 사용하지 않고"))).toBe(true);
    expect(ask("두바이유와 환율도 반영되나요?").some((text) => text.includes("보조적으로"))).toBe(true);
  });

  it("keeps the document title from winning a question on a shared word", () => {
    expect(ask("산정 방식")).not.toContain("주차별 예측값 산정 및 변경 가이드");
  });

  it("gives Analyze relations to interpret, not section titles", () => {
    const selected = selectEvidence(nodes, { operation: "analyze" }, { limit: 8 });
    expect(selected.filter((node) => node.role === "heading")).toHaveLength(0);
    expect(selected.some((node) => /재계산/u.test(node.text))).toBe(true);
    expect(selected.some((node) => /대체값/u.test(node.text))).toBe(true);
  });
});
