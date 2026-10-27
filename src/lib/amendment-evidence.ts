import { capForFailure, hasAvailableContent, hasFailedSection, hasNoUsableSection, type TaskEvidence } from "@/lib/task-evidence";

/**
 * 개정 추적: a comparison is confirmed only from the MCP's own 신구대조표 /
 * Time Travel text. One article counts as compared only when its block
 * carries both an [개정 전] and an [개정 후] side with content — a newly
 * created article (<신 설>) or a deleted one (<삭 제>) still counts, because
 * the change itself is stated; a block with only one side is an incomplete
 * comparison, not a confirmed one. Dates count only when the text states a
 * 공포일 or a 시행일 for the compared versions (timeline: 구법/신법 공포일;
 * time_travel: 시점 A/B 시행). One-sided blocks or missing dates cap the
 * result at `partial`; material with no complete pair is `viewed`.
 */
const DATE_EVIDENCE = /(시점\s*[AB]\s*:|공포일\s*:|시행일|시행\s*:|시행\s+\d{4}\.\d{2}\.\d{2})/u;

function sideContent(block: string, marker: "[개정 전]" | "[개정 후]"): string {
  const start = block.indexOf(marker);
  if (start < 0) return "";
  const rest = block.slice(start + marker.length);
  const next = rest.search(/\[개정 (전|후)\]/u);
  return rest.slice(0, next < 0 ? undefined : next).replace(/<\/?P>/gu, "").trim();
}

export function assessAmendment(text: string): TaskEvidence {
  if (hasNoUsableSection(text)) {
    return { status: hasFailedSection(text) ? "failed" : "none", items: [] };
  }
  const blocks = text.split(/\n---\n/u);
  let complete = 0;
  let incomplete = 0;
  for (const block of blocks) {
    const before = sideContent(block, "[개정 전]");
    const after = sideContent(block, "[개정 후]");
    if (before && after) complete++;
    else if (before || after) incomplete++;
  }
  const dates = DATE_EVIDENCE.test(text);
  const items: TaskEvidence["items"] = [
    { label: "개정 전후 조문 비교", status: complete ? "found" : hasAvailableContent(text) ? "viewed" : "none",
      ...(complete || incomplete ? { detail: `완전 비교 ${complete}건${incomplete ? ` · 한쪽만 확인 ${incomplete}건` : ""}` } : {}) },
    { label: "시행일·공포일", status: complete && dates ? "found" : complete ? "viewed" : "none" },
  ];
  const base = !complete ? "viewed" : incomplete || !dates ? "partial" : "matched";
  return { status: capForFailure(base, hasFailedSection(text)), items };
}
