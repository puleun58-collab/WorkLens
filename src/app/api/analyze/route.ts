import { z } from "zod";
import { analyzeDocument } from "@/server/deterministic";
import { apiError, ok, readBoundedJson, runBoundedOperation } from "@/server/http";
import { requireSameOrigin, requireSession } from "@/server/session";
import { getFile, WorkspaceError } from "@/server/workspace-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inputSchema = z.object({ fileIds: z.array(z.uuid()).min(1).max(10) }).strict();

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const { principalKey } = await requireSession();
    const parsed = inputSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) throw new WorkspaceError("INVALID_REQUEST", "분석할 파일을 1개 이상 선택하세요.", 400);
    const files = await Promise.all(parsed.data.fileIds.map((id) => getFile(principalKey, id)));
    return ok(await runBoundedOperation(() => ({
      result: files.map((file) => ({ file: { id: file.id, name: file.name }, analysis: analyzeDocument(file.document) })),
    })));
  } catch (error) {
    return apiError(error);
  }
}
