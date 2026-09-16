import type { AiAvailableResult, AiRequest } from "@/domain/ai";
import type { ComparisonResult } from "@/domain/compare";
import type { DocumentMetadata, FileKind } from "@/domain/document";
import type { EvidenceItem, ModelClaim } from "@/lib/ai/prompt";
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

/**
 * `evidence` ranks and bounds the prompt window inside the worker that already
 * owns the documents, so only a compact handle/text payload crosses threads.
 * `ground` takes the model's handle-level claims back and rebuilds canonical
 * SourceRefs from the retained window.
 */
export type WorkerRequest =
  | { kind: "parse"; fileId: string; fileName: string; bytes: Uint8Array }
  | { kind: "analyze"; fileIds: string[] }
  | { kind: "check"; fileIds: string[]; userTerms?: string[]; companyTerms?: string[] }
  | { kind: "extract"; fileIds: string[] }
  | { kind: "compare"; baseFileId: string; targetFileId: string }
  | { kind: "export"; fileIds: string[]; format: ExportFormat }
  | { kind: "evidence"; fileIds: string[]; request: AiRequest }
  | { kind: "ground"; windowId: string; request: AiRequest; claims: ModelClaim[] }
  | { kind: "release-evidence"; windowId: string }
  | { kind: "forget"; fileIds: string[] };

export interface EvidencePayload {
  windowId: string;
  items: EvidenceItem[];
  /** Candidates considered before ranking; surfaced for diagnostics only. */
  candidates: number;
}

export interface WorkerResultMap {
  parse: WorkspaceFile;
  analyze: AnalyzeEntry[];
  check: CheckEntry[];
  extract: ExtractEntry[];
  compare: ComparisonResult;
  export: ExportedDocument;
  evidence: EvidencePayload;
  ground: AiAvailableResult;
  "release-evidence": { released: number };
  forget: { released: number };
}

export interface WorkerFailure {
  code: string;
  message: string;
}

export type WorkerEnvelope =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: WorkerFailure };
