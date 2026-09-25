import { ChevronDown } from "lucide-react";

/**
 * Row summary for a native `<details className="law-detail-source">`: label on
 * the left, chevron on the right; the label follows the open state via CSS.
 * Defaults to the raw-text toggle every law view shares.
 */
export function SourceToggleSummary({ label = "원문 보기", openLabel = "원문 접기" }: { label?: string; openLabel?: string }) {
  return <summary className="source-toggle">
    <span className="source-toggle-closed">{label}</span>
    <span className="source-toggle-open">{openLabel}</span>
    <ChevronDown aria-hidden="true" />
  </summary>;
}
