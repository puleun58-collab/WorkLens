import { clearAdminSession } from "@/server/admin-auth";
import { apiError, ok, requireSameSite } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireSameSite(request);
    const response = ok({ authenticated: false });
    response.headers.append("set-cookie", clearAdminSession());
    return response;
  } catch (error) {
    return apiError(error);
  }
}
