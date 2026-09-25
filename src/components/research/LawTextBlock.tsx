"use client";

import { useMemo } from "react";
import { lawDisplayText } from "@/lib/law-display";

/**
 * The one place law MCP text is shown as a text block. The raw string is kept
 * by callers for markers and parsing; this renders its display form as plain
 * React text (never HTML), computed once per distinct text.
 */
export function LawTextBlock({ text, className }: { text: string; className: string }) {
  const shown = useMemo(() => lawDisplayText(text), [text]);
  return shown ? <pre className={className}>{shown}</pre> : null;
}
