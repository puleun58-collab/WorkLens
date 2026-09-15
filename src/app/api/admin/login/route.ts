import { AdminAuthError, createAdminSession } from "@/server/admin-auth";
import { ApiError, apiError, ok, readBoundedJson, requireSameSite } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireSameSite(request);
    const body = await readBoundedJson(request, 4 * 1024);
    const password = body && typeof body === "object" && "password" in body ? body.password : undefined;
    if (typeof password !== "string" || password.length === 0) {
      throw new ApiError("INVALID_REQUEST", "비밀번호를 입력하세요.", 400);
    }
    const cookie = await createAdminSession(request, password);
    const response = ok({ authenticated: true });
    response.headers.append("set-cookie", cookie);
    return response;
  } catch (error) {
    if (error instanceof AdminAuthError) return apiError(new ApiError(error.code, error.message, error.status));
    return apiError(error);
  }
}
