/// <reference lib="webworker" />
import "./worker-globals";
import { buildComparison } from "@/domain/compare";
import { buildAggregation } from "@/lib/aggregation/engine";
import { aggregationXlsxExport } from "@/lib/aggregation/export";
import { improvementBankExport } from "@/lib/aggregation/improvement-export";
import { improvementBackdataExport } from "@/lib/aggregation/pptx-export";
import { buildValueCheck } from "@/domain/value-check";
import type { NormalizedDocument, SourceRef } from "@/domain/document";
import { analyzeDocument, checkDocument, extractDocument } from "@/lib/deterministic";
import { exportDocumentCsv, exportDocumentXlsx } from "@/lib/export";
import { parseDocument } from "@/lib/parsers";
import { buildEvidenceNodes, groundAiResult } from "@/lib/ai/grounding";
import { askRelevance, selectEvidence } from "@/lib/ai/retrieval";
import { evidenceWindow, resolveClaims, type EvidenceWindow } from "@/lib/ai/prompt";
import { collectPolishCandidates } from "@/lib/polish/candidates";
import { autoExtract } from "@/lib/extract/auto";
import { extractRequestedFields } from "@/lib/extract/fields";
import { documentAnalysisTopics } from "@/lib/analysis-presentation";
import {
  DocumentError,
  assertWorkspaceWithinLimit,
  fileKindOf,
  safeDisplayName,
  validateUploadBytes,
} from "@/lib/upload";
import type { WorkerEnvelope, WorkerRequest, WorkspaceFile } from "./protocol";

/**
 * Parsed documents live only here, for the lifetime of this worker. A reload or
 * tab close destroys the worker and with it every byte of user content.
 */
interface StoredDocument {
  file: WorkspaceFile;
  document: NormalizedDocument;
}

const MAX_FILES = 10;
const documents = new Map<string, StoredDocument>();
/**
 * Prompt windows retained between `evidence` and `ground`. They hold canonical
 * evidence, so they stay in this worker and are dropped as soon as the AI
 * result is grounded or the caller releases them.
 */
const evidenceWindows = new Map<string, { window: EvidenceWindow; documents: NormalizedDocument[] }>();

/** Admitted input bytes currently held, used for the workspace budget. */
function workspaceBytes(): number {
  let total = 0;
  for (const entry of documents.values()) total += entry.file.size;
  return total;
}

function requireDocuments(fileIds: readonly string[]): StoredDocument[] {
  if (fileIds.length === 0) throw new DocumentError("NO_FILE_SELECTED", "파일을 1개 이상 선택하세요.");
  return fileIds.map((fileId) => {
    const stored = documents.get(fileId);
    if (!stored) throw new DocumentError("FILE_NOT_FOUND", "선택한 파일이 더 이상 메모리에 없습니다. 파일을 다시 추가하세요.");
    return stored;
  });
}

function combineDocuments(selected: readonly StoredDocument[]): NormalizedDocument {
  const [first] = selected;
  return {
    id: `export:${selected.map((entry) => entry.document.id).join(":")}`,
    fileId: "export",
    kind: first.document.kind,
    metadata: { fileName: selected.length === 1 ? first.file.name : "worklens-export.xlsx" },
    blocks: selected.flatMap((entry) => entry.document.blocks),
    warnings: selected.flatMap((entry) => entry.document.warnings),
  };
}

async function handle(request: WorkerRequest): Promise<unknown> {
  switch (request.kind) {
    case "parse": {
      if (documents.size >= MAX_FILES) {
        throw new DocumentError("WORKSPACE_FULL", `한 번에 최대 ${MAX_FILES}개 파일까지 다룰 수 있습니다.`);
      }
      const fileName = safeDisplayName(request.fileName);
      const kind = fileKindOf(fileName);
      const bytes = request.bytes;
      validateUploadBytes(kind, bytes);
      assertWorkspaceWithinLimit(workspaceBytes(), bytes.byteLength);
      const size = bytes.byteLength;
      const document = await parseDocument({ fileId: request.fileId, fileName, bytes });
      const file: WorkspaceFile = {
        id: request.fileId,
        name: fileName,
        kind,
        size,
        status: "ready",
        metadata: document.metadata,
        warnings: document.warnings,
      };
      documents.set(request.fileId, { file, document });
      return file;
    }
    case "analyze":
      return requireDocuments(request.fileIds).map((entry) => ({
        file: { id: entry.file.id, name: entry.file.name },
        analysis: analyzeDocument(entry.document),
        extraction: autoExtract(entry.document, { id: entry.file.id, name: entry.file.name }),
        topics: documentAnalysisTopics(entry.document),
      }));
    case "check":
      return requireDocuments(request.fileIds).map((entry) => ({
        file: { id: entry.file.id, name: entry.file.name },
        check: checkDocument(entry.document, { userTerms: request.userTerms ?? [], companyTerms: request.companyTerms }),
      }));
    case "extract":
      return requireDocuments(request.fileIds).map((entry) => ({
        file: { id: entry.file.id, name: entry.file.name },
        extraction: extractDocument(entry.document),
      }));
    case "compare": {
      if (request.baseFileId === request.targetFileId) {
        throw new DocumentError("COMPARE_REQUIRES_TWO_FILES", "비교하려면 서로 다른 파일 두 개를 선택하세요.");
      }
      const [base, target] = requireDocuments([request.baseFileId, request.targetFileId]);
      return buildComparison(base.document, target.document);
    }
    case "value-check": {
      if (request.fileIds.length < 2) {
        throw new DocumentError("VALUE_CHECK_REQUIRES_FILES", "값 일치 확인에는 파일을 두 개 이상 선택하세요.");
      }
      const files = requireDocuments(request.fileIds).map((entry) =>
        autoExtract(entry.document, { id: entry.file.id, name: entry.file.name }));
      return buildValueCheck(files);
    }
    case "aggregate":
      return buildAggregation(requireDocuments(request.fileIds).map((entry) => entry.document));
    case "aggregate-export": {
      const draft = buildAggregation(requireDocuments(request.fileIds).map((entry) => entry.document));
      const exported = await aggregationXlsxExport(draft, request.selection);
      return { fileName: exported.fileName, mimeType: exported.mimeType, bytes: exported.content };
    }
    case "aggregate-profile-export": {
      const documents = requireDocuments(request.fileIds).map((entry) => entry.document);
      const draft = buildAggregation(documents);
      const exported = request.format === "xlsx"
        ? await improvementBankExport(draft, request.selection, documents)
        : improvementBackdataExport(draft, request.selection, documents);
      return { fileName: exported.fileName, mimeType: exported.mimeType, bytes: exported.content };
    }
    case "export": {
      const selected = requireDocuments(request.fileIds);
      const combined = combineDocuments(selected);
      const exported = request.format === "csv"
        ? exportDocumentCsv(combined)
        : await exportDocumentXlsx(combined);
      const bytes = typeof exported.content === "string"
        ? new TextEncoder().encode(`\uFEFF${exported.content}`)
        : exported.content;
      return { fileName: exported.fileName, mimeType: exported.mimeType, bytes };
    }
    case "polish-candidates": {
      // Prose selection happens where the documents live; only the chosen
      // sentences and their canonical sources cross to the main thread.
      return requireDocuments(request.fileIds).map((entry) => ({
        file: { id: entry.file.id, name: entry.file.name },
        candidates: collectPolishCandidates(entry.document),
      }));
    }
    case "extract-structured": {
      // Deterministic pass only: the worker owns the documents, and whatever
      // it can read from structure never needs a model.
      const requested = request.fields ?? [];
      const files = requireDocuments(request.fileIds).map((entry) => {
        const file = { id: entry.file.id, name: entry.file.name };
        if (requested.length === 0) return autoExtract(entry.document, file);
        const plan = extractRequestedFields(entry.document, file, requested);
        return { ...plan.extraction, missing: plan.unresolved };
      });
      return {
        mode: requested.length === 0 ? "auto" : "fields",
        requestedFields: requested,
        files,
        summary: {
          fields: files.reduce((sum, entry) => sum + entry.fields.length, 0),
          missing: files.reduce((sum, entry) => sum + entry.missing.length, 0),
          records: files.reduce((sum, entry) => sum + entry.records.length, 0),
          lowConfidence: 0,
        },
      };
    }
    case "field-evidence": {
      // One field, one file: the model only ever sees the window that the
      // field's own wording retrieved.
      const [entry] = requireDocuments([request.fileId]);
      const candidates = buildEvidenceNodes([entry.document]);
      const window = evidenceWindow(selectEvidence(candidates, { operation: "ask", question: request.field }, { limit: 12 }));
      if (window.items.length === 0) {
        throw new DocumentError("NO_EVIDENCE", "해당 항목과 관련된 근거를 찾지 못했습니다.");
      }
      const windowId = crypto.randomUUID();
      evidenceWindows.set(windowId, { window, documents: [entry.document] });
      return { windowId, items: window.items, candidates: candidates.length };
    }
    case "field-source": {
      const retained = evidenceWindows.get(request.windowId);
      if (!retained) throw new DocumentError("EVIDENCE_EXPIRED", "AI 근거 창이 만료되었습니다. 다시 실행하세요.");
      const sources = request.handles
        .map((handle) => retained.window.nodes.get(handle.toUpperCase())?.source)
        .filter((source): source is SourceRef => Boolean(source));
      return { sources };
    }
    case "evidence": {
      const selected = requireDocuments(request.fileIds).map((entry) => entry.document);
      const candidates = buildEvidenceNodes(selected);
      // Ask carries a strict answerability scope. Brief focus text is only a
      // ranking hint, so a missing focus match still produces a global summary.
      if (request.request.operation === "ask" && !askRelevance(candidates, request.request.question).supported) {
        throw new DocumentError("NO_EVIDENCE", "질문을 뒷받침할 근거를 선택한 문서에서 찾지 못했습니다.");
      }
      const window = evidenceWindow(selectEvidence(candidates, request.request));
      if (window.items.length === 0) {
        throw new DocumentError("NO_EVIDENCE", "선택한 문서에서 사용할 수 있는 근거를 찾지 못했습니다.");
      }
      const windowId = crypto.randomUUID();
      evidenceWindows.set(windowId, { window, documents: selected });
      return { windowId, items: window.items, candidates: candidates.length };
    }
    case "ground": {
      const retained = evidenceWindows.get(request.windowId);
      if (!retained) throw new DocumentError("EVIDENCE_EXPIRED", "AI 근거 창이 만료되었습니다. 다시 실행하세요.");
      evidenceWindows.delete(request.windowId);
      return groundAiResult(request.request, retained.documents, resolveClaims(retained.window, request.claims));
    }
    case "release-evidence": {
      evidenceWindows.delete(request.windowId);
      return { released: evidenceWindows.size };
    }
    case "forget": {
      for (const fileId of request.fileIds) documents.delete(fileId);
      return { released: documents.size };
    }
  }
}

self.addEventListener("message", (event: MessageEvent<{ id: string; request: WorkerRequest }>) => {
  const { id, request } = event.data;
  void handle(request).then(
    (data) => {
      const transfer = data instanceof Object && "bytes" in data && data.bytes instanceof Uint8Array
        ? [data.bytes.buffer as ArrayBuffer]
        : [];
      const envelope: WorkerEnvelope = { id, ok: true, data };
      self.postMessage(envelope, transfer);
    },
    (error: unknown) => {
      const failure = error instanceof DocumentError
        ? { code: error.code, message: error.message }
        : {
            code: "DOCUMENT_FAILED",
            message: error instanceof Error && error.message ? error.message : "파일을 처리하지 못했습니다.",
          };
      const envelope: WorkerEnvelope = { id, ok: false, error: failure };
      self.postMessage(envelope);
    },
  );
});
