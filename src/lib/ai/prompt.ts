import type { AiConfidence, AiRequest } from "@/domain/ai";
import { AI_SCHEMA_ID, type AiEvidenceNode, type AiProviderClaim, type AiProviderCompletion } from "@/lib/ai/contract";

/**
 * Prompt layer for the in-browser model.
 *
 * Two hard rules live here:
 *  1. The model never sees source locators, file ids or proposition tokens. It
 *     only sees short handles (`E1`, `E2`, …); the handle table stays in the
 *     document worker, which is also where claims are resolved back to
 *     canonical evidence.
 *  2. The prompt is bounded by item count and characters, because a 1.5B class
 *     model on WebGPU has a 4k token window.
 */
export const MAX_EVIDENCE_ITEMS = 40;
export const MAX_EVIDENCE_CHARS = 5_000;
export const MAX_EVIDENCE_ITEM_CHARS = 320;

/** The only evidence shape that crosses into the AI worker. */
export interface EvidenceItem {
  handle: string;
  text: string;
}

export interface EvidenceWindow {
  items: EvidenceItem[];
  /** Handle → canonical evidence. Never leaves the document worker. */
  nodes: Map<string, AiEvidenceNode>;
}

/** Bounds an already ranked list; ranking happens in `@/lib/ai/retrieval`. */
export function evidenceWindow(nodes: readonly AiEvidenceNode[]): EvidenceWindow {
  const items: EvidenceItem[] = [];
  const byHandle = new Map<string, AiEvidenceNode>();
  let characters = 0;
  for (const node of nodes) {
    if (items.length >= MAX_EVIDENCE_ITEMS) break;
    const text = node.text.slice(0, MAX_EVIDENCE_ITEM_CHARS).replace(/\s+/gu, " ").trim();
    if (!text) continue;
    if (characters + text.length > MAX_EVIDENCE_CHARS) break;
    const handle = `E${items.length + 1}`;
    items.push({ handle, text });
    byHandle.set(handle, node);
    characters += text.length;
  }
  return { items, nodes: byHandle };
}

/** JSON schema handed to the runtime so the model can only emit claim objects. */
export const CLAIM_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          sources: { type: "array", items: { type: "string" } },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["text", "sources"],
      },
    },
  },
  required: ["claims"],
} as const;

const SYSTEM_PROMPT = [
  "당신은 한국어 업무 문서 검토 보조자입니다.",
  "주어진 근거(E1, E2 …)에 실제로 적힌 내용만 사용하세요.",
  "근거에 없는 사실, 숫자, 날짜를 새로 만들지 마세요.",
  "각 항목은 반드시 사용한 근거 핸들을 sources 배열에 넣으세요.",
  "확신이 낮으면 confidence를 low로 표시하세요.",
  'JSON만 출력하세요: {"claims":[{"text":"...","sources":["E1"],"confidence":"medium"}]}',
].join(" ");

export function buildMessages(
  request: AiRequest,
  items: readonly EvidenceItem[],
): Array<{ role: "system" | "user"; content: string }> {
  const evidence = items.map((item) => `${item.handle}: ${item.text}`).join("\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${taskInstruction(request)}\n\n[근거]\n${evidence}` },
  ];
}

function taskInstruction(request: AiRequest): string {
  switch (request.operation) {
    case "ask":
      return `질문: ${request.question}\n근거로 답할 수 있는 내용만 3개 이하 항목으로 정리하세요.`;
    case "brief":
      return `${request.instruction ? `중점: ${request.instruction}\n` : ""}근거에 있는 핵심 사실, 주요 수치, 필요한 후속 조치를 5개 이하 항목으로 정리하세요.`;
    case "semantic-check":
      return `${request.statement}\n문장 표현, 맞춤법, 조사, 용어 일관성 관점의 제안만 5개 이하로 쓰세요. 숫자 검증은 하지 마세요.`;
    case "analyze":
      return "근거에서 읽을 수 있는 구조와 수치의 특징을 5개 이하 항목으로 정리하세요.";
  }
}

const MAX_CLAIMS = 8;
const MAX_CLAIM_CHARS = 400;

/** Claim exactly as the model phrased it: text plus the handles it cited. */
export interface ModelClaim {
  text: string;
  handles: string[];
  confidence: AiConfidence;
}

/**
 * Parses a model response into handle-level claims. Malformed JSON, empty text
 * and missing citations are dropped here, before anything touches evidence.
 */
export function parseModelClaims(raw: string): ModelClaim[] {
  const payload = extractJson(raw);
  const claims: ModelClaim[] = [];
  if (!payload || !Array.isArray(payload.claims)) return claims;
  for (const candidate of payload.claims) {
    if (claims.length >= MAX_CLAIMS) break;
    if (typeof candidate !== "object" || candidate === null) continue;
    const record = candidate as { text?: unknown; sources?: unknown; confidence?: unknown };
    const text = typeof record.text === "string" ? record.text.trim().slice(0, MAX_CLAIM_CHARS) : "";
    if (!text) continue;
    const handles = (Array.isArray(record.sources) ? record.sources : [])
      .filter((handle): handle is string => typeof handle === "string")
      .map((handle) => handle.trim().toUpperCase());
    if (handles.length === 0) continue;
    const confidence = record.confidence === "high" || record.confidence === "medium" ? record.confidence : "low";
    claims.push({ text, handles, confidence });
  }
  return claims;
}

/**
 * Maps model handles back onto canonical evidence tokens. Unknown handles are
 * dropped so grounding only ever sees claims that still point at real evidence.
 */
export function resolveClaims(window: EvidenceWindow, claims: readonly ModelClaim[]): AiProviderCompletion {
  const resolved: AiProviderClaim[] = [];
  for (const claim of claims) {
    const sourceTokens: string[] = [];
    for (const handle of claim.handles) {
      const node = window.nodes.get(handle);
      if (!node || sourceTokens.includes(node.propositionToken)) continue;
      sourceTokens.push(node.propositionToken);
    }
    if (sourceTokens.length === 0) continue;
    resolved.push({ type: "inference", text: claim.text, sourceTokens, confidence: claim.confidence });
  }
  return { schemaId: AI_SCHEMA_ID, claims: resolved };
}

function extractJson(raw: string): { claims?: unknown } | undefined {
  const text = raw.trim().replace(/^```(?:json)?/u, "").replace(/```$/u, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null ? (parsed as { claims?: unknown }) : undefined;
  } catch {
    return undefined;
  }
}
