import { AdminAuthError, requireAdmin } from "@/server/admin-auth";
import { createCompanyTerm, listCompanyTerms } from "@/server/company-terms";
import { ApiError, apiError, ok, readBoundedJson, requireSameSite } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toApiError(error: unknown): ApiError {
  if (error instanceof AdminAuthError) return new ApiError(error.code, error.message, error.status);
  if (error instanceof ApiError) return error;
  const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
  if (code === "DUPLICATE_TERM") return new ApiError(code, "이미 등록된 용어입니다.", 409);
  if (code === "INVALID_TERM") return new ApiError(code, "용어를 확인하세요.", 400);
  if (code === "TERM_NOT_FOUND") return new ApiError(code, "용어를 찾을 수 없습니다.", 404);
  if (code === "COMPANY_TERMS_UNAVAILABLE") return new ApiError(code, "공용 사전 저장소를 사용할 수 없습니다.", 503);
  return new ApiError("INTERNAL_ERROR", "요청 처리 중 오류가 발생했습니다.", 500);
}

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    return ok({ terms: await listCompanyTerms(true) });
  } catch (error) {
    return apiError(toApiError(error));
  }
}

export async function POST(request: Request) {
  try {
    requireSameSite(request);
    await requireAdmin(request);
    const body = await readBoundedJson(request, 8 * 1024);
    if (!body || typeof body !== "object" || !("term" in body) || typeof body.term !== "string") {
      throw new ApiError("INVALID_REQUEST", "용어를 입력하세요.", 400);
    }
    const description = "description" in body && typeof body.description === "string" ? body.description : null;
    return ok({ term: await createCompanyTerm(body.term, description) }, 201);
  } catch (error) {
    return apiError(toApiError(error));
  }
}
