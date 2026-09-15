import type { NormalizedDocument, SourceRef } from "@/domain/document";
import type { CheckFinding } from "@/domain/operations";
import { makeFinding, type TextUnit } from "../types";

function fallbackSource(document: NormalizedDocument, nodeId: string, label: string, page: number): SourceRef {
  return {
    fileId: document.fileId,
    documentId: document.id,
    ...(document.version ? { documentVersion: document.version } : {}),
    nodeId,
    label,
    page,
    quote: "",
  };
}

export function structureFindings(document: NormalizedDocument, units: readonly TextUnit[]): CheckFinding[] {
  const findings: CheckFinding[] = [];

  if (document.kind === "pdf" && (document.warnings.includes("PDF_TEXT_LAYER_EMPTY") || units.length === 0)) {
    const source = document.blocks[0]?.source ?? fallbackSource(document, `${document.id}:page:1`, "페이지 1", 1);
    findings.push(makeFinding({
      code: "ocr-text-unavailable",
      ruleId: "structure/pdf/no-text-layer",
      category: "structure",
      severity: "warning",
      confidence: "high",
      issue: "PDF 텍스트 추출 제한",
      message: "텍스트 레이어가 없거나 추출할 수 있는 텍스트가 제한적입니다.",
      reason: "스캔 이미지 PDF는 V1에서 OCR 검수를 지원하지 않습니다.",
      recommendation: "텍스트 선택이 가능한 PDF 또는 원본 문서로 다시 확인하세요.",
      sources: [source],
    }));
  }

  if (document.kind === "docx") {
    const headings = units.filter((unit) => unit.headingLevel !== undefined);
    for (let index = 1; index < headings.length; index += 1) {
      const previous = headings[index - 1].headingLevel!;
      const current = headings[index].headingLevel!;
      if (current <= previous + 1) continue;
      findings.push(makeFinding({
        code: "heading-hierarchy",
        ruleId: "structure/docx/heading-hierarchy",
        category: "structure",
        severity: "warning",
        confidence: "high",
        issue: "제목 계층 건너뜀",
        message: `Heading ${previous} 다음에 Heading ${current}이 사용됩니다.`,
        reason: "제목 단계가 중간 수준을 건너뛰어 문서 구조를 이해하기 어렵습니다.",
        recommendation: "제목 수준을 순차적으로 구성하세요.",
        sources: [headings[index - 1].source, headings[index].source],
        originalText: headings[index].text,
      }));
    }
    const numbered = headings
      .map((unit) => ({ unit, match: /^(\d+(?:\.\d+)*)([.)]?)\s+/u.exec(unit.text) }))
      .filter((entry) => entry.match);
    const delimiters = new Set(numbered.map((entry) => entry.match![2] || "none"));
    if (delimiters.size > 1) findings.push(makeFinding({
      code: "heading-numbering-inconsistency",
      ruleId: "structure/docx/heading-numbering",
      category: "formatting",
      severity: "suggestion",
      confidence: "medium",
      issue: "제목 번호 체계 불일치",
      message: "제목 번호 뒤의 구두점 형식이 일관되지 않습니다.",
      reason: "같은 문서에서 1., 1), 1 형식이 혼용됩니다.",
      recommendation: "하나의 제목 번호 형식으로 통일하세요.",
      sources: numbered.map((entry) => entry.unit.source),
      originalText: numbered.map((entry) => entry.match![0].trim()).join(" / "),
    }));
  }

  if (document.kind === "pptx") {
    const bySlide = new Map<number, TextUnit[]>();
    for (const unit of units.filter((entry) => entry.kind === "paragraph" && entry.page !== undefined)) {
      bySlide.set(unit.page!, [...(bySlide.get(unit.page!) ?? []), unit]);
    }
    const titles = [...bySlide.values()]
      .map((content) => content[0])
      .filter((title): title is TextUnit => Boolean(title) && title.text.length <= 140);
    const titlePunctuation = new Map<"punctuated" | "plain", TextUnit[]>();
    for (const title of titles) {
      const style = /[.!?:：]$/u.test(title.text) ? "punctuated" : "plain";
      titlePunctuation.set(style, [...(titlePunctuation.get(style) ?? []), title]);
    }
    if (titlePunctuation.size > 1 && titles.length >= 3) {
      const preferred = [...titlePunctuation.entries()].sort((left, right) => right[1].length - left[1].length)[0][0];
      findings.push(makeFinding({
        code: "title-format-inconsistency",
        ruleId: "structure/pptx/title-punctuation",
        category: "formatting",
        severity: "suggestion",
        confidence: "low",
        issue: "슬라이드 제목 표기 불일치",
        message: "슬라이드 제목의 문장부호 사용이 일관되지 않습니다.",
        reason: "같은 수준의 제목 일부에만 마침표 또는 콜론이 사용됩니다.",
        recommendation: preferred === "plain" ? "제목 끝의 불필요한 문장부호를 제거하세요." : "제목 문장부호를 하나의 형식으로 통일하세요.",
        sources: titles.map((title) => title.source),
        originalText: titles.map((title) => title.text).join(" / "),
      }));
    }
    for (let slide = 1; slide <= (document.metadata.pageCount ?? 0); slide += 1) {
      const content = bySlide.get(slide) ?? [];
      const first = content[0];
      if (!first || first.text.length > 140) {
        const source = first?.source ?? fallbackSource(document, `${document.id}:slide:${slide}`, `슬라이드 ${slide}`, slide);
        findings.push(makeFinding({
          code: "missing-slide-title",
          ruleId: "structure/pptx/missing-title",
          category: "structure",
          severity: "suggestion",
          confidence: "low",
          issue: "제목 없는 슬라이드 가능성",
          message: `슬라이드 ${slide}에서 짧고 명확한 제목을 확인하기 어렵습니다.`,
          reason: "첫 텍스트 블록이 없거나 제목으로 보기에는 지나치게 깁니다.",
          recommendation: "슬라이드 핵심 메시지를 담은 짧은 제목을 추가하세요.",
          sources: [source],
          ...(first ? { originalText: first.text } : {}),
        }));
      }
      const characterCount = content.reduce((sum, unit) => sum + unit.text.length, 0);
      if (characterCount > 650 && first) findings.push(makeFinding({
        code: "excessive-slide-text",
        ruleId: "structure/pptx/excessive-text",
        category: "structure",
        severity: "suggestion",
        confidence: "low",
        issue: "슬라이드 텍스트 과다",
        message: `슬라이드 ${slide}에 ${characterCount}자의 텍스트가 있습니다.`,
        reason: "한 슬라이드에 많은 텍스트가 있으면 발표와 빠른 검토가 어렵습니다.",
        recommendation: "핵심 메시지만 남기고 상세 내용은 부록 또는 발표자 노트로 이동하세요.",
        sources: content.map((unit) => unit.source),
      }));
    }
  }
  return findings;
}
