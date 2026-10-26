"use client";

import { useMemo } from "react";
import { articleTitleDisplay } from "@/lib/law-article-target";
import { lawDisplayText } from "@/lib/law-display";

/**
 * The one place law MCP text is shown as a text block. The raw string is kept
 * by callers for markers and parsing; this renders its display form as plain
 * React text (never HTML), computed once per distinct text.
 *
 * `articleJo` is detail-view-only: when the caller is showing one article
 * under its own unified heading, the heading lines are removed from the
 * body here too, so the title is not shown twice. Every other caller keeps
 * the unmodified display text.
 */
export function LawTextBlock({ text, className, articleJo }: { text: string; className: string; articleJo?: string }) {
  const shown = useMemo(() => articleJo ? articleTitleDisplay(text, articleJo).body : lawDisplayText(text), [text, articleJo]);
  return shown ? <pre className={className}>{shown}</pre> : null;
}
