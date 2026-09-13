import { z } from "zod";
import { apiError, ok, readBoundedJson } from "@/server/http";
import { bindTabRelease, requireCsrf, requireSameOrigin, requireSession } from "@/server/session";
import { heartbeatTab, registerTab, WorkspaceError } from "@/server/workspace-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const heartbeatSchema = z.object({ tabId: z.uuid(), releaseToken: z.string().length(64) }).strict();

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const session = await requireSession();
    requireCsrf(request, session.credential);
    const tab = await registerTab(session.principalKey);
    return ok({ ...tab, releaseNonce: bindTabRelease(session.credential, tab.tabId, tab.releaseToken) });
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request) {
  try {
    requireSameOrigin(request);
    const session = await requireSession();
    requireCsrf(request, session.credential);
    const parsed = heartbeatSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) throw new WorkspaceError("INVALID_REQUEST", "탭 세션 정보가 유효하지 않습니다.", 400);
    await heartbeatTab(session.principalKey, parsed.data.tabId, parsed.data.releaseToken);
    return ok({ renewed: true });
  } catch (error) {
    return apiError(error);
  }
}
