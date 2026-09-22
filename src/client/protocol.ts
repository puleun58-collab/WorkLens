import type { AiAvailableResult, AiRequest } from "@/domain/ai";
import type { AggregationDraft, AggregationSelection } from "@/domain/aggregation";
import type { ComparisonResult } from "@/domain/compare";
import type { DocumentMetadata, FileKind, SourceRef } from "@/domain/document";
import type { FileExtraction, StructuredExtract } from "@/domain/extract";
import type { ValueCheckResult } from "@/domain/value-check";
import type { PolishCandidate } from "@/domain/polish";
import type { EvidenceItem, ModelClaim } from "@/lib/ai/prompt";
import type { AnalyzeResult, CheckResult, DocumentTopic, ExportFormat, ExtractResult } from "@/domain/operations";

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

export interface AnalyzeEntry { file: { id: string; name: string }; analysis: AnalyzeResult; extraction: FileExtraction; topics: DocumentTopic[] }
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
  | { kind: "value-check"; fileIds: string[] }
  | { kind: "export"; fileIds: string[]; format: ExportFormat }
  | { kind: "aggregate"; fileIds: string[] }
  | { kind: "aggregate-export"; fileIds: string[]; selection: AggregationSelection }
  | { kind: "aggregate-profile-export"; fileIds: string[]; selection: AggregationSelection; format: "xlsx" | "pptx" }
  | { kind: "polish-candidates"; fileIds: string[] }
  /** Deterministic structured extraction; `fields` switches to request mode. */
  | { kind: "extract-structured"; fileIds: string[]; fields?: string[] }
  /** Bounded evidence window for one requested field of one file. */
  | { kind: "field-evidence"; fileId: string; field: string }
  | { kind: "evidence"; fileIds: string[]; request: AiRequest; compare?: { baseFileId: string; targetFileId: string } }
  | { kind: "field-source"; windowId: string; handles: string[] }
  | { kind: "ground"; windowId: string; request: AiRequest; claims: ModelClaim[] }
  | { kind: "release-evidence"; windowId: string }
  | { kind: "forget"; fileIds: string[] };

export interface EvidencePayload {
  windowId: string;
  items: EvidenceItem[];
  /** Candidates considered before ranking; surfaced for diagnostics only. */
  candidates: number;
}

/** Prose selected for polishing, with the file it belongs to. */
export interface PolishCandidateEntry {
  file: { id: string; name: string };
  candidates: PolishCandidate[];
}

export interface WorkerResultMap {
  parse: WorkspaceFile;
  analyze: AnalyzeEntry[];
  check: CheckEntry[];
  extract: ExtractEntry[];
  export: ExportedDocument;
  aggregate: AggregationDraft;
  "aggregate-export": ExportedDocument;
  "aggregate-profile-export": ExportedDocument;
  compare: ComparisonResult;
  "value-check": ValueCheckResult;
  "polish-candidates": PolishCandidateEntry[];
  "extract-structured": StructuredExtract;
  "field-evidence": EvidencePayload;
  "field-source": { sources: SourceRef[] };
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
