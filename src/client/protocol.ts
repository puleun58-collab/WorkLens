import type { ComparisonResult } from "@/domain/compare";
import type { DocumentMetadata, FileKind, NormalizedDocument } from "@/domain/document";
import type { AnalyzeResult, CheckResult, ExportFormat, ExtractResult } from "@/domain/operations";

/** Everything the UI knows about a file. The bytes never leave the worker. */
export interface WorkspaceFile {
  id: string;
  name: string;
  kind: FileKind;
  size: number;
  status: "ready";
  metadata: DocumentMetadata;
  warnings: string[];
}

export interface AnalyzeEntry { file: { id: string; name: string }; analysis: AnalyzeResult }
export interface CheckEntry { file: { id: string; name: string }; check: CheckResult }
export interface ExtractEntry { file: { id: string; name: string }; extraction: ExtractResult }

export interface ExportedDocument {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export type WorkerRequest =
  | { kind: "parse"; fileId: string; fileName: string; bytes: Uint8Array }
  | { kind: "analyze"; fileIds: string[] }
  | { kind: "check"; fileIds: string[]; userTerms?: string[] }
  | { kind: "extract"; fileIds: string[] }
  | { kind: "compare"; baseFileId: string; targetFileId: string }
  | { kind: "export"; fileIds: string[]; format: ExportFormat }
  | { kind: "documents"; fileIds: string[] }
  | { kind: "forget"; fileIds: string[] };

export interface WorkerResultMap {
  parse: WorkspaceFile;
  analyze: AnalyzeEntry[];
  check: CheckEntry[];
  extract: ExtractEntry[];
  compare: ComparisonResult;
  export: ExportedDocument;
  documents: NormalizedDocument[];
  forget: { released: number };
}

export interface WorkerFailure {
  code: string;
  message: string;
}

export type WorkerEnvelope =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: WorkerFailure };
