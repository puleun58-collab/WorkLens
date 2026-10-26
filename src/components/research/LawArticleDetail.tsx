"use client";

import { Fragment, useEffect, useMemo, useRef } from "react";
import { resolveLawArticleTarget, type LawArticleTarget } from "@/lib/law-article-target";

export type { LawArticleTarget };

/**
 * Law detail only: moves to the requested 항/호 inside the article text that
 * is already loaded. No new MCP call. A target the resolver cannot find shows
 * the whole article with the status notice below, never a guessed line.
 */
export function LawArticleDetail({ text, jo, target }: { text: string; jo: string; target: LawArticleTarget }) {
  const firstTargetRef = useRef<HTMLElement | null>(null);
  const computed = useMemo(() => {
    const resolved = resolveLawArticleTarget(text, jo, target);
    return resolved.fallback
      ? { fallback: true as const, shownLines: resolved.shownLines, firstTargetIndex: -1 }
      : { fallback: false as const, shownLines: resolved.shownLines, firstTargetIndex: Math.min(...resolved.targetIndices), targetIndices: resolved.targetIndices };
  }, [text, jo, target]);

  useEffect(() => {
    // Instant, not the document's smooth scroll: the arrival screenshot and
    // the first paint must already show the target. Sibling move-to-target
    // scrolling (ContractReviewResult, LegalResearch) uses "instant" too.
    if (!computed.fallback) firstTargetRef.current?.scrollIntoView({ behavior: "instant", block: "start" });
  }, [computed, text, jo, target]);

  if (computed.fallback) {
    const body = computed.shownLines.join("\n");
    return <>
      <p className="law-search-note" role="status">해당 항목의 위치를 확인할 수 없어 조문 전체를 표시합니다.</p>
      {body.trim() ? <pre className="law-detail-raw">{body}</pre> : null}
    </>;
  }
  return <pre className="law-detail-raw">{computed.shownLines.map((line, index) => {
    const isTarget = computed.targetIndices.has(index);
    const node = isTarget
      ? <span id={index === computed.firstTargetIndex ? "law-article-target" : undefined} className="law-target-line" ref={index === computed.firstTargetIndex ? (element) => { firstTargetRef.current = element; } : undefined}>{line}</span>
      : <Fragment>{line}</Fragment>;
    return <Fragment key={index}>{index > 0 ? "\n" : null}{node}</Fragment>;
  })}</pre>;
}
