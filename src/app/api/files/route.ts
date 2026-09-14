import { createHash } from "node:crypto";
import path from "node:path";
import { open, readFile, rm } from "node:fs/promises";
import { apiError, ok } from "@/server/http";
import { requireSameOrigin, requireSession } from "@/server/session";
import {
  allocateUpload,
  cancelUpload,
  cleanupFailedUpload,
  listFiles,
  registerFile,
  reserveUploadBytes,
  WorkspaceError,
  type FileKind,
} from "@/server/workspace-store";
import { parseDocumentIsolated } from "@/server/parsers/isolated";
import { inputLimitFor } from "@/server/parsers/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<FileKind, Set<string>> = {
  xlsx: new Set(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream"]),
  csv: new Set(["text/csv", "application/csv", "text/plain", "application/octet-stream"]),
  pdf: new Set(["application/pdf", "application/octet-stream"]),
  docx: new Set(["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream"]),
  pptx: new Set(["application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/octet-stream"]),
};

export async function GET() {
  try {
    const { principalKey } = await requireSession();
    return ok({ files: await listFiles(principalKey) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const cloudflareRuntime = process.env.WORKLENS_CLOUDFLARE === "true";
  let filePath: string | undefined;
  let allocationId: string | undefined;
  let principalKey: string | undefined;
  try {
    requireSameOrigin(request);
    ({ principalKey } = await requireSession());
    const displayName = safeDisplayName(request.headers.get("x-file-name"));
    const kind = extensionOf(displayName);
    const maxFileBytes = inputLimitFor(kind);
    validateDeclaredSize(request.headers.get("content-length"), maxFileBytes);
    validateMime(kind, request.headers.get("content-type"));
    if (!request.body) throw new WorkspaceError("EMPTY_FILE", "업로드할 파일이 비어 있습니다.", 400);

    const allocation = await allocateUpload(principalKey, kind);
    allocationId = allocation.id;
    filePath = allocation.filePath;
    const hasher = createHash("sha256");
    const chunks: Uint8Array[] = [];
    let size = 0;
    const file = cloudflareRuntime ? undefined : await open(/* turbopackIgnore: true */ filePath, "wx", 0o600);
    try {
      const reader = request.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        size += value.byteLength;
        if (size > maxFileBytes) {
          await reader.cancel();
          throw new WorkspaceError("FILE_TOO_LARGE", `${kind.toUpperCase()} 파일은 ${formatMiB(maxFileBytes)} 이하만 업로드할 수 있습니다.`, 413);
        }
        hasher.update(value);
        await reserveUploadBytes(principalKey, allocation.id, size);
        if (file) await file.write(value);
        else chunks.push(value);
      }
    } finally {
      await file?.close();
    }
    if (size === 0) throw new WorkspaceError("EMPTY_FILE", "업로드할 파일이 비어 있습니다.", 400);
    const contentHash = hasher.digest("hex");

    const cloudflareBytes = cloudflareRuntime ? concatenateChunks(chunks, size) : undefined;
    if (cloudflareBytes) validateUploadBytes(cloudflareBytes, kind);
    else await validateStoredUpload(filePath, kind);
    const { document, normalizedSize } = await parseDocumentIsolated(
      cloudflareBytes
        ? { fileId: allocation.id, fileName: displayName, bytes: cloudflareBytes }
        : { fileId: allocation.id, fileName: displayName, filePath, size, contentHash },
      request.signal,
    );
    if (request.signal.aborted) throw new WorkspaceError("PARSER_CANCELLED", "업로드가 취소되었습니다.", 499);
    const summary = await registerFile(principalKey, {
      id: allocation.id,
      filePath,
      name: displayName,
      kind,
      size,
      document,
      normalizedSize,
    });
    filePath = undefined;
    allocationId = undefined;
    return ok({ file: summary }, 201);
  } catch (error) {
    if (cloudflareRuntime && principalKey && allocationId) {
      await cancelUpload(principalKey, allocationId).catch(() => undefined);
    } else if (filePath && principalKey && allocationId) {
      await cleanupFailedUpload(principalKey, allocationId, filePath).catch(() => undefined);
    } else {
      if (filePath) await rm(filePath, { force: true }).catch(() => undefined);
      if (principalKey && allocationId) await cancelUpload(principalKey, allocationId).catch(() => undefined);
    }
    return apiError(error);
  }
}

function concatenateChunks(chunks: Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function safeDisplayName(header: string | null): string {
  if (!header) throw new WorkspaceError("FILE_NAME_REQUIRED", "파일 이름이 필요합니다.", 400);
  let decoded: string;
  try {
    decoded = decodeURIComponent(header);
  } catch {
    throw new WorkspaceError("FILE_NAME_INVALID", "파일 이름 인코딩이 유효하지 않습니다.", 400);
  }
  const normalized = decoded.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const base = path.posix.basename(path.win32.basename(normalized));
  if (!base || base === "." || base === ".." || base.length > 240) {
    throw new WorkspaceError("FILE_NAME_INVALID", "파일 이름이 유효하지 않습니다.", 400);
  }
  return base;
}

function extensionOf(name: string): FileKind {
  const extension = path.extname(name).slice(1).toLowerCase();
  if (!["xlsx", "csv", "pdf", "docx", "pptx"].includes(extension)) {
    throw new WorkspaceError("FILE_TYPE_UNSUPPORTED", "XLSX, CSV, PDF, DOCX 또는 PPTX 파일만 업로드할 수 있습니다.", 415);
  }
  return extension as FileKind;
}

function validateDeclaredSize(value: string | null, maxFileBytes: number): void {
  if (!value) return;
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size <= 0) throw new WorkspaceError("FILE_SIZE_INVALID", "파일 크기가 유효하지 않습니다.", 400);
  if (size > maxFileBytes) throw new WorkspaceError("FILE_TOO_LARGE", `이 형식은 ${formatMiB(maxFileBytes)} 이하만 업로드할 수 있습니다.`, 413);
}

function validateMime(kind: FileKind, value: string | null): void {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
  if (!MIME[kind].has(mime)) throw new WorkspaceError("MIME_MISMATCH", "파일 형식과 MIME type이 일치하지 않습니다.", 415);
}

function validateMagic(kind: FileKind, bytes: Uint8Array): void {
  const isPdf = bytes.length >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]) && [0x04, 0x06, 0x08].includes(bytes[3]);
  const isCsv = kind !== "csv" || (() => {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return !bytes.includes(0);
    } catch {
      return false;
    }
  })();
  const zipKind = kind === "xlsx" || kind === "docx" || kind === "pptx";
  if ((kind === "pdf" && !isPdf) || (zipKind && !isZip) || !isCsv) {
    throw new WorkspaceError("FILE_SIGNATURE_MISMATCH", "파일 확장자와 실제 내용이 일치하지 않습니다.", 415);
  }
}

function validateZipStructure(kind: "xlsx" | "docx" | "pptx", bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65_557); offset -= 1) {
    if (offset >= 0 && view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new WorkspaceError("CORRUPT_ARCHIVE", "압축 문서 구조가 유효하지 않습니다.", 400);
  const entries = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (entries > 10_000 || centralOffset + centralSize > end) {
    throw new WorkspaceError("PARSER_LIMIT", "압축 문서가 안전 처리 한도를 초과했습니다.", 413);
  }
  let offset = centralOffset;
  let totalUncompressed = 0;
  const names: string[] = [];
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new WorkspaceError("CORRUPT_ARCHIVE", "압축 문서 구조가 유효하지 않습니다.", 400);
    }
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new WorkspaceError("PARSER_LIMIT", "ZIP64 문서는 지원하지 않습니다.", 415);
    }
    totalUncompressed += uncompressed;
    if (totalUncompressed > 500 * 1024 * 1024 || (compressed === 0 ? uncompressed > 0 : uncompressed / compressed > 100)) {
      throw new WorkspaceError("PARSER_LIMIT", "압축 문서가 안전 처리 한도를 초과했습니다.", 413);
    }
    const nameStart = offset + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > centralOffset + centralSize) throw new WorkspaceError("CORRUPT_ARCHIVE", "압축 문서 구조가 유효하지 않습니다.", 400);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(nameStart, nameStart + nameLength));
    if (name.includes("\\") || name.split("/").includes("..")) throw new WorkspaceError("SECURITY_REJECTED", "안전하지 않은 압축 경로를 거부했습니다.", 415);
    names.push(name.toLowerCase());
    offset = next;
  }
  const required = kind === "xlsx" ? "xl/workbook.xml" : kind === "docx" ? "word/document.xml" : "ppt/presentation.xml";
  if (!names.includes(required)) throw new WorkspaceError("FILE_SIGNATURE_MISMATCH", "파일 확장자와 실제 문서 형식이 일치하지 않습니다.", 415);
  if (names.some((name) => name.endsWith("vbaproject.bin") || name.includes("/externallinks/"))) {
    throw new WorkspaceError("SECURITY_REJECTED", "매크로 또는 외부 연결이 포함된 문서는 처리할 수 없습니다.", 415);
  }
}

async function validateStoredUpload(filePath: string, kind: FileKind): Promise<void> {
  const bytes = new Uint8Array(await readFile(filePath));
  validateUploadBytes(bytes, kind);
}

function validateUploadBytes(bytes: Uint8Array, kind: FileKind): void {
  validateMagic(kind, bytes);
  if (kind === "xlsx" || kind === "docx" || kind === "pptx") validateZipStructure(kind, bytes);
}

function formatMiB(bytes: number): string {
  return `${Math.floor(bytes / 1024 / 1024)} MiB`;
}
