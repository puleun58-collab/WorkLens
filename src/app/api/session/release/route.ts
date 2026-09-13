import { z } from "zod";
import { apiError, ok, readBoundedJson } from "@/server/http";
import { claimTabRelease, requireSameOrigin, requireSession } from "@/server/session";
import { releaseTab, WorkspaceError } from "@/server/workspace-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inputSchema = z.object({ tabId: z.uuid(), releaseNonce: z.string().length(43) }).strict();

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const session = await requireSession();
    // sendBeacon posts text/plain and cannot attach the memory-held CSRF header.
    const parsed = inputSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) throw new WorkspaceError("INVALID_REQUEST", "탭 종료 정보가 유효하지 않습니다.", 400);
    await releaseTab(session.principalKey, parsed.data.tabId, claimTabRelease(session.credential, parsed.data.tabId, parsed.data.releaseNonce));
    return ok({ released: true, deletePendingMs: 15_000 });
  } catch (error) {
    return apiError(error);
  }
}
