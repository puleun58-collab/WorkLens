/**
 * One result-status vocabulary for every 종합 리서치 task. Each task decides the
 * status from the evidence it actually adopted, never from how many hits a search returned.
 */
export type ResearchStatus = "matched" | "partial" | "weak" | "none";

export const STATUS_TITLE: Record<ResearchStatus, string> = {
  matched: "관련 근거를 확인했습니다",
  partial: "관련 근거를 일부 확인했습니다",
  weak: "직접 관련된 근거가 충분하지 않습니다",
  none: "관련 근거를 확인하지 못했습니다",
};
