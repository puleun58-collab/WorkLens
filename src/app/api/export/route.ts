import { z } from "zod";
import type { NormalizedDocument } from "@/domain/document";
import { exportDocumentCsv, exportDocumentXlsx } from "@/server/export";
import { apiError, assertBinaryResultWithinLimit, readBoundedJson, runBoundedOperation } from "@/server/http";
import { requireSameOrigin, requireSession } from "@/server/session";
import { getFile, WorkspaceError } from "@/server/workspace-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inputSchema = z.object({
  fileIds: z.array(z.uuid()).min(1).max(10),
  format: z.enum(["csv", "xlsx"]),
}).strict();

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const { principalKey } = await requireSession();
    const parsed = inputSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) throw new WorkspaceError("INVALID_REQUEST", "내보낼 파일과 형식을 확인하세요.", 400);
    const files = await Promise.all(parsed.data.fileIds.map((id) => getFile(principalKey, id)));
    const document = combineDocuments(files.map((file) => file.document));
    const exported = await runBoundedOperation(
      () => parsed.data.format === "csv" ? exportDocumentCsv(document) : exportDocumentXlsx(document),
      false,
    );
    const body = typeof exported.content === "string"
      ? new TextEncoder().encode(`\uFEFF${exported.content}`)
      : new Uint8Array(exported.content);
    assertBinaryResultWithinLimit(body.byteLength);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": exported.mimeType,
        "Content-Disposition": `attachment; filename="worklens-export.${exported.format}"; filename*=UTF-8''${encodeURIComponent(exported.fileName)}`,
        "Cache-Control": "private, no-store, max-age=0",
        Pragma: "no-cache",
        Expires: "0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

function combineDocuments(documents: NormalizedDocument[]): NormalizedDocument {
  return {
    id: `export:${documents.map((document) => document.id).join(":")}`,
    fileId: "export",
    kind: documents[0].kind,
    metadata: { fileName: documents.length === 1 ? documents[0].metadata.fileName : "worklens-export.xlsx" },
    blocks: documents.flatMap((document) => document.blocks),
    warnings: documents.flatMap((document) => document.warnings),
  };
}
