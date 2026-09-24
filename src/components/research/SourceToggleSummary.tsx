import { ChevronDown } from "lucide-react";

/** Row summary for a native `<details>`: label on the left, chevron on the right; the label follows the open state via CSS. */
export function SourceToggleSummary() {
  return <summary className="source-toggle">
    <span className="source-toggle-closed">원문 보기</span>
    <span className="source-toggle-open">원문 접기</span>
    <ChevronDown aria-hidden="true" />
  </summary>;
}
