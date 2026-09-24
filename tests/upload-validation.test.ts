import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import type { FileKind } from "@/domain/document";
import { MAX_WORKSPACE_INPUT_BYTES, inputLimitFor } from "@/lib/parsers/policy";
import {
  DocumentError,
  XLSX_EXTERNAL_REFERENCE_VALUE_ONLY,
  XLSX_MACRO_IGNORED,
  assertSizeWithinLimit,
  assertWorkspaceWithinLimit,
  fileKindOf,
  safeDisplayName,
  validateUploadBytes,
} from "@/lib/upload";

function rejects(action: () => unknown, code: string, message: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentError);
    expect(error).toMatchObject({ code, message });
  }
}

function archive(entries: Record<string, Uint8Array>): Uint8Array {
  return zipSync(entries, { level: 0 });
}

function centralDirectory(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function centralOffset(bytes: Uint8Array): number {
  return centralDirectory(bytes).getUint32(bytes.length - 22 + 16, true);
}

describe("upload admission", () => {
  it("recognizes supported case-insensitive extensions and maps macro workbooks without accepting lookalikes", () => {
    expect(fileKindOf("rates.XLSM")).toBe("xlsx");
    expect(fileKindOf("draft.PdF")).toBe("pdf");
    expect(fileKindOf("report.pptx")).toBe("pptx");
    rejects(() => fileKindOf("report.pdf.exe"), "FILE_TYPE_UNSUPPORTED", "지원하지 않는 파일 형식입니다.");
    try {
      fileKindOf("report");
      throw new Error("Expected unsupported extension");
    } catch (error) {
      expect(error).toMatchObject({ code: "FILE_TYPE_UNSUPPORTED", detail: "XLSX, XLSM, CSV, PDF, DOCX, PPTX 파일을 업로드해 주세요." });
    }
  });

  it("removes path and control characters from display names, rejecting empty, traversal and overlong names", () => {
    expect(safeDisplayName(" C:\\folder\\\u0000report.pdf \n")).toBe("report.pdf");
    expect(safeDisplayName("/tmp/ＡＢＣ.csv")).toBe("ABC.csv");
    for (const invalid of ["   ", "C:\\folder\\..", "./.", "x".repeat(241)]) {
      rejects(() => safeDisplayName(invalid), "FILE_NAME_INVALID", "파일 이름이 유효하지 않습니다.");
    }
    expect(safeDisplayName("x".repeat(240))).toHaveLength(240);
  });

  it("rejects non-positive or unrepresentable byte counts before size ceiling checks", () => {
    for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      rejects(() => assertSizeWithinLimit("csv", size), "EMPTY_FILE", "업로드할 파일이 비어 있습니다.");
    }
  });

  it("admits exactly the format ceiling and explains the excess in MB for every format", () => {
    for (const kind of ["csv", "pdf", "xlsx", "docx", "pptx"] as const satisfies readonly FileKind[]) {
      const limit = inputLimitFor(kind);
      expect(() => assertSizeWithinLimit(kind, limit)).not.toThrow();
      rejects(() => assertSizeWithinLimit(kind, limit + 1), "FILE_TOO_LARGE", `이 파일은 최대 ${Math.floor(limit / 1024 / 1024)} MB까지 처리할 수 있습니다.`);
    }
  });

  it("keeps total workspace admission separate from the single-file ceiling", () => {
    expect(() => assertWorkspaceWithinLimit(MAX_WORKSPACE_INPUT_BYTES - 10, 10)).not.toThrow();
    rejects(() => assertWorkspaceWithinLimit(MAX_WORKSPACE_INPUT_BYTES - 10, 11), "WORKSPACE_SIZE_LIMIT", `현재 작업 공간에 추가할 수 있는 총 파일 용량(${Math.floor(MAX_WORKSPACE_INPUT_BYTES / 1024 / 1024)} MB)을 초과합니다. 사용하지 않는 파일을 삭제한 뒤 다시 시도하세요.`);
  });

  it("rejects empty uploads before content sniffing and misleading PDF signatures", () => {
    rejects(() => validateUploadBytes("pdf", new Uint8Array()), "EMPTY_FILE", "업로드할 파일이 비어 있습니다.");
    rejects(() => validateUploadBytes("pdf", strToU8("not a pdf")), "FILE_SIGNATURE_MISMATCH", "파일 확장자와 실제 내용이 일치하지 않습니다.");
    expect(validateUploadBytes("pdf", strToU8("%PDF-1.7"))).toEqual([]);
  });

  it("requires CSV UTF-8 text without NUL bytes, not merely a .csv suffix", () => {
    expect(validateUploadBytes("csv", strToU8("열,값\n이름,홍길동"))).toEqual([]);
    for (const bytes of [new Uint8Array([0xff, 0xfe]), new Uint8Array([65, 0, 66])]) {
      rejects(() => validateUploadBytes("csv", bytes), "FILE_SIGNATURE_MISMATCH", "파일 확장자와 실제 내용이 일치하지 않습니다.");
    }
  });

  it("rejects a ZIP under the wrong document extension and a false ZIP header", () => {
    const workbook = archive({ "xl/workbook.xml": strToU8("<workbook/>") });
    rejects(() => validateUploadBytes("docx", workbook), "FILE_SIGNATURE_MISMATCH", "파일 확장자와 실제 문서 형식이 일치하지 않습니다.");
    rejects(() => validateUploadBytes("pptx", strToU8("PK\\x03\\x04broken")), "FILE_SIGNATURE_MISMATCH", "파일 확장자와 실제 내용이 일치하지 않습니다.");
    expect(validateUploadBytes("xlsx", workbook)).toEqual([]);
    expect(validateUploadBytes("pptx", archive({ "ppt/presentation.xml": strToU8("<presentation/>") }))).toEqual([]);
    expect(validateUploadBytes("docx", archive({ "word/document.xml": strToU8("<document/>") }))).toEqual([]);
  });

  it("warns about inactive macros and external-link stored values without rejecting the workbook", () => {
    const workbook = archive({
      "xl/workbook.xml": strToU8("<workbook/>"),
      "xl/vbaProject.bin": new Uint8Array([1]),
      "xl/externalLinks/externalLink1.xml": strToU8("<externalLink/>"),
    });
    expect(validateUploadBytes("xlsx", workbook)).toEqual([XLSX_MACRO_IGNORED, XLSX_EXTERNAL_REFERENCE_VALUE_ONLY]);
  });

  it("refuses archive traversal before a parser can access the package", () => {
    const zip = archive({ "word/document.xml": strToU8("<document/>"), "word/../evil.xml": strToU8("bad") });
    rejects(() => validateUploadBytes("docx", zip), "SECURITY_REJECTED", "안전하지 않은 압축 경로를 거부했습니다.");
  });

  it("distinguishes missing ZIP directory, unsafe entry count, corrupted directory, ZIP64 and excessive expansion", () => {
    rejects(() => validateUploadBytes("xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])), "CORRUPT_ARCHIVE", "압축 문서 구조가 유효하지 않습니다.");
    const original = archive({ "xl/workbook.xml": strToU8("<workbook/>") });
    const tooManyEntries = original.slice();
    centralDirectory(tooManyEntries).setUint16(tooManyEntries.length - 22 + 10, 10_001, true);
    rejects(() => validateUploadBytes("xlsx", tooManyEntries), "PARSER_LIMIT", "압축 문서가 안전 처리 한도를 초과했습니다.");
    const truncated = original.slice();
    centralDirectory(truncated).setUint32(centralOffset(truncated), 0, true);
    rejects(() => validateUploadBytes("xlsx", truncated), "CORRUPT_ARCHIVE", "압축 문서 구조가 유효하지 않습니다.");

    const zip64 = original.slice();
    centralDirectory(zip64).setUint32(centralOffset(zip64) + 24, 0xffffffff, true);
    rejects(() => validateUploadBytes("xlsx", zip64), "PARSER_LIMIT", "ZIP64 문서는 지원하지 않습니다.");

    const bomb = original.slice();
    centralDirectory(bomb).setUint32(centralOffset(bomb) + 24, 501 * 1024 * 1024, true);
    rejects(() => validateUploadBytes("xlsx", bomb), "PARSER_LIMIT", "압축 문서가 안전 처리 한도를 초과했습니다.");
  });
});
