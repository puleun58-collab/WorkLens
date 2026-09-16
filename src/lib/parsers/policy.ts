import type { FileKind } from "@/domain/document";

const MiB = 1024 * 1024;

/**
 * Admission policy for the browser parser. These are input ceilings only: a
 * file inside the ceiling can still be refused by a parser's structural limits
 * (rows, ZIP entries, uncompressed XML), which are enforced separately so file
 * size never implies a document is safe to expand.
 */
export const MAX_CONFIGURED_FILE_BYTES = 100 * MiB;

/** Per-format input ceiling. Uniform: the parsers bound work, not bytes. */
export const FORMAT_INPUT_LIMITS: Readonly<Record<FileKind, number>> = {
  csv: 100 * MiB,
  docx: 100 * MiB,
  pptx: 100 * MiB,
  xlsx: 100 * MiB,
  pdf: 100 * MiB,
};

/**
 * The file was admissible by size, but expanding it would exceed a structural
 * budget (rows, columns, ZIP entries, uncompressed XML). It is a distinct
 * outcome from a corrupt file, and parsers must not flatten it into one.
 */
export class StructureLimitError extends Error {
  constructor() {
    super("파일 크기는 허용 범위이지만 문서 구조가 안전 처리 한도를 초과했습니다.");
    this.name = "StructureLimitError";
  }
}

/**
 * Total admitted bytes held by one workspace. Ten files at the per-file
 * ceiling would be 1 GiB of originals in tab memory, so the workspace carries
 * its own budget alongside the file-count limit.
 */
export const MAX_WORKSPACE_INPUT_BYTES = 300 * MiB;

const configured = Number(globalThis.process?.env?.WORKLENS_MAX_FILE_BYTES ?? MAX_CONFIGURED_FILE_BYTES);
if (!Number.isSafeInteger(configured) || configured <= 0 || configured > MAX_CONFIGURED_FILE_BYTES) {
  throw new Error("WORKLENS_MAX_FILE_BYTES must be a positive integer no greater than 100 MiB.");
}

export function inputLimitFor(kind: FileKind): number {
  return Math.min(configured, FORMAT_INPUT_LIMITS[kind]);
}
