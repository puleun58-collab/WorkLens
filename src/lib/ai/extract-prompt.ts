import type { ExtractConfidence } from "@/domain/extract";
import type { EvidenceItem } from "@/lib/ai/prompt";

/**
 * Prompt layer for field extraction.
 *
 * The model is asked for one field at a time and may only copy a value that is
 * written in the bounded evidence window it was given. "Not stated" is a valid
 * and expected answer; a guessed value is not, and `parseExtractResponse`
 * drops anything that does not appear verbatim in the evidence.
 */
export const EXTRACT_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    field: { type: "string" },
    value: { type: ["string", "null"] },
    sources: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["field", "value", "sources"],
} as const;

const SYSTEM_PROMPT = [
  "당신은 한국어 업무 문서에서 값을 찾아 주는 추출 보조자입니다.",
  "주어진 근거(E1, E2 …)에 적힌 값만 그대로 복사하세요.",
  "숫자, 금액, 날짜, 비율은 표기를 바꾸지 말고 원문 그대로 쓰세요.",
  "근거에 값이 없으면 value를 null로 두고 sources를 빈 배열로 두세요.",
  "값을 추측하거나 계산해서 만들지 마세요.",
  "값을 찾은 근거 핸들을 sources에 넣으세요.",
  "설명 없이 JSON 객체 하나만 출력하세요.",
  '형식: {"field":"조치기한","value":"2026.09.30","sources":["E3"],"confidence":"high"}',
].join(" ");

export function buildExtractMessages(
  field: string,
  items: readonly EvidenceItem[],
): Array<{ role: "system" | "user"; content: string }> {
  const evidence = items.map((item) => `${item.handle}: ${item.text}`).join("\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `찾을 항목: ${field}\n근거에 이 항목의 값이 적혀 있으면 그대로 복사하세요.\n\n[근거]\n${evidence}` },
  ];
}

export interface ExtractProposal {
  field: string;
  /** Null means the evidence does not state the field. */
  value: string | null;
  handles: string[];
  confidence: ExtractConfidence;
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

function normalizeForCompare(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/\s+/gu, "");
}

/**
 * Parses one extraction answer and verifies it against the evidence it was
 * drawn from. A value that is not present in any cited item is discarded: the
 * field is then reported as not stated, which is the honest outcome.
 */
export function parseExtractResponse(
  raw: string,
  field: string,
  items: readonly EvidenceItem[],
): ExtractProposal {
  const missing: ExtractProposal = { field, value: null, handles: [], confidence: "low" };
  const payload = extractJson(raw);
  if (!payload || typeof payload !== "object") return missing;
  const record = payload as { value?: unknown; sources?: unknown; confidence?: unknown };
  const value = typeof record.value === "string" ? record.value.trim() : "";
  if (value.length === 0 || value === "null" || value === "없음") return missing;

  const handles = Array.isArray(record.sources)
    ? record.sources.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim().toUpperCase())
    : [];
  const cited = items.filter((item) => handles.includes(item.handle.toUpperCase()));
  const searched = cited.length > 0 ? cited : items;
  const needle = normalizeForCompare(value);
  const holder = searched.find((item) => normalizeForCompare(item.text).includes(needle));
  if (!holder) return missing;

  const confidence: ExtractConfidence = record.confidence === "high" || record.confidence === "medium"
    ? record.confidence
    : "low";
  return { field, value, handles: cited.length > 0 ? handles : [holder.handle], confidence };
}
