import type { AiRequest } from "@/domain/ai";
import { AI_SCHEMA_ID, type AiEvidenceNode, type AiProviderClaim, type AiProviderCompletion } from "@/lib/ai/contract";

/**
 * Prompt layer for the in-browser model.
 *
 * Two hard rules live here:
 *  1. The model never sees source locators, file ids or proposition tokens. It
 *     only sees short handles (`E1`, `E2`, …) that this module maps back to the
 *     canonical evidence before grounding runs.
 *  2. The context window is bounded by item count and characters, because a
 *     1.5B class model on WebGPU has a 4k token window.
 */
export const MAX_EVIDENCE_ITEMS = 40;
export const MAX_EVIDENCE_CHARS = 5_000;
export const MAX_EVIDENCE_ITEM_CHARS = 320;

export interface EvidenceWindow {
  items: Array<{ handle: string; node: AiEvidenceNode }>;
  byHandle: Map<string, AiEvidenceNode>;
}

/** Keeps the longest-signal evidence first, then bounds items and characters. */
export function evidenceWindow(nodes: readonly AiEvidenceNode[]): EvidenceWindow {
  const items: EvidenceWindow["items"] = [];
  const byHandle = new Map<string, AiEvidenceNode>();
  let characters = 0;
  for (const node of nodes) {
    if (items.length >= MAX_EVIDENCE_ITEMS) break;
    const text = node.text.slice(0, MAX_EVIDENCE_ITEM_CHARS);
    if (!text.trim()) continue;
    if (characters + text.length > MAX_EVIDENCE_CHARS) break;
    const handle = `E${items.length + 1}`;
    items.push({ handle, node });
    byHandle.set(handle, node);
    characters += text.length;
  }
  return { items, byHandle };
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

export function buildMessages(request: AiRequest, window: EvidenceWindow): Array<{ role: "system" | "user"; content: string }> {
  const evidence = window.items
    .map(({ handle, node }) => `${handle}: ${node.text.slice(0, MAX_EVIDENCE_ITEM_CHARS).replace(/\s+/gu, " ")}`)
    .join("\n");
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

/**
 * Parses a model response into provider claims. Anything the model invents —
 * malformed JSON, unknown handles, empty text — is dropped here so grounding
 * only ever sees claims that still point at canonical evidence.
 */
export function parseModelCompletion(raw: string, window: EvidenceWindow): AiProviderCompletion {
  const payload = extractJson(raw);
  const claims: AiProviderClaim[] = [];
  if (payload && Array.isArray(payload.claims)) {
    for (const candidate of payload.claims) {
      if (claims.length >= MAX_CLAIMS) break;
      const claim = toProviderClaim(candidate, window);
      if (claim) claims.push(claim);
    }
  }
  return { schemaId: AI_SCHEMA_ID, claims };
}

function toProviderClaim(candidate: unknown, window: EvidenceWindow): AiProviderClaim | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const record = candidate as { text?: unknown; sources?: unknown; confidence?: unknown };
  const text = typeof record.text === "string" ? record.text.trim().slice(0, MAX_CLAIM_CHARS) : "";
  if (!text) return undefined;
  const handles = Array.isArray(record.sources) ? record.sources : [];
  const sourceTokens: string[] = [];
  for (const handle of handles) {
    if (typeof handle !== "string") continue;
    const node = window.byHandle.get(handle.trim().toUpperCase());
    if (!node || sourceTokens.includes(node.propositionToken)) continue;
    sourceTokens.push(node.propositionToken);
  }
  if (sourceTokens.length === 0) return undefined;
  const confidence = record.confidence === "high" || record.confidence === "medium" ? record.confidence : "low";
  return { type: "inference", text, sourceTokens, confidence };
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
