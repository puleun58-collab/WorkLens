import type { PolishMode, PolishProposal } from "@/domain/polish";

/**
 * Prompt layer for the polish operation.
 *
 * The rule set is adapted from the MIT-licensed `humanize-korean` skill by
 * epoko77-ai (see THIRD-PARTY-NOTICES.md): translationese, AI filler, passive
 * and nominalisation overuse, repeated sentence openings. WorkLens tightens it
 * in one direction only — a business document's facts, structure and strength
 * of statement outrank naturalness, and `src/lib/polish/protect.ts` enforces
 * that in code rather than trusting the prompt.
 */

/** Only these three fields may come back; anything else is rejected. */
export const POLISH_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    changed: { type: "boolean" },
    revisedText: { type: "string" },
    reasons: { type: "array", items: { type: "string" } },
  },
  required: ["changed", "revisedText"],
} as const;

const SYSTEM_PROMPT = [
  "당신은 한국어 업무 문서 윤문 보조자입니다.",
  "전체를 새로 작성하지 말고 어색한 부분만 최소한으로 고치세요.",
  "이미 자연스러운 문장은 그대로 두고 changed를 false로 두세요.",
  "숫자, 금액, 비율, 단위, 날짜, 시간, 이메일, URL, 코드, 고유명사는 절대 바꾸지 마세요.",
  "원문에 없는 사실, 예시, 수치, 결론을 추가하지 마세요.",
  "따옴표 안의 직접 인용은 그대로 두세요.",
  "가능성·예정·권고·요청·의무·부정의 강도를 바꾸지 마세요.",
  "문서 구조, 제목, 번호 체계, 공식 용어, 약어는 유지하세요.",
  "고칠 점: 번역투(~을 통해, ~에 대해, ~에 있어서, ~에 의해, 가지고 있다), 불필요한 피동과 명사화, 의미 없는 상투어(결론적으로, 주목할 만하다, 시사하는 바가 크다), 중복 표현, 불필요한 문두 접속사.",
  "reasons에는 짧은 수정 사유만 2개 이하로 쓰세요. 예: 중복 표현 축소, 번역투 완화.",
  "설명이나 머리말 없이 JSON 객체 하나만 출력하세요.",
  '형식: {"changed":true,"revisedText":"...","reasons":["중복 표현 축소"]}',
].join(" ");

const MODE_INSTRUCTION: Record<PolishMode, string> = {
  default: "자연스럽게 다듬되 수정은 최소한으로 하세요.",
  concise: "중복, 우회 표현, 불필요한 수식어를 조금 더 적극적으로 줄이세요. 문장을 새로 만들지는 마세요.",
  business: "보고서·공지·메일에 맞게 명확하고 직접적인 문장으로 정리하세요. 격식은 원문과 같게 유지하세요.",
};

export function buildPolishMessages(text: string, mode: PolishMode): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${MODE_INSTRUCTION[mode]}\n\n[원문]\n${text}` },
  ];
}

function extractJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?/u, "").replace(/```$/u, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Parses one polish answer. A malformed answer is not an error to surface: it
 * means the text stays as it was, which is the safe outcome for a rewrite.
 */
export function parsePolishResponse(raw: string, original: string): PolishProposal {
  const payload = extractJson(raw);
  if (!payload || typeof payload !== "object") return { changed: false, revisedText: original, reasons: [] };
  const record = payload as { changed?: unknown; revisedText?: unknown; reasons?: unknown };
  const revised = typeof record.revisedText === "string" ? record.revisedText.trim() : "";
  const reasons = Array.isArray(record.reasons)
    ? record.reasons.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
    : [];
  if (record.changed !== true || revised.length === 0) {
    return { changed: false, revisedText: original, reasons: [] };
  }
  return { changed: true, revisedText: revised, reasons };
}
