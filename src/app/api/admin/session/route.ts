import { hasAdminSession } from "@/server/admin-auth";
import { apiError, ok } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return ok({ authenticated: await hasAdminSession(request) });
  } catch (error) {
    return apiError(error);
  }
}
