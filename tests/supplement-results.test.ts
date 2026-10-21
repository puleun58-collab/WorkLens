import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SupplementResults } from "../src/components/supplement/SupplementResults";
import type { SupplementFinding, SupplementResult } from "../src/domain/supplement";

const finding: SupplementFinding = {
  id: "baseline", fileId: "report", check: "baseline", severity: "warning", status: "missing",
  title: "비교 기준 확인 필요",
  message: "피킹 소요시간이 제시되어 있지만 현재 자료에서 판단할 비교 기준(목표·이전 기간·기준값)을 확인하지 못했습니다.",
  reason: "기준이 없으면 판단하기 어렵습니다.", current: "피킹 소요시간 5분",
  sources: [], locations: ["2P"], additions: ["목표값 또는 기준값", "이전 기간 값"],
  question: "피킹 소요시간은 목표 대비 어느 수준입니까?", scope: "all",
};

function renderTitles(findings: SupplementFinding[]) {
  const result: SupplementResult = {
    files: [], coverage: [], findings, questions: [], resolvedCount: 0, confirmedCount: 0,
    withheldCount: 0, semanticReview: "not-needed",
  };
  const before = structuredClone(result);
  const html = renderToStaticMarkup(createElement(SupplementResults, {
    result, fileNames: new Map<string, string>(), renderSource: () => null,
  }));
  expect(result).toEqual(before);
  return [...html.matchAll(/class="supplement-item-title">(.*?)<\/span>/g)].map(match => match[1]);
}

describe("supplement subject titles", () => {
  it("uses the explicit subject without carrying the raw value into the heading", () => {
    expect(renderTitles([finding])).toEqual(["피킹 소요시간"]);
  });
  it("keeps a dash that belongs to the subject", () => {
    expect(renderTitles([{
      ...finding, message: finding.message.replace("피킹 소요시간", "피킹 — 포장 소요시간"),
      question: "피킹 — 포장 소요시간은 목표 대비 어느 수준입니까?",
    }])).toEqual(["피킹 — 포장 소요시간"]);
  });
  it("preserves a specific compound title even when a standard message is present", () => {
    const title = "피킹 — 포장 프로세스 / 비교 범위 재검토";
    expect(renderTitles([{ ...finding, title }])).toEqual([title]);
  });
  it("does not infer a subject from arbitrary original text", () => {
    expect(renderTitles([{
      ...finding, message: "장비 A — B를 사용한 현장 기록입니다.", question: undefined,
    }])).toEqual([finding.title]);
  });
  it("distinguishes different missing information for the same subject", () => {
    expect(renderTitles([finding, {
      ...finding, id: "cause", check: "cause", title: "원인 설명 확인 필요",
      message: "피킹 소요시간이 전월 대비 18% 증가했다고 제시되어 있지만 현재 자료에서 주요 증가 원인 설명을 확인하지 못했습니다.",
      additions: ["주요 증가 요인"],
    }])).toEqual(["피킹 소요시간 · 비교 기준 미확인 · 2P", "피킹 소요시간 · 원인 미확인 · 2P"]);
  });
  it("retains report scope rather than presenting supplied information as globally missing", () => {
    const title = "비교 기준을 보고자료에 추가하면 좋습니다";
    expect(renderTitles([{ ...finding, scope: "report", title }])).toEqual([title]);
  });
});

describe("supplement summary meta", () => {
  function renderSummary(result: SupplementResult) {
    return renderToStaticMarkup(createElement(SupplementResults, {
      result, fileNames: new Map<string, string>(), renderSource: () => null,
    }));
  }
  const base: SupplementResult = {
    files: [{ fileId: "report", fileName: "보고.pptx", docType: "general", role: "report" }],
    coverage: [{ fileId: "report", fileName: "보고.pptx", kind: "pptx", unit: "슬라이드", total: 2, analyzed: 2, complete: true, notes: [] }],
    findings: [finding], questions: [], resolvedCount: 0, confirmedCount: 0,
    withheldCount: 0, semanticReview: "not-needed",
  };

  it("omits 자료 유형 and the 분석 범위 line when the analysis covered everything", () => {
    const html = renderSummary(base);
    expect(html).not.toContain("자료 유형");
    expect(html).not.toContain("일반 업무자료");
    expect(html).not.toContain("분석 범위");
    expect(html).not.toContain("전체 분석 완료");
  });

  it("keeps the limitation line when part of the document could not be analysed", () => {
    const html = renderSummary({
      ...base,
      coverage: [{ ...base.coverage[0], complete: false, analyzed: 1, notes: ["2슬라이드를 읽지 못했습니다"] }],
    });
    expect(html).toContain("일부 분석 제한");
    expect(html).toContain("2슬라이드를 읽지 못했습니다");
    expect(html).not.toContain("자료 유형");
  });

  it("discloses deliberately excluded sheets instead of claiming 전체 분석", () => {
    const html = renderSummary({
      ...base,
      coverage: [{
        ...base.coverage[0],
        sheets: [{
          name: "원본데이터", status: "structure", role: "원본", hidden: false,
          rows: 120, columns: 6, filledCells: 700, formulas: 0, crossSheetFormulas: 0, merges: 0,
        }],
      }],
    });
    expect(html).toContain("분석 완료");
    expect(html).not.toContain("전체 분석 완료");
    expect(html).toContain("시트별 처리 상태");
  });

  it("keeps the 핵심 보고자료 미확정 note for multi-file results without a report file", () => {
    const html = renderSummary({
      ...base,
      files: [
        { fileId: "a", fileName: "자료A.pptx", docType: "general", role: "reference" },
        { fileId: "b", fileName: "자료B.pptx", docType: "general", role: "data" },
      ],
      coverage: [
        { fileId: "a", fileName: "자료A.pptx", kind: "pptx", unit: "슬라이드", total: 1, analyzed: 1, complete: true, notes: [] },
        { fileId: "b", fileName: "자료B.pptx", kind: "pptx", unit: "슬라이드", total: 1, analyzed: 1, complete: true, notes: [] },
      ],
    });
    expect(html).toContain("핵심 보고자료를 확정하지 못했습니다");
    expect(html).not.toContain("자료 유형");
  });
});
