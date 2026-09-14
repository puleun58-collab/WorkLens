import type { FileKind } from "@/domain/document";

const MiB = 1024 * 1024;

export const FORMAT_INPUT_LIMITS: Readonly<Record<FileKind, number>> = {
  csv: 10 * MiB,
  docx: 20 * MiB,
  pptx: 20 * MiB,
  xlsx: 50 * MiB,
  pdf: 50 * MiB,
};

const configured = Number(globalThis.process?.env?.WORKLENS_MAX_FILE_BYTES ?? 50 * MiB);
if (!Number.isSafeInteger(configured) || configured <= 0 || configured > 50 * MiB) {
  throw new Error("WORKLENS_MAX_FILE_BYTES must be a positive integer no greater than 50 MiB.");
}

export function inputLimitFor(kind: FileKind): number {
  return Math.min(configured, FORMAT_INPUT_LIMITS[kind]);
}
