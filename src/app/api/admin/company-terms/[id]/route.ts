import { AdminAuthError, requireAdmin } from "@/server/admin-auth";
import { deleteCompanyTerm, updateCompanyTerm } from "@/server/company-terms";
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

function termId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError("INVALID_REQUEST", "용어 ID가 올바르지 않습니다.", 400);
  return id;
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireSameSite(request);
    await requireAdmin(request);
    const { id } = await context.params;
    const body = await readBoundedJson(request, 8 * 1024);
    if (!body || typeof body !== "object") throw new ApiError("INVALID_REQUEST", "변경할 내용을 보내세요.", 400);
    const patch: { term?: string; description?: string | null; active?: boolean } = {};
    if ("term" in body && typeof body.term === "string") patch.term = body.term;
    if ("description" in body && (typeof body.description === "string" || body.description === null)) patch.description = body.description;
    if ("active" in body && typeof body.active === "boolean") patch.active = body.active;
    return ok({ term: await updateCompanyTerm(termId(id), patch) });
  } catch (error) {
    return apiError(toApiError(error));
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireSameSite(request);
    await requireAdmin(request);
    const { id } = await context.params;
    await deleteCompanyTerm(termId(id));
    return ok({ deleted: true });
  } catch (error) {
    return apiError(toApiError(error));
  }
}
