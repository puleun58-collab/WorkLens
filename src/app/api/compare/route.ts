import { z } from "zod";
import { apiError, ok, readBoundedJson, runBoundedOperation } from "@/server/http";
import { requireSameOrigin, requireSession } from "@/server/session";
import { compareFiles, WorkspaceError } from "@/server/workspace-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  baseFileId: z.string().uuid(),
  targetFileId: z.string().uuid(),
}).strict();

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const { principalKey } = await requireSession();
    const parsed = requestSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) {
      throw new WorkspaceError("COMPARE_INPUT_INVALID", "비교할 두 파일을 올바르게 선택하세요.", 400);
    }
    const comparison = await runBoundedOperation(() =>
      compareFiles(principalKey, parsed.data.baseFileId, parsed.data.targetFileId),
    );
    return ok({ comparison });
  } catch (error) {
    return apiError(error);
  }
}
