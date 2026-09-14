import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { AiRequest } from "@/domain/ai";
import type { NormalizedDocument } from "@/domain/document";
import { AI_SCHEMA_ID, type AiEvidenceNode } from "@/server/ai/provider";
import { normalizedDocumentSchema } from "@/server/ai/document-schema";
import { buildEvidenceNodes, groundAiResult } from "@/server/ai/grounding";
import { createLocalAiProvider } from "@/server/ai/local-provider";
import { ApiError, apiError, ok, readBoundedJson, requireSameOrigin, runBoundedOperation } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stateless by construction: the browser holds every document and sends the
 * ones it wants interpreted. Nothing is stored between requests.
 */
const inputSchema = z.object({
  task: z.enum(["analyze", "ask", "brief", "semantic-check"]),
  question: z.string().trim().min(1).max(2_000).optional(),
  documents: z.array(normalizedDocumentSchema).min(1).max(5),
}).strict().superRefine((value, context) => {
  if ((value.task === "ask" || value.task === "semantic-check") && !value.question) {
    context.addIssue({ code: "custom", path: ["question"], message: "question is required" });
  }
});

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const parsed = inputSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) throw new ApiError("INVALID_REQUEST", "AI 작업의 문서와 질문을 확인하세요.", 400);
    const documents = parsed.data.documents as NormalizedDocument[];
    const requestId = randomUUID();
    const result = await runBoundedOperation(async () => {
      const aiRequest = toAiRequest(parsed.data);
      const provider = createLocalAiProvider();
      const evidence = boundedEvidence(buildEvidenceNodes(documents));
      const response = await provider.complete({
        requestId,
        sessionKey: requestId,
        task: aiRequest.operation,
        schemaId: AI_SCHEMA_ID,
        locale: "ko-KR",
        sourceTokens: evidence.map((node) => node.propositionToken),
        context: evidence.map(({ propositionToken, text, proposition }) => ({ propositionToken, text, proposition })),
        maxOutputTokens: 8_000,
      }, request.signal);
      if (response.status === "unavailable") {
        throw new ApiError(
          "AI_UNAVAILABLE",
          "Local AI를 사용할 수 없습니다. 문장/맞춤법 기반 고급 검수는 현재 사용할 수 없습니다. 숫자, 중복, 개인정보 등 deterministic 검수는 계속 사용할 수 있습니다.",
          503,
        );
      }
      return groundAiResult(aiRequest, documents, response.completion);
    });
    if (result.rejectedClaimCount > 0) {
      throw new ApiError("EVIDENCE_VALIDATION_FAILED", "근거가 검증되지 않은 AI 결과를 거부했습니다.", 422);
    }
    if (result.operation === "ask" && result.claims.length === 0) {
      throw new ApiError("INSUFFICIENT_EVIDENCE", "선택한 문서에서 답을 뒷받침할 근거를 찾지 못했습니다.", 422);
    }
    return ok({ result });
  } catch (error) {
    return apiError(error);
  }
}

export function boundedEvidence(nodes: AiEvidenceNode[]): AiEvidenceNode[] {
  const selected: AiEvidenceNode[] = [];
  let bytes = 2; // JSON array brackets.
  const encoder = new TextEncoder();
  for (const node of nodes) {
    const candidate = { ...node, text: node.text.slice(0, 8_000) };
    const next = encoder.encode(JSON.stringify(candidate)).byteLength + (selected.length > 0 ? 1 : 0);
    // Leave room for the fixed provider envelope below the 2 MiB wire limit.
    if (next > 1_500 * 1024 || bytes + next > 1_500 * 1024) continue;
    selected.push(candidate);
    bytes += next;
  }
  return selected;
}

function toAiRequest(input: z.infer<typeof inputSchema>): AiRequest {
  if (input.task === "ask") return { operation: "ask", question: input.question! };
  if (input.task === "semantic-check") return { operation: "semantic-check", statement: input.question! };
  if (input.task === "brief") return { operation: "brief", ...(input.question ? { instruction: input.question } : {}) };
  return { operation: "analyze" };
}
