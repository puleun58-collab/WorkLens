import type { FileKind } from "@/domain/document";
import { MAX_WORKSPACE_INPUT_BYTES, inputLimitFor } from "./parsers/policy";

/** Every rejection a user can hit while admitting a file, raised in the browser. */
export class DocumentError extends Error {
  constructor(public readonly code: string, message: string, public readonly detail?: string) {
    super(message);
    this.name = "DocumentError";
  }
}

const SUPPORTED: readonly FileKind[] = ["xlsx", "csv", "pdf", "docx", "pptx"];
/** Macro-enabled workbooks are the same OOXML package; the macro is never run. */
const EXTENSION_KINDS: Record<string, FileKind> = { xlsm: "xlsx" };
const MAX_ZIP_ENTRIES = 10_000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;

export function fileKindOf(fileName: string): FileKind {
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  const mapped = EXTENSION_KINDS[extension];
  if (mapped) return mapped;
  if (!SUPPORTED.includes(extension as FileKind)) {
    throw new DocumentError(
      "FILE_TYPE_UNSUPPORTED",
      "지원하지 않는 파일 형식입니다.",
      "XLSX, XLSM, CSV, PDF, DOCX, PPTX 파일을 업로드해 주세요.",
    );
  }
  return extension as FileKind;
}

export function safeDisplayName(name: string): string {
  const normalized = name.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const base = normalized.split(/[\\/]/).pop() ?? "";
  if (!base || base === "." || base === ".." || base.length > 240) {
    throw new DocumentError("FILE_NAME_INVALID", "파일 이름이 유효하지 않습니다.");
  }
  return base;
}

export function assertSizeWithinLimit(kind: FileKind, size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new DocumentError("EMPTY_FILE", "업로드할 파일이 비어 있습니다.");
  }
  const limit = inputLimitFor(kind);
  if (size > limit) {
    throw new DocumentError(
      "FILE_TOO_LARGE",
      `이 파일은 최대 ${Math.floor(limit / 1024 / 1024)} MB까지 처리할 수 있습니다.`,
    );
  }
}

/**
 * The per-file ceiling says nothing about how much the tab is already holding,
 * so admission also checks the workspace budget. The two failures are reported
 * separately: one is about this file, the other about everything kept open.
 */
export function assertWorkspaceWithinLimit(currentBytes: number, incomingBytes: number): void {
  if (currentBytes + incomingBytes > MAX_WORKSPACE_INPUT_BYTES) {
    throw new DocumentError(
      "WORKSPACE_SIZE_LIMIT",
      `현재 작업 공간에 추가할 수 있는 총 파일 용량(${Math.floor(MAX_WORKSPACE_INPUT_BYTES / 1024 / 1024)} MB)을 초과합니다. 사용하지 않는 파일을 삭제한 뒤 다시 시도하세요.`,
    );
  }
}

function validateMagic(kind: FileKind, bytes: Uint8Array): void {
  const isPdf = bytes.length >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && [0x03, 0x05, 0x07].includes(bytes[2]) && [0x04, 0x06, 0x08].includes(bytes[3]);
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
    throw new DocumentError("FILE_SIGNATURE_MISMATCH", "파일 확장자와 실제 내용이 일치하지 않습니다.");
  }
}

/**
 * Walks the ZIP central directory before any parser touches the archive so a
 * zip bomb, ZIP64 archive, traversal path, macro project or external link is
 * rejected while the file is still just bytes in memory.
 */
function validateZipStructure(kind: "xlsx" | "docx" | "pptx", bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65_557); offset -= 1) {
    if (offset >= 0 && view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new DocumentError("CORRUPT_ARCHIVE", "압축 문서 구조가 유효하지 않습니다.");
  const entries = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (entries > MAX_ZIP_ENTRIES || centralOffset + centralSize > end) {
    throw new DocumentError("PARSER_LIMIT", "압축 문서가 안전 처리 한도를 초과했습니다.");
  }

  let offset = centralOffset;
  let totalUncompressed = 0;
  const names: string[] = [];
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new DocumentError("CORRUPT_ARCHIVE", "압축 문서 구조가 유효하지 않습니다.");
    }
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new DocumentError("PARSER_LIMIT", "ZIP64 문서는 지원하지 않습니다.");
    }
    totalUncompressed += uncompressed;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES || (compressed === 0 ? uncompressed > 0 : uncompressed / compressed > 100)) {
      throw new DocumentError("PARSER_LIMIT", "압축 문서가 안전 처리 한도를 초과했습니다.");
    }
    const nameStart = offset + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > centralOffset + centralSize) throw new DocumentError("CORRUPT_ARCHIVE", "압축 문서 구조가 유효하지 않습니다.");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(nameStart, nameStart + nameLength));
    if (name.includes("\\") || name.split("/").includes("..")) {
      throw new DocumentError("SECURITY_REJECTED", "안전하지 않은 압축 경로를 거부했습니다.");
    }
    names.push(name.toLowerCase());
    offset = next;
  }

  const required = kind === "xlsx" ? "xl/workbook.xml" : kind === "docx" ? "word/document.xml" : "ppt/presentation.xml";
  if (!names.includes(required)) {
    throw new DocumentError("FILE_SIGNATURE_MISMATCH", "파일 확장자와 실제 문서 형식이 일치하지 않습니다.");
  }
  if (names.some((name) => name.endsWith("vbaproject.bin") || name.includes("/externallinks/"))) {
    throw new DocumentError("SECURITY_REJECTED", "매크로 또는 외부 연결이 포함된 문서는 처리할 수 없습니다.");
  }
}

export function validateUploadBytes(kind: FileKind, bytes: Uint8Array): void {
  assertSizeWithinLimit(kind, bytes.byteLength);
  validateMagic(kind, bytes);
  if (kind === "xlsx" || kind === "docx" || kind === "pptx") validateZipStructure(kind, bytes);
}
