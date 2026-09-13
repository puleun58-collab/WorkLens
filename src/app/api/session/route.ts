import { cookies } from "next/headers";
import { apiError, ok } from "@/server/http";
import {
  createSession,
  csrfTokenForSession,
  deleteSession,
  requireCsrf,
  requireSameOrigin,
  requireSession,
  SessionError,
  sessionCookieName,
} from "@/server/session";
import { createWorkspace, deleteWorkspace, hasActiveWorkspace } from "@/server/workspace-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const jar = await cookies();
    const cookieName = sessionCookieName();
    const existing = jar.get(cookieName)?.value;
    let session;
    try {
      session = existing ? await requireSession() : createSession();
    } catch (error) {
      if (!(error instanceof SessionError) || !["SESSION_INVALID", "SESSION_REQUIRED"].includes(error.code)) throw error;
      session = createSession();
    }
    if (existing && !hasActiveWorkspace(session.principalKey)) {
      deleteSession(session.credential);
      session = createSession();
    }

    const workspace = await createWorkspace(session.principalKey);
    const response = ok({
      csrfToken: csrfTokenForSession(session.credential),
      expiresAt: new Date(workspace.committedExpiresAt).toISOString(),
    });
    response.cookies.set(cookieName, session.credential, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });
    return response;
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    requireSameOrigin(request);
    const session = await requireSession();
    requireCsrf(request, session.credential);
    await deleteWorkspace(session.principalKey);
    deleteSession(session.credential);
    const response = ok({ deleted: true });
    response.cookies.set(sessionCookieName(), "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return response;
  } catch (error) {
    return apiError(error);
  }
}
