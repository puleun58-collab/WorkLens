import { randomUUID } from "node:crypto";
import { z } from "zod";
import { normalizeAnalysisDate } from "@/lib/law-analysis";
import { LAW_RESEARCH_ARTICLE_PATTERN, LAW_RESEARCH_BODY_MAX_BYTES, LAW_RESEARCH_DOCUMENT_MAX_CHARS,
  LAW_RESEARCH_DOCUMENT_MIN_CHARS, LAW_RESEARCH_MAX_ARTICLES, LAW_RESEARCH_NAME_MAX_CHARS,
  LAW_RESEARCH_QUERY_MAX_CHARS } from "@/lib/law-research";
import { ApiError, apiError, ok, readBoundedJson, requireSameSite, runBoundedOperation } from "@/server/http";
import { runLegalResearch } from "@/server/law-research-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.string().trim().min(1).max(LAW_RESEARCH_QUERY_MAX_CHARS);
const date = z.string().transform(normalizeAnalysisDate).pipe(z.string());
const documentText = z.string().max(LAW_RESEARCH_DOCUMENT_MAX_CHARS).trim().min(LAW_RESEARCH_DOCUMENT_MIN_CHARS);
const researchRequest = z.discriminatedUnion("task", [
  z.object({ task: z.literal("full_research"), query }).strict(),
  z.object({ task: z.literal("law_system"), query, articles: z.array(z.string().regex(LAW_RESEARCH_ARTICLE_PATTERN)).min(1).max(LAW_RESEARCH_MAX_ARTICLES).optional() }).strict(),
  z.object({ task: z.literal("action_basis"), query }).strict(),
  z.object({ task: z.literal("dispute_prep"), query, domain: z.enum(["tax", "labor", "privacy", "competition", "general"]).optional() }).strict(),
  z.object({ task: z.literal("amendment_track"), query,
    scenario: z.enum(["timeline", "time_travel"]).optional(),
    mst: z.string().regex(/^\d{1,12}$/u).optional(), lawId: z.string().regex(/^\d{1,12}$/u).optional(),
    fromDate: date.optional(), toDate: date.optional(), includeHistory: z.boolean().optional(),
  }).strict().superRefine((value, ctx) => {
    if (value.scenario !== "time_travel" && (value.fromDate || value.toDate)) {
      ctx.addIssue({ code: "custom", message: "Dates require time_travel" });
    }
    if (value.scenario === "time_travel" && (!value.fromDate || !value.toDate || value.fromDate > value.toDate)) {
      ctx.addIssue({ code: "custom", message: "time_travel requires ordered dates" });
    }
  }),
  z.object({ task: z.literal("ordinance_compare"), query,
    parentLaw: z.string().trim().min(1).max(LAW_RESEARCH_NAME_MAX_CHARS).refine((value) => !/[\p{Cc}]/u.test(value)).optional(),
  }).strict(),
  z.object({ task: z.literal("procedure_detail"), query }).strict(),
  z.object({ task: z.literal("document_review"), text: documentText }).strict(),
]);

export async function POST(request: Request) {
  const requestId = randomUUID();
  try {
    requireSameSite(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new ApiError("CONTENT_TYPE_REQUIRED", "JSON 요청만 허용됩니다.", 415);
    }
    const parsed = researchRequest.safeParse(await readBoundedJson(request, LAW_RESEARCH_BODY_MAX_BYTES));
    if (!parsed.success) throw new ApiError("LAW_INVALID_REQUEST", "리서치 입력을 확인하세요.", 400);
    const result = await runBoundedOperation(() => runLegalResearch(parsed.data, { requestId, signal: request.signal }));
    return ok(result, 200, requestId);
  } catch (error) {
    return apiError(error, requestId);
  }
}
