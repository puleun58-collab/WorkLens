"use client";

import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import type { AiAvailableResult, AiRequest, GroundedClaim } from "@/domain/ai";
import type { ComparisonItem, ComparisonResult } from "@/domain/compare";
import {
  AGGREGATION_UNSUPPORTED_DETAIL,
  AGGREGATION_UNSUPPORTED_TITLE,
  isAggregationFileKind,
  type AggregationDraft,
  type AggregationFieldMapping,
  type AggregationRecord,
  type AggregationSelection,
  type AggregationSheet,
  type AggregationTarget,
} from "@/domain/aggregation";
import { mappedFields, mappedImageCount, primaryRegion, sequenceCells, targetCell, type SequenceCells } from "@/lib/aggregation/values";
import type { ValueCheckResult, ValueCheckStatus } from "@/domain/value-check";
import type { DocumentMetadata, SourceRef } from "@/domain/document";
import {
  checkCategoryGroup,
  type CheckCategory,
  type CheckCategoryGroup,
  type CheckFinding,
  type CheckResult,
  type CheckSeverity,
  type ExtractResult,
} from "@/domain/operations";
import { WorkLensLogo } from "./worklens-logo";
import { disposeWorkspace, runInWorker } from "@/client/document-client";
import {
  aiFailureDetail,
  extractServerAi,
  generateServerAi,
  interruptServerAi,
  logAiFailure,
  polishServerAi,
  SERVER_AI_MESSAGES,
  type ServerAiFailure,
} from "@/client/server-ai-client";
import { SERVER_AI_MAX_FILES, type ServerAiErrorCode } from "@/lib/ai/api";
import type { AnalyzeEntry as WorkerAnalyzeEntry, CheckEntry as WorkerCheckEntry, WorkspaceFile } from "@/client/protocol";
import {
  EXTRACT_MODE_LABELS,
  EXTRACT_TYPE_LABELS,
  type ExtractConfidence,
  type ExtractMode,
  type StructuredExtract,
} from "@/domain/extract";
import { structuredCsvExport, structuredXlsxExport } from "@/lib/extract/export";
import { valueCheckCsvExport, valueCheckXlsxExport } from "@/lib/value-check-export";
import { comparisonCsvExport, comparisonXlsxExport } from "@/lib/comparison-export";
import { modelField } from "@/lib/extract/fields";
import { withResolvedField } from "@/lib/extract/merge";
import {
  POLISH_MODES,
  POLISH_MODE_LABELS,
  POLISH_REJECTION_LABELS,
  type PolishCandidate,
  type PolishMode,
  type PolishOutcome,
  type PolishResult,
  type PolishSummary,
  type PolishTextResult,
} from "@/domain/polish";
import { polishResult, polishTextResult, reviewProposal } from "@/lib/polish/engine";
import {
  POLISH_TEXT_MAX_CHARS,
  POLISH_TEXT_TOO_LONG_MESSAGE,
  splitPolishText,
} from "@/lib/polish/text-input";
import {
  addUserTerm,
  clearUserTerms,
  readIgnoredRules,
  readUserTerms,
  removeUserTerm,
  toggleIgnoredRule,
} from "@/client/user-dictionary";
import companyTermFile from "@/config/company-terms.json";
import { sortFindings } from "@/lib/check/merge";
import { mergeSemanticFindings, semanticFindings } from "@/lib/check/writing/semantic-review";
import {
  analysisClaimPresentation,
  claimDisplayText,
  confirmedAnalysisItems,
  confirmedAnalysisMetrics,
} from "@/lib/analysis-presentation";
import {
  BarChart3,
  BookMarked,
  CircleHelp,
  FileText,
  GitCompareArrows,
  Image as ImageIcon,
  Layers3,
  MessageSquareText,
  PenLine,
  ShieldCheck,
  SlidersHorizontal,
  Table2,
  Scale,
  ArrowUpDown,
} from "lucide-react";

const PdfTool = dynamic(() => import("@/components/tools/PdfTool").then((module) => module.PdfTool), {
  loading: () => <p role="status">PDF 도구를 불러오는 중…</p>,
});
const ImageTool = dynamic(() => import("@/components/tools/ImageTool").then((module) => module.ImageTool), {
  loading: () => <p role="status">이미지 도구를 불러오는 중…</p>,
});
const LawSearch = dynamic(() => import("@/components/research/LawSearch").then((module) => module.LawSearch), {
  loading: () => <p role="status">법령 검색을 불러오는 중…</p>,
});
const UsageGuide = dynamic(() => import("@/components/guide/UsageGuide").then((module) => module.UsageGuide), {
  loading: () => <p role="status">사용 가이드를 불러오는 중…</p>,
});

type ToolView = "PdfTools" | "ImageTools";
type ShellView = Tab | ToolView | "Law" | "Guide" | "Dictionary" | "Settings";
export interface CompanyTermEntry { id: number; term: string; description: string | null; active: boolean }
const tabIcons: Record<Tab, typeof BarChart3> = {
  Analyze: BarChart3,
  Ask: MessageSquareText,
  Compare: GitCompareArrows,
  Check: ShieldCheck,
  Polish: PenLine,
  Extract: Table2,
  Aggregate: Layers3,
};
type ApiError = { code: string; message: string; detail?: string; retryable?: boolean };
/**
 * Warning codes are how the pipeline talks to itself. What a reader needs is
 * the consequence: which parts of the file were read, and which were left out.
 */
const WARNING_MESSAGES: Record<string, string> = {
  XLSX_MACRO_IGNORED: "외부 연결 또는 매크로는 실행하지 않고 저장된 값만 사용합니다.",
  XLSX_EXTERNAL_REFERENCE_VALUE_ONLY: "외부 연결 또는 매크로는 실행하지 않고 저장된 값만 사용합니다.",
  XLSX_EXTERNAL_REFERENCE_NO_CACHE: "일부 연결된 값은 파일에 저장된 결과가 없어 제외되었습니다.",
  XLSX_FORMULA_VALUE_ONLY: "수식은 계산하지 않고 파일에 저장된 결과만 사용합니다.",
  XLSX_HIDDEN_SHEET_OMITTED: "숨김 시트는 분석 대상에서 제외했습니다.",
  DOCX_IMAGE_OMITTED: "이미지 안의 내용은 읽지 않습니다.",
  PPTX_IMAGE_OMITTED: "이미지 안의 내용은 읽지 않습니다.",
  PPTX_CHART_OMITTED: "차트 안의 값은 읽지 않습니다.",
  PPTX_SPEAKER_NOTES_OMITTED: "발표자 노트는 읽지 않습니다.",
  PDF_SCANNED_PAGE: "스캔된 페이지의 글자는 읽지 않습니다.",
};
const warningText = (codes: readonly string[]): string =>
  [...new Set(codes.map((code) => WARNING_MESSAGES[code] ?? "일부 내용은 분석 대상에서 제외했습니다."))].join("\n");
/**
 * A status message belongs to whatever produced it. `workspace` messages
 * concern the tab as a whole — an upload, a workspace-wide failure — and are
 * shown everywhere; anything else is owned by the view that raised it and is
 * never carried into another feature, the dictionary or the settings page.
 */
type NoticeScope = "workspace" | ShellView;
/**
 * `code` is carried only so the notice can choose its own wording: an AI
 * start-up failure is a different sentence from a task that failed, and
 * matching on message text to tell them apart is guesswork.
 */
type Notice = { tone: "error" | "success" | "info" | "warning"; message: string; scope: NoticeScope; code?: ServerAiErrorCode; detail?: string;
  /** Announced to assistive tech only: the screen already shows the outcome (e.g. the new file row with READY). */
  srOnly?: boolean };

/*
 * A notice already says what happened in the words of the feature that raised
 * it, so the panel never adds a second sentence with the same meaning: the
 * title carries the state and the body only appears when there is a next step.
 */
const tabs = ["Analyze", "Ask", "Compare", "Check", "Polish", "Extract", "Aggregate"] as const;
type Tab = (typeof tabs)[number];
const tabMeta: Record<Tab, { label: string; description: string }> = {
  Analyze: { label: "분석", description: "구조와 수치" },
  Ask: { label: "질문", description: "파일에 질문" },
  Compare: { label: "비교", description: "버전 차이" },
  Check: { label: "검수", description: "품질과 위험" },
  Polish: { label: "윤문", description: "문장 윤문" },
  Extract: { label: "추출", description: "데이터 추출" },
  Aggregate: { label: "취합", description: "다중 파일 취합" },
};
const completionLabels: Record<Tab, string> = {
  Analyze: "분석 완료",
  Ask: "답변 완료",
  Compare: "비교 완료",
  Check: "검수 완료",
  Polish: "윤문 완료",
  Extract: "추출 완료",
  Aggregate: "취합 완료",
};
type ResultStatus = { tone: "success" | "warning"; label: string; message?: string; detail?: string };
/*
 * One label for the primary action in every feature. The visible word is
 * always 실행 — the destination already says what runs — and the accessible
 * name keeps the feature so a screen reader is not left with seven identical
 * buttons.
 */
const RUN_LABEL = "실행";
const categoryLabels: Record<ComparisonItem["category"], string> = {
  Added: "추가",
  Removed: "삭제",
  Changed: "변경",
  "Structural Change": "구조 변경",
  "Important Change": "중요 변경",
};
const valueCheckStatusLabels: Record<ValueCheckStatus, string> = {
  different: "값 차이",
  partial: "일부 파일만 확인",
  consistent: "일치",
};
type ValueCheckFilter = "all" | ValueCheckStatus;
const severityLabels: Record<CheckFinding["severity"], string> = {
  critical: "중요",
  warning: "주의",
  suggestion: "제안",
};
const extractConfidenceLabels: Record<ExtractConfidence, string> = {
  high: "높음",
  medium: "보통",
  low: "낮음",
};
const checkCategoryLabels: Record<CheckCategory, string> = {
  spelling: "맞춤법",
  grammar: "문법",
  wording: "문장",
  terminology: "용어",
  duplication: "중복",
  formatting: "표기",
  numeric: "수치",
  date: "날짜",
  unit: "단위",
  total: "합계",
  privacy: "개인정보·보안정보",
  structure: "구조",
  placeholder: "미완성 문구",
};
const checkGroupLabels: Record<CheckCategoryGroup, string> = {
  writing: "문장",
  consistency: "일관성",
  data: "데이터",
  privacy: "개인정보·보안정보",
};


/**
 * Hydration as a read, not as state written from an effect: the store never
 * changes, so the only transition is the server snapshot giving way to the
 * client one when this tree becomes interactive. The three callbacks are
 * module constants because `useSyncExternalStore` compares them by identity —
 * inline literals would resubscribe on every render.
 */
const subscribeNothing = () => () => undefined;
const clientHydrated = () => true;
const serverHydrated = () => false;

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}
function displayValue(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined || value === "") return "없음";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}
function RecommendationText({ text, suggestedText }: { text: string; suggestedText?: string }) {
  const core = suggestedText?.trim();
  if (!core) return text;
  const index = text.indexOf(core);
  if (index < 0) return text;
  return <>{text.slice(0, index)}<strong>{core}</strong>{text.slice(index + core.length)}</>;
}
function structureCounts(metadata: DocumentMetadata): { label: string; value: string }[] {
  const counts: { label: string; value: string }[] = [];
  if (typeof metadata.pageCount === "number") counts.push({ label: "페이지/슬라이드", value: String(metadata.pageCount) });
  if (metadata.sheets?.length) {
    counts.push({ label: "시트", value: String(metadata.sheets.length) });
    counts.push({ label: "행", value: String(metadata.sheets.reduce((sum, sheet) => sum + sheet.rowCount, 0)) });
  }
  return counts;
}
function isSourceRef(value: unknown): value is SourceRef {
  return typeof value === "object" && value !== null && typeof (value as SourceRef).fileId === "string" && typeof (value as SourceRef).nodeId === "string" && typeof (value as SourceRef).label === "string";
}
function failedPolishOutcome(candidate: PolishCandidate, error: unknown): PolishOutcome {
  const failure = error as Partial<ServerAiFailure>;
  return {
    id: candidate.id,
    status: "failed",
    originalText: candidate.text,
    revisedText: candidate.text,
    reasons: [],
    ...(candidate.source ? { source: candidate.source } : {}),
    origin: candidate.origin,
    failure: {
      ...(failure.code ? { code: failure.code } : {}),
      message: failure.message ?? "윤문 처리를 완료하지 못했습니다.",
    },
  };
}


type SourceRole = "base" | "current";
/**
 * The inspector always receives the full set a result row summarised, each
 * source with its own role so a comparison stays readable entry by entry.
 */
type DetailEntry = {
  source: SourceRef;
  role?: SourceRole;
  context?: { issue: string; recommendation: string };
};
type DetailInfo = { entries: readonly DetailEntry[] };


export default function Home() {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<Tab>("Analyze");
  const [shellView, setShellView] = useState<ShellView>("Analyze");
  const [companyTerms, setCompanyTerms] = useState<CompanyTermEntry[]>([]);
  const [companyTermsSource, setCompanyTermsSource] = useState<"d1" | "seed" | "pending">("pending");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** Bumped on each successful delete; drives a one-off "삭제 완료" that clears itself. */
  const [deleteDone, setDeleteDone] = useState(0);
  useEffect(() => {
    if (!deleteDone) return;
    const timer = window.setTimeout(() => setDeleteDone(0), 2500);
    return () => window.clearTimeout(timer);
  }, [deleteDone]);
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [compareIds, setCompareIds] = useState<{ baseFileId: string; targetFileId: string } | null>(null);
  const [compareMode, setCompareMode] = useState<"version" | "value-check">("version");
  const [valueCheck, setValueCheck] = useState<ValueCheckResult | null>(null);
  const [enrichmentResult, setEnrichmentResult] = useState<AiAvailableResult | null>(null);
  const [extractMode, setExtractMode] = useState<ExtractMode>("auto");
  const [extractFields, setExtractFields] = useState<string[]>([]);
  const [structured, setStructured] = useState<StructuredExtract | null>(null);
  const [extractProgress, setExtractProgress] = useState<{ done: number; total: number } | null>(null);
  const [aggregation, setAggregation] = useState<AggregationDraft | null>(null);
  const [aggregationSelection, setAggregationSelection] = useState<AggregationSelection | null>(null);
  const extractCancelled = useRef(false);
  const [operationResult, setOperationResult] = useState<unknown>(null);
  const [detail, setDetail] = useState<DetailInfo | null>(null);
  const [question, setQuestion] = useState("");
  const [userTerms, setUserTerms] = useState<string[]>(readUserTerms);
  const [ignoredRules, setIgnoredRules] = useState<string[]>(readIgnoredRules);
  /**
   * Hydration signal. The markup is server-rendered, so a file set on the
   * upload input before the client takes over drops its change event and
   * nothing is parsed. The server snapshot is `false` and the client snapshot
   * `true`, so `data-hydrated` flips exactly when this tree is interactive.
   */
  const hydrated = useSyncExternalStore(subscribeNothing, clientHydrated, serverHydrated);
  const [polishMode, setPolishMode] = useState<PolishMode>("default");
  const [polish, setPolish] = useState<PolishResult | null>(null);
  const [polishProgress, setPolishProgress] = useState<{ done: number; total: number } | null>(null);
  const [polishInput, setPolishInput] = useState<"file" | "text">("file");
  const [polishText, setPolishText] = useState("");
  const [polishTextRun, setPolishTextRun] = useState<PolishTextResult | null>(null);
  const polishCancelled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadQueue = useRef<Promise<void>>(Promise.resolve());
  const detailTrigger = useRef<HTMLElement | null>(null);
  const primaryRunInFlight = useRef(false);

  const openSource = useCallback((entries: readonly DetailEntry[], trigger: HTMLElement | null) => {
    detailTrigger.current = trigger;
    setDetail({ entries });
  }, []);
  const closeSource = useCallback(() => {
    const trigger = detailTrigger.current;
    detailTrigger.current = null;
    setDetail(null);
    if (trigger) window.requestAnimationFrame(() => trigger.focus());
  }, []);

  // Personal dictionary and ignored rules live in this browser only. Read lazily
  // so the server render stays empty and hydration has nothing to reconcile.
  // Company terms are central configuration served by /api/company-terms.
  // A failed read degrades to the seed list; Check keeps running either way.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/company-terms", { cache: "no-store" });
        const payload: unknown = await response.json();
        const data = payload && typeof payload === "object" && "data" in payload ? payload.data : null;
        if (cancelled || !data || typeof data !== "object" || !("terms" in data) || !Array.isArray(data.terms)) return;
        setCompanyTerms(data.terms as CompanyTermEntry[]);
        setCompanyTermsSource("source" in data && data.source === "d1" ? "d1" : "seed");
      } catch {
        if (!cancelled) setCompanyTermsSource("seed");
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const addTerm = useCallback((term: string) => setUserTerms(addUserTerm(term)), []);
  const removeTerm = useCallback((term: string) => setUserTerms(removeUserTerm(term)), []);
  const clearTerms = useCallback(() => setUserTerms(clearUserTerms()), []);
  const toggleRule = useCallback((ruleId: string) => setIgnoredRules(toggleIgnoredRule(ruleId)), []);

  /** Owned by the current view: navigating away retires it. */
  const notifyView = (tone: Notice["tone"], message: string, code?: ServerAiErrorCode, detail?: string) =>
    setNotice({ tone, message, scope: shellView, ...(code ? { code } : {}), ...(detail ? { detail } : {}) });
  /** Affects the whole tab — an upload or a workspace reset — so it follows. */
  const notifyWorkspace = (tone: Notice["tone"], message: string, detail?: string) =>
    setNotice({ tone, message, scope: "workspace", ...(detail ? { detail } : {}) });

  const clearResults = useCallback(() => {
    setOperationResult(null);
    setComparison(null);
    setCompareIds(null);
    setValueCheck(null);
    setEnrichmentResult(null);
    setAggregation(null);
    setAggregationSelection(null);
    setDetail(null);
    // Results and the message that announced them are one unit, so a
    // navigation or a change of selection retires both. A workspace-level
    // message outlives them: it is about the tab, not about this result.
    setNotice((current) => current?.scope === "workspace" ? current : null);
  }, []);

  useEffect(() => () => {
    disposeWorkspace();
    interruptServerAi();
  }, []);

  const upload = async (file: File) => {
    setUploading(true);
    notifyWorkspace("info", `${file.name}을(를) 분석 중입니다.`);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const summary = await runInWorker(
        { kind: "parse", fileId: crypto.randomUUID(), fileName: file.name, bytes },
        [bytes.buffer],
      );
      setFiles((current) => [...current, summary]);
      // The new row (name, READY, structure) is the visible confirmation; only assistive tech gets a sentence.
      setNotice({ tone: "success", message: `${file.name} 분석이 완료되었습니다.`, scope: "workspace", srOnly: true });
    } catch (error) {
      const failure = error as ApiError;
      notifyWorkspace("error", failure.message ?? "파일을 처리하지 못했습니다.", failure.detail);
    } finally {
      setUploading(false);
    }
  };

  const enqueueUploads = (list: FileList | null) => {
    for (const file of Array.from(list ?? [])) uploadQueue.current = uploadQueue.current.then(() => upload(file));
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropActive(false);
    enqueueUploads(event.dataTransfer.files);
  };
  const toggleFile = (id: string) => {
    setSelected((current) => current.includes(id) ? current.filter((fileId) => fileId !== id) : current.length < 10 ? [...current, id] : current);
    clearResults();
  };
  const allFilesSelected = files.length > 0 && selected.length === files.length;
  const someFilesSelected = selected.length > 0 && !allFilesSelected;
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someFilesSelected;
  }, [someFilesSelected]);
  const toggleAllFiles = () => {
    setSelected(allFilesSelected ? [] : files.map((file) => file.id));
    clearResults();
  };
  const swapComparisonDirection = () => {
    if (busy || compareMode !== "version" || selected.length !== 2) return;
    setSelected((current) => current.length === 2 ? [current[1], current[0]] : current);
    clearResults();
  };

  const runTextExtract = async () => {
    setBusy(true);
    setNotice(null);
    setDetail(null);
    try {
      const result = await runInWorker({ kind: "extract", fileIds: selected });
      setOperationResult(result);
      notifyView("success", "전체 텍스트를 준비했습니다.");
    } catch (error) {
      setOperationResult(null);
      notifyView("error", (error as ApiError).message ?? "작업에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Provider and grounding problems are implementation detail. The user is
   * told what happened to their work — not which stage of the pipeline failed
   * — while the diagnostic log keeps the exact code, operation and counts.
   */
  const noteAiDiagnostics = (error: unknown) => {
    logAiFailure(error);
    if ((error as Partial<ServerAiFailure>).code === "CANCELLED") notifyView("info", "작업을 취소했습니다.");
  };

  const reportAiFailure = (error: unknown, fallback: string) => {
    const failure = error as Partial<ServerAiFailure>;
    logAiFailure(error);
    if (failure.code === "CANCELLED") {
      notifyView("info", "작업을 취소했습니다.");
      return;
    }
    // Retrying only helps for transient provider states, so the second line
    // exists only then; every other failure stays a single sentence.
    const retryable = failure.code === "TIMEOUT"
      || failure.code === "RATE_LIMITED"
      || failure.code === "PROVIDER_UNAVAILABLE"
      || failure.code === "OPERATION_CAPACITY"
      || failure.code === "BUSY";
    notifyView("error", fallback, failure.code, retryable ? "잠시 후 다시 시도해 주세요." : undefined);
  };

  /**
   * The worker selects and bounds evidence; grounding remains authoritative in
   * the worker after the same-origin server returns model claims.
   *
   * Grounding is per claim, so the result of a run is per claim too: every
   * verified claim is kept and every unverifiable one is dropped. Only a model
   * answer where nothing at all could be grounded is a grounding failure; an
   * answer with no claims at all is the model abstaining, and each feature
   * decides what that means for its own result.
   */
  const generateGroundedResult = async (request: AiRequest, compare?: { baseFileId: string; targetFileId: string }, onStage?: (stage: "evidence" | "provider" | "ground", count: number, secondary?: number) => void): Promise<AiAvailableResult> => {
    let windowId: string | undefined;
    try {
      const evidence = await runInWorker({ kind: "evidence", fileIds: selected, request, ...(compare ? { compare } : {}) });
      windowId = evidence.windowId;
      onStage?.("evidence", evidence.candidates, evidence.items.length);
      if (evidence.items.length === 0) {
        throw {
          code: "NO_EVIDENCE",
          message: SERVER_AI_MESSAGES.NO_EVIDENCE,
          operation: "claims",
          occurredAt: new Date().toISOString(),
        } satisfies ServerAiFailure;
      }
      const claims = await generateServerAi(request, evidence.items);
      onStage?.("provider", claims.length);
      const result = await runInWorker({ kind: "ground", windowId, request, claims });
      windowId = undefined;
      onStage?.("ground", result.claims.length, result.rejectedClaimCount);
      if (process.env.NODE_ENV !== "production") console.info("[worklens] grounding", {
        operation: request.operation,
        acceptedClaimCount: result.claims.length,
        rejectedClaimCount: result.rejectedClaimCount,
      });
      if (result.claims.length === 0 && result.rejectedClaimCount > 0) {
        throw {
          code: "GROUNDING_REJECTED",
          message: SERVER_AI_MESSAGES.GROUNDING_REJECTED,
          operation: "claims",
          occurredAt: new Date().toISOString(),
        } satisfies ServerAiFailure;
      }
      return result;
    } finally {
      if (windowId) void runInWorker({ kind: "release-evidence", windowId });
    }
  };

  /** Ask needs a grounded answer; an empty answer is not a system error. */
  const runAsk = async () => {
    const empty = { message: "질문에 답할 내용을 찾지 못했습니다.", detail: "선택한 파일의 내용을 확인해 주세요." };
    if (selected.length > SERVER_AI_MAX_FILES) {
      notifyView("error", `한 번에 최대 ${SERVER_AI_MAX_FILES}개 파일까지 처리할 수 있습니다.`);
      return;
    }
    setBusy(true);
    setNotice(null);
    setDetail(null);
    try {
      const result = await generateGroundedResult({ operation: "ask", question: question.trim() });
      if (result.claims.length === 0) {
        setOperationResult(null);
        notifyView("warning", empty.message, undefined, empty.detail);
        return;
      }
      setOperationResult(result);
      notifyView("success", "질문 결과를 준비했습니다.");
      return result;
    } catch (error) {
      setOperationResult(null);
      const code = (error as Partial<ServerAiFailure>).code;
      if (code === "NO_EVIDENCE" || code === "GROUNDING_REJECTED") {
        logAiFailure(error);
        notifyView("warning", empty.message, undefined, empty.detail);
        return;
      }
      reportAiFailure(error, "질문을 처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Polish pipeline. The document worker selects prose and keeps the document;
   * the main thread sends one bounded candidate at a time to the server and
   * verifies every proposal deterministically before pairing canonical sources.
   */
  const runPolish = async () => {
    if (!selected.length) return;
    if (selected.length > SERVER_AI_MAX_FILES) {
      notifyView("error", `한 번에 최대 ${SERVER_AI_MAX_FILES}개 파일까지 처리할 수 있습니다.`);
      return;
    }
    setBusy(true);
    setNotice(null);
    setPolish(null);
    polishCancelled.current = false;
    try {
      const entries = await runInWorker({ kind: "polish-candidates", fileIds: selected });
      const candidates = entries.flatMap((entry) => entry.candidates);
      if (candidates.length === 0) {
        notifyView("info", "윤문할 문장을 찾지 못했습니다. 표와 수치 위주의 문서일 수 있습니다.");
        return;
      }
      setPolishProgress({ done: 0, total: candidates.length });
      const outcomes: PolishOutcome[] = [];
      let partialFailure: unknown = null;
      for (const [index, candidate] of candidates.entries()) {
        if (polishCancelled.current) {
          partialFailure = { code: "CANCELLED", message: SERVER_AI_MESSAGES.CANCELLED };
          outcomes.push(...candidates.slice(index).map((entry) => failedPolishOutcome(entry, partialFailure)));
          break;
        }
        try {
          const proposal = await polishServerAi(candidate.text, polishMode);
          outcomes.push(reviewProposal(candidate, proposal));
          setPolishProgress({ done: index + 1, total: candidates.length });
          setPolish(polishResult(polishMode, outcomes));
        } catch (error) {
          partialFailure = error;
          outcomes.push(...candidates.slice(index).map((entry) => failedPolishOutcome(entry, error)));
          break;
        }
      }
      const completed = outcomes.some((entry) => entry.status !== "failed");
      if (partialFailure && !completed) {
        setPolish(null);
        reportAiFailure(partialFailure, "윤문을 완료하지 못했습니다.");
        return;
      }
      const result = polishResult(polishMode, outcomes);
      setPolish(result);
      if (partialFailure) {
        noteAiDiagnostics(partialFailure);
        const unfinished = result.summary.failed;
        notifyView("warning", "일부 문장을 처리하지 못했습니다.", undefined, `처리 완료 ${result.summary.candidates - unfinished}건 · 처리 실패 ${unfinished}건`);
      } else if (result.summary.rejected > 0) {
        notifyView("warning", `윤문 결과는 준비되었습니다. 보호 항목 ${result.summary.rejected}건은 원문을 유지했습니다.`);
      } else {
        notifyView("success", `윤문 완료 · 변경 제안 ${result.summary.changed}건 · 변경 없음 ${result.summary.unchanged}건`);
      }
    } catch (error) {
      setPolish(null);
      notifyView("error", (error as ApiError).message ?? "윤문할 문장을 준비하지 못했습니다.");
    } finally {
      setBusy(false);
      setPolishProgress(null);
    }
  };

  /**
   * Pasted-text polish. Same engine, same guard, same modes as the file run —
   * only the input differs, so no SourceRef exists and none is invented. The
   * text is split outside the prompt and reassembled from the original, so
   * line breaks, bullets and numbering survive a partial or cancelled run.
   */
  const runTextPolish = async () => {
    const input = polishText;
    if (!input.trim()) {
      notifyView("error", "윤문할 텍스트를 붙여넣으세요.");
      return;
    }
    if (input.length > POLISH_TEXT_MAX_CHARS) {
      notifyView("error", POLISH_TEXT_TOO_LONG_MESSAGE);
      return;
    }
    setBusy(true);
    setNotice(null);
    setPolishTextRun(null);
    polishCancelled.current = false;
    try {
      const segments = splitPolishText(input);
      const targets = segments.filter((segment) => segment.polishable);
      if (targets.length === 0) {
        notifyView("info", "윤문할 문장을 찾지 못했습니다. 문장 형태의 텍스트를 붙여넣어 주세요.");
        return;
      }
      setPolishProgress({ done: 0, total: targets.length });
      const candidates = targets.map((segment): PolishCandidate => ({ id: segment.id, text: segment.text, origin: "pasted" }));
      const outcomes: PolishOutcome[] = [];
      let partialFailure: unknown = null;
      for (const [index, candidate] of candidates.entries()) {
        if (polishCancelled.current) {
          partialFailure = { code: "CANCELLED", message: SERVER_AI_MESSAGES.CANCELLED };
          outcomes.push(...candidates.slice(index).map((entry) => failedPolishOutcome(entry, partialFailure)));
          break;
        }
        try {
          const proposal = await polishServerAi(candidate.text, polishMode);
          outcomes.push(reviewProposal(candidate, proposal));
          setPolishProgress({ done: index + 1, total: candidates.length });
          setPolishTextRun(polishTextResult(polishMode, input, segments, outcomes));
        } catch (error) {
          partialFailure = error;
          outcomes.push(...candidates.slice(index).map((entry) => failedPolishOutcome(entry, error)));
          break;
        }
      }
      const completed = outcomes.some((entry) => entry.status !== "failed");
      if (partialFailure && !completed) {
        setPolishTextRun(null);
        reportAiFailure(partialFailure, "윤문을 완료하지 못했습니다.");
        return;
      }
      const result = polishTextResult(polishMode, input, segments, outcomes);
      setPolishTextRun(result);
      if (partialFailure) {
        noteAiDiagnostics(partialFailure);
        const unfinished = result.summary.failed;
        notifyView("warning", "일부 문장을 처리하지 못했습니다.", undefined, `처리 완료 ${result.summary.candidates - unfinished}건 · 처리 실패 ${unfinished}건`);
      } else if (result.summary.rejected > 0) {
        notifyView("warning", `윤문 결과는 준비되었습니다. 보호 항목 ${result.summary.rejected}건은 원문을 유지했습니다.`);
      } else {
        notifyView("success", `윤문 완료 · 변경 제안 ${result.summary.changed}건 · 변경 없음 ${result.summary.unchanged}건`);
      }
    } catch (error) {
      setPolishTextRun(null);
      notifyView("error", (error as ApiError).message ?? "윤문할 텍스트를 준비하지 못했습니다.");
    } finally {
      setBusy(false);
      setPolishProgress(null);
    }
  };

  const runAnalyze = async () => {
    if (primaryRunInFlight.current) return;
    primaryRunInFlight.current = true;
    setBusy(true);
    setNotice(null);
    setDetail(null);
    setEnrichmentResult(null);
    try {
      let deterministic: AnalyzeEntry[];
      try {
        deterministic = await runInWorker({ kind: "analyze", fileIds: selected });
        setOperationResult(deterministic);
      } catch (error) {
        setOperationResult(null);
        notifyView("error", (error as ApiError).message ?? "문서 분석에 실패했습니다.");
        return;
      }

      // Interpretation is an addition to the deterministic analysis, never a
      // precondition for it: without it the analysis is still complete.
      if (selected.length <= SERVER_AI_MAX_FILES) {
        const stages = { candidates: 0, selected: 0, provider: 0, grounded: 0, rejected: 0 };
        const onStage = (stage: "evidence" | "provider" | "ground", count: number, secondary = 0) => {
          if (stage === "evidence") { stages.candidates = count; stages.selected = secondary; }
          else if (stage === "provider") stages.provider = count;
          else { stages.grounded = count; stages.rejected = secondary; }
        };
        try {
          const enriched = await generateGroundedResult({ operation: "analyze" }, undefined, onStage);
          setEnrichmentResult(enriched);
          if (process.env.NODE_ENV !== "production") {
            const presented = analysisClaimPresentation(enriched, deterministic.flatMap((entry) => entry.extraction.fields), confirmedAnalysisItems(deterministic));
            console.info("[worklens] analyze stages", { ...stages, presented: presented.summary.length, insights: presented.insights.length, concerns: presented.concerns.length, presentationFiltered: stages.grounded - presented.summary.length - presented.insights.length - presented.concerns.length });
          }
        } catch (error) {
          noteAiDiagnostics(error);
          if (process.env.NODE_ENV !== "production") console.info("[worklens] analyze stages", { ...stages, failure: (error as Partial<ServerAiFailure>).code ?? "UNKNOWN" });
          notifyView("warning", "기본 분석은 완료됐습니다. 요약과 인사이트를 불러오지 못했습니다.", undefined, aiFailureDetail(error));
          return deterministic;
        }
      }
      notifyView("success", "문서 분석을 완료했습니다.");
      return deterministic;
    } finally {
      setBusy(false);
      primaryRunInFlight.current = false;
    }
  };

  const runCompare = async () => {
    if (primaryRunInFlight.current || selected.length < 2 || (compareMode === "version" && selected.length !== 2)) return;
    primaryRunInFlight.current = true;
    setBusy(true);
    setNotice(null);
    setDetail(null);
    setEnrichmentResult(null);
    try {
      if (compareMode === "value-check") {
        try {
          const result = await runInWorker({ kind: "value-check", fileIds: selected });
          setValueCheck(result);
          setComparison(null);
          setCompareIds(null);
          notifyView("success", "주요 값 일치 여부를 확인했습니다.");
          return result;
        } catch (error) {
          setValueCheck(null);
          notifyView("error", (error as ApiError).message ?? "값 일치 확인에 실패했습니다.");
          return;
        }
      }

      const [baseFileId, targetFileId] = selected;
      let deterministic: ComparisonResult;
      try {
        deterministic = await runInWorker({ kind: "compare", baseFileId, targetFileId });
        setComparison(deterministic);
        setCompareIds({ baseFileId, targetFileId });
        setValueCheck(null);
      } catch (error) {
        setComparison(null);
        setCompareIds(null);
        notifyView("error", (error as ApiError).message ?? "파일 비교에 실패했습니다.");
        return;
      }

      // The comparison itself is deterministic. Grounded meaning changes are an
      // extra section when they exist, and silence when they do not.
      try {
        const enriched = await generateGroundedResult({
          operation: "semantic-check",
          scope: "comparison",
          statement: "기준 파일과 대상 파일 사이에서 표현이 아니라 실제 의미가 달라진 부분만 점검하세요.",
        }, { baseFileId, targetFileId });
        if (enriched.claims.length > 0) setEnrichmentResult(enriched);
      } catch (error) {
        noteAiDiagnostics(error);
      }
      notifyView("success", "파일 비교를 완료했습니다.");
      return deterministic;
    } finally {
      setBusy(false);
      primaryRunInFlight.current = false;
    }
  };

  /**
   * Deterministic findings are committed first and remain authoritative.
   * Grounded semantic findings can only append suggestion-level entries.
   */
  const runCheck = async () => {
    if (primaryRunInFlight.current) return;
    primaryRunInFlight.current = true;
    setBusy(true);
    setNotice(null);
    setDetail(null);
    setEnrichmentResult(null);
    let base: WorkerCheckEntry[];
    try {
      try {
        base = await runInWorker({ kind: "check", fileIds: selected, userTerms, companyTerms: companyTermNames });
        setOperationResult(base);
      } catch (error) {
        setOperationResult(null);
        notifyView("error", (error as ApiError).message ?? "문서 검수에 실패했습니다.");
        return;
      }

      let merged = base;
      if (selected.length <= SERVER_AI_MAX_FILES) {
        const request: AiRequest = {
          operation: "semantic-check",
          statement: "선택한 문서의 한글 맞춤법, 띄어쓰기, 조사, 어색한 표현과 용어 일관성을 보수적으로 점검하세요. 확신이 낮은 항목은 제안으로만 표시하세요.",
        };
        try {
          const aiResult = await generateGroundedResult(request);
          merged = base.map((entry) => {
            const forFile = aiResult.claims.filter((claim) =>
              claim.evidence.some((binding) => binding.source.fileId === entry.file.id));
            const findings = sortFindings(
              mergeSemanticFindings(entry.check.findings, semanticFindings(forFile)),
              new Map(),
            );
            const added = findings.length - entry.check.findings.length;
            const summary = entry.check.summary;
            return {
              ...entry,
              check: {
                ...entry.check,
                findings,
                summary: {
                  ...summary,
                  totalFound: summary.totalFound + added,
                  returned: findings.length,
                  bySeverity: { ...summary.bySeverity, suggestion: summary.bySeverity.suggestion + added },
                  byGroup: { ...summary.byGroup, writing: summary.byGroup.writing + added },
                  byConfidence: { ...summary.byConfidence, low: summary.byConfidence.low + added },
                },
              },
            };
          });
          setOperationResult(merged);
        } catch (error) {
          noteAiDiagnostics(error);
        }
      }
      notifyView("success", "문서 검수를 완료했습니다.");
      return merged;
    } finally {
      setBusy(false);
      primaryRunInFlight.current = false;
    }
  };

  const runAggregate = async () => {
    const selectedFiles = files.filter((file) => selected.includes(file.id));
    if (selectedFiles.some((file) => !isAggregationFileKind(file.kind))) {
      notifyView("error", AGGREGATION_UNSUPPORTED_TITLE, undefined, AGGREGATION_UNSUPPORTED_DETAIL);
      return;
    }
    setBusy(true);
    setAggregation(null);
    setAggregationSelection(null);
    try {
      const draft = await runInWorker({ kind: "aggregate", fileIds: selected });
      setAggregation(draft);
      setAggregationSelection({
        sheetIds: draft.workbooks.flatMap((workbook) => workbook.sheets.filter((sheet) => sheet.selectedByDefault).map((sheet) => sheet.id)),
        mappings: draft.mappings.map(({ id, targetField, sourceFields, included }) => ({ id, targetField, sourceFields, included })),
      });
      notifyView("success", `시트 ${draft.workbooks.reduce((sum, workbook) => sum + workbook.sheets.length, 0)}개 · 레코드 ${draft.records.length}건을 분석했습니다.`);
    } catch (error) {
      notifyView("error", (error as ApiError).message ?? "문서 취합 구조를 분석하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const exportAggregation = async () => {
    if (!aggregationSelection) return;
    setBusy(true);
    try {
      const exported = await runInWorker({ kind: "aggregate-export", fileIds: selected, selection: aggregationSelection });
      const url = URL.createObjectURL(new Blob([exported.bytes as BlobPart], { type: exported.mimeType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = exported.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      notifyView("success", `${exported.fileName}을(를) 다운로드했습니다.`);
    } catch (error) {
      notifyView("error", (error as ApiError).message ?? "취합 결과를 내보내지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const runActive = async () => {
    if (activeTab === "Polish" && polishInput === "text") return runTextPolish();
    if (!selected.length) return;
    if (activeTab === "Compare") return runCompare();
    if (activeTab === "Analyze") return runAnalyze();
    if (activeTab === "Check") return runCheck();
    if (activeTab === "Extract") return runExtract();
    if (activeTab === "Aggregate") return runAggregate();
    if (activeTab === "Polish") return runPolish();
    if (activeTab === "Ask") return runAsk();
  };

  const exportFiles = async (format: "csv" | "xlsx") => {
    if (!selected.length) return;
    setBusy(true);
    try {
      const exported = await runInWorker({ kind: "export", fileIds: selected, format });
      const url = URL.createObjectURL(new Blob([exported.bytes as BlobPart], { type: exported.mimeType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = exported.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      notifyView("success", `${format.toUpperCase()} 파일을 다운로드했습니다. 다운로드된 복사본은 사용자 기기에서 직접 관리하세요.`);
    } catch (error) {
      notifyView("error", (error as ApiError).message ?? "내보내기에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Structured extraction. The deterministic pass runs in the document worker;
   * unresolved fields are sent one at a time with their bounded evidence.
   * Values absent from the cited window are dropped rather than shown.
   */
  const runExtract = async () => {
    if (!selected.length) return;
    if (extractMode === "text") return runTextExtract();
    const fields = extractMode === "fields" ? extractFields.map((entry) => entry.trim()).filter(Boolean) : [];
    if (extractMode === "fields" && fields.length === 0) {
      notifyView("error", "추출할 항목을 한 개 이상 입력하세요.");
      return;
    }
    setBusy(true);
    setNotice(null);
    setStructured(null);
    extractCancelled.current = false;
    let deterministic: StructuredExtract | null = null;
    try {
      deterministic = await runInWorker({ kind: "extract-structured", fileIds: selected, ...(fields.length ? { fields } : {}) });
      setStructured(deterministic);
      const pending = deterministic.files.flatMap((file) => file.missing.map((field) => ({ fileId: file.file.id, field })));
      if (pending.length === 0) {
        notifyView("success", `추출 항목 ${deterministic.summary.fields}개 · 찾지 못함 ${deterministic.summary.missing}개`);
        return;
      }
      let resolved = deterministic;
      setExtractProgress({ done: 0, total: pending.length });
      for (const [index, task] of pending.entries()) {
        if (extractCancelled.current) break;
        try {
          resolved = await resolveFieldWithAi(resolved, task.fileId, task.field);
        } catch (error) {
          // A field nothing could resolve stays "찾지 못함"; the values already
          // read from the documents are unaffected, so the run still completes.
          noteAiDiagnostics(error);
          break;
        }
        setStructured(resolved);
        setExtractProgress({ done: index + 1, total: pending.length });
      }
      notifyView("success", `추출 항목 ${resolved.summary.fields}개 · 찾지 못함 ${resolved.summary.missing}개`);
    } catch (error) {
      setStructured(null);
      reportAiFailure(error, "정보 추출을 완료하지 못했습니다.");
    } finally {
      setBusy(false);
      setExtractProgress(null);
    }
  };

  /** One field, one file, one bounded window; sources come back canonical. */
  const resolveFieldWithAi = async (current: StructuredExtract, fileId: string, field: string): Promise<StructuredExtract> => {
    let windowId: string | undefined;
    try {
      const window = await runInWorker({ kind: "field-evidence", fileId, field });
      windowId = window.windowId;
      const proposal = await extractServerAi(field, window.items);
      if (proposal.value === null) return current;
      const { sources } = await runInWorker({ kind: "field-source", windowId, handles: proposal.handles });
      if (sources.length === 0) return current;
      const quote = window.items.find((item) => proposal.handles.includes(item.handle))?.text;
      return withResolvedField(current, fileId, modelField(field, proposal.value, sources, proposal.confidence, quote));
    } catch (error) {
      if ((error as Partial<ServerAiFailure>).code === "NO_EVIDENCE") return current;
      throw error;
    } finally {
      if (windowId) void runInWorker({ kind: "release-evidence", windowId });
    }
  };

  const exportStructured = async (format: "csv" | "xlsx") => {
    if (!structured) return;
    setBusy(true);
    try {
      const exported = format === "csv" ? structuredCsvExport(structured) : await structuredXlsxExport(structured);
      const payload = typeof exported.content === "string"
        ? new TextEncoder().encode(`\uFEFF${exported.content}`)
        : exported.content;
      const url = URL.createObjectURL(new Blob([payload as BlobPart], { type: exported.mimeType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = exported.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      notifyView("success", `${format.toUpperCase()} 파일을 다운로드했습니다. 다운로드된 복사본은 사용자 기기에서 직접 관리하세요.`);
    } catch (error) {
      notifyView("error", (error as ApiError).message ?? "내보내기에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const exportValueCheck = async (format: "csv" | "xlsx") => {
    if (!valueCheck) return;
    setBusy(true);
    try {
      const exported = format === "csv" ? valueCheckCsvExport(valueCheck) : await valueCheckXlsxExport(valueCheck);
      const payload = typeof exported.content === "string"
        ? new TextEncoder().encode(`\uFEFF${exported.content}`)
        : exported.content;
      const url = URL.createObjectURL(new Blob([payload as BlobPart], { type: exported.mimeType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = exported.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      notifyView("success", `${format.toUpperCase()} 파일을 다운로드했습니다. 다운로드된 복사본은 사용자 기기에서 직접 관리하세요.`);
    } catch (error) {
      notifyView("error", (error as ApiError).message ?? "내보내기에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const exportComparison = async (format: "csv" | "xlsx") => {
    if (!comparison) return;
    setBusy(true);
    try {
      const exported = format === "csv" ? comparisonCsvExport(comparison) : await comparisonXlsxExport(comparison);
      const payload = typeof exported.content === "string"
        ? new TextEncoder().encode(`\uFEFF${exported.content}`)
        : exported.content;
      const url = URL.createObjectURL(new Blob([payload as BlobPart], { type: exported.mimeType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = exported.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      notifyView("success", `${format.toUpperCase()} 파일을 다운로드했습니다. 다운로드된 복사본은 사용자 기기에서 직접 관리하세요.`);
    } catch (error) {
      notifyView("error", (error as ApiError).message ?? "내보내기에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const deleteAll = () => {
    if (!window.confirm("이 탭에서 처리한 파일과 결과를 모두 지우시겠습니까?")) return;
    disposeWorkspace();
    interruptServerAi();
    setFiles([]);
    setSelected([]);
    clearResults();
    setNotice(null);
    setDeleteDone((count) => count + 1);
  };

  const deleteSelected = async () => {
    if (busy || selected.length === 0) return;
    const removing = new Set(selected);
    await runInWorker({ kind: "forget", fileIds: selected });
    interruptServerAi();
    setFiles((current) => current.filter((file) => !removing.has(file.id)));
    setSelected([]);
    clearResults();
    setStructured(null);
    setPolish(null);
    setPolishTextRun(null);
    setNotice(null);
    setDeleteDone((count) => count + 1);
  };

  // Pasted text is its own input: the Polish action then depends on the
  // textarea, not on the workspace selection, which stays untouched.
  const polishTextMode = activeTab === "Polish" && polishInput === "text";
  const [workSectionTitle, workSectionDescription] = polishTextMode
    ? ["텍스트 윤문", "붙여넣은 내용을 문장 단위로 다듬고 숫자·날짜·인용과 문서 구조를 유지합니다."]
    : workSectionCopy[activeTab];
  const aggregationHasUnsupportedFiles = activeTab === "Aggregate"
    && files.some((file) => selected.includes(file.id) && !isAggregationFileKind(file.kind));
  const actionDisabled = busy
    || (polishTextMode
      ? polishText.trim().length === 0
      : selected.length === 0
        || (activeTab === "Aggregate" && aggregationHasUnsupportedFiles)
        || (activeTab === "Compare" && (selected.length < 2 || (compareMode === "version" && selected.length !== 2)))
        || (activeTab === "Ask" && !question.trim()));
  const hasCategoryResult = activeTab === "Compare"
    ? (compareMode === "version" ? comparison !== null : valueCheck !== null)
    : activeTab === "Polish"
      ? (polishTextMode ? polishTextRun !== null : polish !== null)
      : activeTab === "Extract" && extractMode !== "text"
        ? structured !== null
        : activeTab === "Aggregate"
          ? aggregation !== null
          : operationResult !== null;
  const inlineResultNotice = hasCategoryResult
    && notice?.scope === activeTab
    && (notice.tone === "success" || notice.tone === "warning")
    ? notice
    : null;
  const resultStatus: ResultStatus | null = inlineResultNotice
    ? {
      tone: activeTab === "Compare" && comparison !== null ? "success" : inlineResultNotice.tone === "warning" ? "warning" : "success",
      label: activeTab === "Compare" && compareMode === "value-check" && inlineResultNotice.tone !== "warning"
        ? "확인 완료"
        : activeTab === "Analyze" && inlineResultNotice.tone === "warning"
          ? "기본 분석 완료"
          : activeTab === "Polish" && (polishTextMode ? polishTextRun?.summary.failed : polish?.summary.failed)
            ? "일부 처리"
            : completionLabels[activeTab],
      ...(inlineResultNotice.tone === "warning" ? {
        message: inlineResultNotice.message,
        ...(inlineResultNotice.detail ? { detail: inlineResultNotice.detail } : {}),
      } : {}),
    }
    : null;
  /**
   * Evidence names files, so two uploads of the same name must still be told
   * apart. Upload order does it in words — the document version stays in the
   * SourceRef for code, out of the user's way.
   */
  const fileNames = new Map<string, string>();
  const nameSeen = new Map<string, number>();
  for (const file of files) {
    const seen = (nameSeen.get(file.name) ?? 0) + 1;
    nameSeen.set(file.name, seen);
    fileNames.set(file.id, seen > 1 ? `${file.name} (${seen})` : file.name);
  }
  const comparisonDirection = selected.length === 2
    ? {
      base: fileNames.get(selected[0]) ?? selected[0],
      current: fileNames.get(selected[1]) ?? selected[1],
    }
    : null;
  const companyTermNames = companyTerms.filter((entry) => entry.active).map((entry) => entry.term);
  /**
   * Document features share one workspace; utility views leave its files in
   * memory while hiding document controls.
   */
  const isToolView = shellView === "PdfTools" || shellView === "ImageTools" || shellView === "Law";
  const isUtilityView = shellView === "Guide" || shellView === "Dictionary" || shellView === "Settings";
  const isDocumentWorkspaceView = !isUtilityView && !isToolView;
  const selectedNames = files.filter((file) => selected.includes(file.id)).map((file) => file.name).join(", ");

  return (
    // Hydration state lets file-input automation wait until change events bind.
    <div
      className="app-shell"
      data-hydrated={hydrated ? "true" : "false"}
    >
      <a className="skip-link" href="#workspace-content">본문으로 건너뛰기</a>
      <nav className="rail" aria-label="작업 공간 메뉴">
        <div className="rail-brand">
          <WorkLensLogo size={40} />
        </div>
        <p className="rail-group-label">WORKSPACE</p>
        <ul className="rail-list">
          {tabs.map((tab) => {
            const Icon = tabIcons[tab];
            const active = shellView === tab;
            return (
              <li key={tab}>
                <button
                  type="button"
                  className={active ? "rail-item active" : "rail-item"}
                  aria-current={active ? "page" : undefined}
                  aria-label={tabMeta[tab].label}
                  onClick={() => {
                    setShellView(tab);
                    setActiveTab(tab);
                    clearResults();
                  }}
                >
                  <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
                  <span>{tabMeta[tab].label}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="rail-group-label rail-tools-label">RESEARCH</p>
        <ul className="rail-list rail-tools-list">
          <li>
            <button
              type="button"
              className={shellView === "Law" ? "rail-item active" : "rail-item"}
              aria-current={shellView === "Law" ? "page" : undefined}
              aria-label="법령"
              onClick={() => { setDetail(null); detailTrigger.current = null; setShellView("Law"); }}
            >
              <Scale size={20} strokeWidth={1.75} aria-hidden="true" />
              <span>법령</span>
            </button>
          </li>
        </ul>
        <p className="rail-group-label rail-tools-label">TOOLS</p>
        <ul className="rail-list rail-tools-list">
          {([
            { view: "PdfTools", label: "PDF 도구", Icon: FileText },
            { view: "ImageTools", label: "이미지 도구", Icon: ImageIcon },
          ] as const).map(({ view, label, Icon }) => (
            <li key={view}>
              <button
                type="button"
                className={shellView === view ? "rail-item active" : "rail-item"}
                aria-current={shellView === view ? "page" : undefined}
                aria-label={label}
                onClick={() => { setDetail(null); detailTrigger.current = null; setShellView(view); }}
              >
                <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
                <span>{label}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="rail-footer">
          {(["Guide", "Dictionary", "Settings"] as const).map((view) => {
            const Icon = view === "Guide" ? CircleHelp : view === "Dictionary" ? BookMarked : SlidersHorizontal;
            return (
              <button
                key={view}
                type="button"
                className={shellView === view ? "rail-item active" : "rail-item"}
                aria-current={shellView === view ? "page" : undefined}
                aria-label={view}
                onClick={() => { setShellView(view); clearResults(); }}
              >
                <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
                <span>{view === "Guide" ? "사용 가이드" : view === "Dictionary" ? "용어 사전" : "설정"}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <div className="shell-main">
        {isUtilityView || isToolView ? (
          <header className="context-bar utility-bar">
            <h1>{shellView === "Guide" ? "사용 가이드" : shellView === "Dictionary" ? "용어 사전" : shellView === "Settings" ? "설정" : shellView === "PdfTools" ? "PDF 도구" : shellView === "Law" ? "법령" : "이미지 도구"}</h1>
            <span className="context-names">
              {shellView === "Guide"
                ? "WorkLens의 주요 기능을 단계별로 확인하세요."
                : shellView === "Dictionary"
                ? "맞춤법과 용어 오탐을 줄이기 위한 사전입니다."
                : shellView === "Settings"
                  ? "이 브라우저에만 적용되는 항목입니다."
                  : shellView === "PdfTools"
                    ? "PDF 페이지를 정리하고 원하는 형식으로 내보낼 수 있습니다."
                    : shellView === "Law"
                      ? "현행 법령과 판례·결정례를 조회합니다."
                      : "이미지를 편집하고 원하는 형식으로 내보낼 수 있습니다."}
            </span>
          </header>
        ) : (
          <header className={`context-bar${files.length === 0 ? " empty" : ""}`}>
            <div className="context-files">
              <h1 id="files-heading">작업 파일</h1>
              <span className="context-counts">
                <b>{files.length}</b>개
                {files.length > 0 ? (
                  <>
                    <i aria-hidden="true" />
                    선택 <b>{selected.length}</b>개
                  </>
                ) : null}
              </span>
              {files.length > 0 ? (
                <span className="context-names" title={selectedNames || undefined}>
                  {selectedNames || "선택 없음"}
                </span>
              ) : null}
            </div>
            <div className="context-actions">
              {files.length > 0 ? (
                <div className="file-actions">
                  <button type="button" className="file-add" onClick={() => inputRef.current?.click()} disabled={uploading}>
                    {uploading ? "분석 중…" : "파일 추가"}
                  </button>
                  <button type="button" className="delete-selected" onClick={() => void deleteSelected()} disabled={busy || selected.length === 0}>선택 삭제</button>
                  <button type="button" className="delete-all" onClick={deleteAll} disabled={busy}>모두 삭제</button>
                </div>
              ) : null}
            </div>
          </header>
        )}

        <section className="workspace" id="workspace-content" aria-busy={isDocumentWorkspaceView && (busy || uploading)}>
          {isDocumentWorkspaceView ? (
            <input
              ref={inputRef}
              className="file-input"
              type="file"
              multiple
              accept=".xlsx,.csv,.pdf,.docx,.pptx"
              aria-label="작업 파일 선택"
              onChange={(event: ChangeEvent<HTMLInputElement>) => { enqueueUploads(event.target.files); event.target.value = ""; }}
            />
          ) : null}
          {deleteDone > 0 && isDocumentWorkspaceView ? (
            <div className="transient-status-anchor">
              <span key={deleteDone} className="transient-status" role="status" aria-live="polite">삭제 완료</span>
            </div>
          ) : null}

          {files.length === 0 && isDocumentWorkspaceView ? (
            <div
              className={`dropzone${uploading ? " busy" : ""}${dropActive ? " drag-active" : ""}`}
              onDragEnter={(event) => { event.preventDefault(); setDropActive(true); }}
              onDragOver={(event) => { event.preventDefault(); setDropActive(true); }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
              }}
              onDrop={onDrop}
            >
              <div>
                <strong>{uploading ? "파일을 읽고 구조를 분석하는 중" : "파일 업로드"}</strong>
                <span>XLSX, CSV, PDF, DOCX, PPTX · 파일당 최대 100{"\u00a0"}MB · 전체 최대 300{"\u00a0"}MB</span>
              </div>
              <div className="drop-actions">
                <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading}>
                  {uploading ? "분석 중…" : "파일 추가"}
                </button>
              </div>
            </div>
          ) : null}

          {isDocumentWorkspaceView && notice && !inlineResultNotice && (notice.scope === "workspace" || notice.scope === shellView) ? (
            notice.tone === "error" || notice.tone === "warning" ? (
              <StatusPanel
                className={`notice ${notice.tone}`}
                variant={notice.tone}
                tone={notice.tone === "error" ? "alert" : "status"}
                live={notice.tone === "error" ? "assertive" : "polite"}
                title={notice.message}
              >
                {notice.detail ? <p>{notice.detail}</p> : null}
              </StatusPanel>
            ) : (
              <p className={`notice-inline ${notice.tone}${notice.srOnly ? " sr-only" : ""}`} role="status" aria-live="polite">{notice.message}</p>
            )
          ) : null}

          {shellView === "Guide" ? (
            <UsageGuide />
          ) : isUtilityView ? (
            <SettingsView
              view={shellView}
              companyTerms={companyTerms}
              companyTermsSource={companyTermsSource}
              userTerms={userTerms}
              ignoredRules={ignoredRules}
              onAddTerm={addTerm}
              onRemoveTerm={removeTerm}
              onClearTerms={clearTerms}
              onToggleRule={toggleRule}
            />
          ) : isToolView ? (
            shellView === "PdfTools" ? <PdfTool /> : shellView === "Law" ? <LawSearch /> : <ImageTool />
          ) : (
            <>
              {polishTextMode || files.length === 0 ? null : (
                <section className="file-list" aria-labelledby="files-heading">
                  <div className="file-list-head">
                    <label className="select-all-files">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        checked={allFilesSelected}
                        onChange={toggleAllFiles}
                        aria-label={allFilesSelected ? "전체 선택 해제" : "전체 선택"}
                      />
                      <span>선택</span>
                    </label>
                    <span>파일</span><span>상태</span><span>구조</span><span>주의</span>
                  </div>
                  {files.map((file) => {
                    const checked = selected.includes(file.id);
                    const counts = structureCounts(file.metadata);
                    const comparisonSelectionIndex = activeTab === "Compare" && compareMode === "version" && checked
                      ? selected.indexOf(file.id)
                      : -1;
                    const comparisonRole = comparisonSelectionIndex === 0
                      ? "1 · 기준 파일"
                      : comparisonSelectionIndex === 1 ? "2 · 대상 파일" : null;
                    const selectionRole = comparisonRole ?? (activeTab === "Aggregate" && checked && selected[0] === file.id ? "기준 파일" : null);
                    return (
                      <article className={`file-row${checked ? " selected" : ""}${selectionRole ? " compare-selected-file" : ""}`} key={file.id}>
                        <label className="select-file">
                          <input type="checkbox" checked={checked} disabled={!checked && selected.length === 10} onChange={() => toggleFile(file.id)} aria-label={`${file.name} 선택`} />
                          <span />
                        </label>
                        <div className="file-info">
                          {selectionRole ? <span className="compare-selection-line">
                            <span className="compare-selection-role">{selectionRole}</span>
                            {comparisonSelectionIndex === 0 && comparisonDirection ? (
                              <button type="button" className="compare-swap-icon" aria-label="기준/대상 바꾸기" title="기준/대상 바꾸기" disabled={busy} onClick={swapComparisonDirection}>
                                <ArrowUpDown aria-hidden="true" />
                              </button>
                            ) : null}
                          </span> : null}
                          <strong title={file.name} tabIndex={selectionRole ? 0 : undefined}>{file.name}</strong>
                          <span>{file.kind.toUpperCase()} · {formatBytes(file.size)}</span>
                        </div>
                        <span className={`status status-${file.status.toLowerCase()}`}><span aria-hidden="true" />{file.status}</span>
                        <div className="structure-counts">{counts.length ? counts.map((count) => <span key={count.label}>{count.label}: <b>{count.value}</b></span>) : <span>순서 기반 구조</span>}</div>
                        {file.warnings.length ? <span className="warning" title={warningText(file.warnings)}>주의 {file.warnings.length}</span> : <span className="muted">없음</span>}
                      </article>
                    );
                  })}
                </section>
              )}

              <header className="work-section-heading">
                <h2>{workSectionTitle}</h2>
                <p>{workSectionDescription}</p>
              </header>

              <section className="operation-bar" aria-label={`${tabMeta[activeTab].label} 작업`}>
                {activeTab === "Ask" ? (
                  <label className="question-field">
                    <span className="question-input-wrap">
                      <input
                        value={question}
                        maxLength={2000}
                        aria-label="질문 입력"
                        onChange={(event) => setQuestion(event.target.value)}
                        placeholder="선택한 문서에서 확인할 내용을 입력하세요"
                      />
                      <small>{question.length.toLocaleString("ko-KR")} / 2,000</small>
                    </span>
                  </label>
                ) : null}
                {activeTab === "Compare" ? (
                  <CompareControls
                    mode={compareMode}
                    busy={busy}
                    onMode={(mode) => {
                      setCompareMode(mode);
                      clearResults();
                    }}
                  />
                ) : null}
                {activeTab === "Extract" ? (
                  <ExtractControls
                    mode={extractMode}
                    fields={extractFields}
                    busy={busy}
                    runDisabled={actionDisabled}
                    onMode={setExtractMode}
                    onFields={setExtractFields}
                    onRun={() => { void runActive(); }}
                  />
                ) : null}
                {activeTab === "Polish" ? (
                  <div className="polish-controls">
                    <fieldset className="segmented polish-input-modes" aria-label="윤문 입력 방식">
                      {(["file", "text"] as const).map((input) => (
                        <label key={input}>
                          <input
                            type="radio"
                            name="polish-input"
                            value={input}
                            checked={polishInput === input}
                            disabled={busy}
                            onChange={() => {
                              setPolishInput(input);
                              setPolish(null);
                              setPolishTextRun(null);
                              setNotice(null);
                            }}
                          />
                          <span>{input === "file" ? "파일 윤문" : "텍스트 윤문"}</span>
                        </label>
                      ))}
                    </fieldset>
                    <div className="polish-mode-run">
                    <fieldset className="segmented polish-modes" aria-label="윤문 방식">
                      {POLISH_MODES.map((mode) => (
                        <label key={mode}>
                          <input
                            type="radio"
                            name="polish-mode"
                            value={mode}
                            checked={polishMode === mode}
                            disabled={busy}
                            onChange={() => {
                              setPolishMode(mode);
                              setPolish(null);
                              setPolishTextRun(null);
                              setNotice(null);
                            }}
                          />
                          <span>{POLISH_MODE_LABELS[mode]}</span>
                        </label>
                      ))}
                    </fieldset>
                    <div className="operation-actions">
                      <button type="button" onClick={runActive} disabled={actionDisabled} aria-label={`${tabMeta[activeTab].label} ${RUN_LABEL}`}>{busy ? "처리 중…" : RUN_LABEL}</button>
                    </div>
                    </div>
                    {polishTextMode ? (
                      <label className="polish-paste">
                        <span>윤문할 내용을 붙여넣으세요.</span>
                        <textarea
                          value={polishText}
                          rows={8}
                          // No hard maxLength: a long paste is accepted and
                          // then explained, rather than silently truncated.
                          aria-label="윤문할 텍스트 입력"
                          disabled={busy}
                          onChange={(event) => setPolishText(event.target.value)}
                          placeholder={"메일, 보고서, 공지 등에서 복사한 내용을 그대로 붙여넣으세요.\n줄바꿈과 목록 구조는 그대로 유지됩니다."}
                        />
                        <small data-over={polishText.length > POLISH_TEXT_MAX_CHARS ? "true" : undefined}>
                          {polishText.length.toLocaleString("ko-KR")} / {POLISH_TEXT_MAX_CHARS.toLocaleString("ko-KR")}자
                        </small>
                      </label>
                    ) : null}
                  </div>
                ) : null}
                {activeTab === "Aggregate" && aggregationHasUnsupportedFiles ? (
                  <p className="aggregation-selection-error" role="status">
                    <strong>{AGGREGATION_UNSUPPORTED_TITLE}</strong>
                    <span>{AGGREGATION_UNSUPPORTED_DETAIL}</span>
                  </p>
                ) : null}
                {activeTab !== "Extract" && activeTab !== "Polish" ? (
                  <div className="operation-actions">
                    <button type="button" onClick={runActive} disabled={actionDisabled} aria-label={`${tabMeta[activeTab].label} ${RUN_LABEL}`}>{busy ? "처리 중…" : RUN_LABEL}</button>
                  </div>
                ) : null}
              </section>

              {busy && polishProgress ? (
                <div className="processing-bar compact-progress" role="status" aria-live="polite">
                  <strong>{`윤문 처리 중 ${polishProgress.done}/${polishProgress.total}`}</strong>
                  <small>문장 단위로 처리하고 있습니다.</small>
                  <div className="ai-status-actions">
                    <button type="button" className="secondary-action" onClick={() => { polishCancelled.current = true; interruptServerAi(); }}>중지</button>
                  </div>
                </div>
              ) : busy && extractProgress ? (
                <div className="processing-bar compact-progress" role="status" aria-live="polite">
                  <strong>{`항목 확인 중 ${extractProgress.done}/${extractProgress.total}`}</strong>
                  <small>관련 근거를 확인하고 있습니다.</small>
                  <div className="ai-status-actions">
                    <button type="button" className="secondary-action" onClick={() => { extractCancelled.current = true; interruptServerAi(); }}>중지</button>
                  </div>
                </div>
              ) : null}

              {activeTab === "Compare"
                ? compareMode === "version"
                  ? <ComparisonView comparison={comparison} compareIds={compareIds} enrichment={enrichmentResult} fileNames={fileNames} detail={null} onSource={openSource} onCloseSource={closeSource} status={resultStatus} busy={busy} onExport={exportComparison} />
                  : <ValueCheckView result={valueCheck} fileNames={fileNames} onSource={openSource} status={resultStatus} busy={busy} onExport={exportValueCheck} />
                : polishTextMode
                  ? <PolishTextResults result={polishTextRun} status={resultStatus} />
                  : activeTab === "Polish"
                  ? <PolishResults result={polish} fileNames={fileNames} onSource={openSource} status={resultStatus} />
                  : activeTab === "Aggregate"
                    ? <AggregationResults draft={aggregation} selection={aggregationSelection} busy={busy} onSelection={setAggregationSelection} onExport={exportAggregation} />
                  : activeTab === "Extract" && extractMode !== "text"
                    ? <StructuredExtractResults result={structured} fileNames={fileNames} onSource={openSource} status={resultStatus} busy={busy} onExport={exportStructured} />
                    : <ResultView
                    tab={activeTab}
                    result={operationResult}
                    enrichment={activeTab === "Analyze" ? enrichmentResult : null}
                    status={resultStatus}
                    fileNames={fileNames}
                    detail={null}
                    onSource={openSource}
                    onCloseSource={closeSource}
                    resultActions={activeTab === "Extract" && extractMode === "text"
                      ? <ResultExportButtons busy={busy} onExport={exportFiles} />
                      : undefined}
                    dictionary={{ userTerms, ignoredRules, onAddTerm: addTerm, onRemoveTerm: removeTerm, onClearTerms: clearTerms, onToggleRule: toggleRule }}
                  />}
            </>
          )}
        </section>
      </div>

      {detail ? (
        <aside className="evidence-inspector">
          <SourceDetail entries={detail.entries} fileNames={fileNames} onClose={closeSource} />
        </aside>
      ) : null}
    </div>
  );
}

/**
 * Every box that reports a state — done, running, advisory, failed — reads the
 * same way: an accent rule on the left, a restrained tint, a title, then the
 * text. Only the variant changes between features, so Analyze, Ask, Compare,
 * Check, Extract and the dictionary surfaces cannot drift apart.
 * Plain containers, empty states and drop zones deliberately do not use it.
 */
type StatusVariant = "success" | "info" | "warning" | "error" | "neutral";

function StatusPanel({ variant, title, children, tone, live, className, label }: {
  variant: StatusVariant;
  title: string;
  children?: React.ReactNode;
  tone?: "status" | "alert" | "group";
  live?: "polite" | "assertive";
  className?: string;
  label?: string;
}) {
  return (
    <div
      className={`status-panel ${variant}${className ? ` ${className}` : ""}`}
      role={tone ?? "status"}
      aria-live={live}
      aria-label={label}
    >
      <strong>{title}</strong>
      {children}
    </div>
  );
}


/** Dictionary and Settings share one utility surface and preserve local preferences. */
function SettingsView({ view, companyTerms, companyTermsSource, userTerms, ignoredRules, onAddTerm, onRemoveTerm, onClearTerms, onToggleRule }: {
  view: "Dictionary" | "Settings";
  companyTerms: CompanyTermEntry[];
  companyTermsSource: "d1" | "seed" | "pending";
  userTerms: string[];
  ignoredRules: string[];
  onAddTerm: (term: string) => void;
  onRemoveTerm: (term: string) => void;
  onClearTerms: () => void;
  onToggleRule: (ruleId: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [expandCompany, setExpandCompany] = useState(false);
  const matchedCompanyTerms = companyTerms.filter((entry) =>
    !search.trim() || entry.term.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  if (view === "Settings") {
    return (
      <section className="settings-surface" aria-label="Settings">
        <dl className="settings-list">
          <div><dt>저장 위치</dt><dd>파일과 분석 결과는 이 탭의 메모리에만 있습니다. 새로고침하면 사라집니다.</dd></div>
          <div><dt>localStorage</dt><dd>개인 사전 단어와 무시한 규칙 ID만 저장합니다. 문서 본문, 근거, 질문과 답변은 브라우저 저장소에 저장하지 않습니다.</dd></div>
          <div><dt>무시한 규칙</dt><dd>
            {ignoredRules.length
              ? <div className="dictionary-term-list">{ignoredRules.map((rule) => (
                <span className="dictionary-term" key={rule}>{rule}
                  <button type="button" aria-label={`${rule} 복원`} onClick={() => onToggleRule(rule)}>×</button>
                </span>
              ))}</div>
              : "없음"}
          </dd></div>
          <div><dt>서버 AI</dt><dd>AI 기능은 필요한 질문·문장·근거만 서버 AI로 전송해 처리합니다. 원본 파일은 전송하지 않습니다.</dd></div>
          <div><dt>법령 기능 외부 연동</dt><dd>법령 기능 사용 시 필요한 검색어·검증 문구가 Korean Law MCP로 전송될 수 있으며, 문서 검토는 원문이 아닌 관련 법령·판례 조회용 검색어만 전송됩니다.<br />입력 내용은 WorkLens에 저장되지 않습니다.</dd></div>
        </dl>
      </section>
    );
  }
  return (
    <section className="settings-surface" aria-label="Dictionary">
      <div className="dictionary-section">
        <h4>COMPANY TERMS <span>{companyTerms.length}</span></h4>
        <p className="dictionary-note">
          회사 공통 용어입니다. 관리자만 수정할 수 있습니다.
          {companyTermsSource === "seed" ? " 공용 사전 저장소에 연결하지 못해 기본 목록을 표시합니다." : null}
        </p>
        <form onSubmit={(event) => event.preventDefault()}>
          <input value={search} placeholder="용어 검색" aria-label="공용 용어 검색" onChange={(event) => setSearch(event.target.value)} />
        </form>
        <div className={expandCompany || search.trim() ? "dictionary-term-list" : "dictionary-term-list collapsed"}>
          {matchedCompanyTerms.map((entry) => (
            <span className="dictionary-term quiet" key={entry.id} title={entry.description ?? undefined}>{entry.term}</span>
          ))}
          {matchedCompanyTerms.length === 0 ? <span className="dictionary-empty">일치하는 공용 용어가 없습니다.</span> : null}
        </div>
        {!search.trim() && companyTerms.length > 0 ? (
          <button type="button" className="dictionary-more" onClick={() => setExpandCompany((open) => !open)}>
            {expandCompany ? "접기" : `전체 보기 (${companyTerms.length}개)`}
          </button>
        ) : null}
      </div>
      <div className="dictionary-section">
        <h4>MY TERMS <span>{userTerms.length}</span></h4>
        <form onSubmit={(event) => { event.preventDefault(); onAddTerm(draft); setDraft(""); }}>
          <input value={draft} maxLength={64} placeholder="용어 추가" aria-label="개인 용어 추가" onChange={(event) => setDraft(event.target.value)} />
          <button type="submit" disabled={!draft.trim()}>추가</button>
        </form>
        {userTerms.length
          ? <div className="dictionary-term-list">{userTerms.map((term) => (
            <span className="dictionary-term" key={term}>{term}
              <button type="button" aria-label={`${term} 삭제`} onClick={() => onRemoveTerm(term)}>×</button>
            </span>
          ))}</div>
          : <p className="dictionary-empty">등록된 개인 용어가 없습니다.</p>}
        {userTerms.length ? (
          <div className="dictionary-actions">
            <button type="button" className="dictionary-reset" onClick={onClearTerms}>전체 초기화</button>
          </div>
        ) : null}
        <p className="dictionary-note">개인 사전은 이 브라우저에만 저장됩니다.</p>
      </div>
    </section>
  );
}

/**
 * The one place that turns a SourceRef into words. Locator first: a result row
 * already sits under its file, so "어디인지" is the scarce information and the
 * file name is repetition. Only data the parser actually produced is used —
 * a missing locator degrades to the canonical label, never to a guessed one.
 */
function locatorText(source: SourceRef): string {
  const locator = source.locator;
  if (!locator) return source.label;
  switch (locator.kind) {
    case "pptx":
      return locator.tableCell ? `Slide ${locator.slide} · 표` : `Slide ${locator.slide}`;
    case "pdf":
      return `Page ${locator.page}`;
    case "xlsx":
      return `${locator.sheet} · ${locator.range}`;
    case "docx": {
      const part = locator.part === "header" ? "머리글" : locator.part === "footer" ? "바닥글" : undefined;
      const position = locator.tableCell
        ? `표 · Row ${locator.tableCell.row + 1}`
        : `Paragraph ${locator.block + 1}`;
      return part ? `${part} · ${position}` : position;
    }
    case "csv":
      return `Row ${locator.record}`;
  }
}

const roleText = (role: SourceRole | undefined): string | undefined =>
  role === "base" ? "기준 파일" : role === "current" ? "대상 파일" : undefined;


type AnalyzeEntry = WorkerAnalyzeEntry;
type CheckEntry = { file: { id: string; name: string }; check: CheckResult };
type ExtractEntry = { file: { id: string; name: string }; extraction: ExtractResult };
type SourceHandler = (entries: readonly DetailEntry[], trigger: HTMLElement | null) => void;

interface ResultViewProps {
  tab: Tab;
  result: unknown;
  enrichment: AiAvailableResult | null;
  status: ResultStatus | null;
  fileNames: Map<string, string>;
  detail: DetailInfo | null;
  onSource: SourceHandler;
  onCloseSource: () => void;
  dictionary: Omit<CheckViewProps, "entries" | "fileNames" | "onSource">;
  resultActions?: React.ReactNode;
}

/** Shared heading copy for every category's lower work section. */
const workSectionCopy: Record<Tab, [string, string]> = {
  Analyze: ["문서 분석", "선택한 파일의 핵심 요약과 확인된 항목·수치를 분석합니다."],
  Ask: ["질문하기", "선택한 파일을 근거로 질문에 답합니다."],
  Compare: ["파일 비교", "선택한 파일의 변경 사항이나 주요 값 차이를 확인합니다."],
  Check: ["문서 검수", "선택한 파일의 문장·일관성·데이터·개인정보·보안정보를 검수합니다."],
  Polish: ["문서 윤문", "선택한 파일의 번역투와 중복 표현을 문장 단위로 다듬습니다."],
  Extract: ["정보 추출", "선택한 파일에서 필요한 항목과 값을 찾아 정리합니다."],
  Aggregate: ["문서 취합", "여러 Excel 파일의 표 데이터를 첫 번째 파일의 서식을 기준으로 하나의 파일로 취합합니다."],
};

function ResultHeader({ eyebrow, title, status, meta, showMessage = true }: {
  eyebrow?: string;
  title: string;
  status: ResultStatus | null;
  meta?: React.ReactNode;
  showMessage?: boolean;
}) {
  return (
    <>
      <div className="panel-heading result-heading">
        <div>{eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}<h2>{title}</h2></div>
        <div className="result-heading-meta">
          {status ? <span className={`result-status ${status.tone}`} role="status">{status.label}</span> : null}
          {meta}
        </div>
      </div>
      {showMessage && status?.message ? (
        <p className="result-inline-warning" role="status">
          <span>{status.message}</span>
          {status.detail ? <small>{status.detail}</small> : null}
        </p>
      ) : null}
    </>
  );
}


function ResultView({ tab, result, enrichment, status, fileNames, detail, onSource, onCloseSource, dictionary, resultActions }: ResultViewProps) {
  if (!result) return null;
  let content: React.ReactNode;
  if (tab === "Analyze" && Array.isArray(result)) {
    content = <AnalyzeResults entries={result as AnalyzeEntry[]} enrichment={enrichment} status={status} fileNames={fileNames} onSource={onSource} />;
  } else if (tab === "Check" && Array.isArray(result)) {
    content = <CheckResults entries={result as CheckEntry[]} fileNames={fileNames} onSource={onSource} {...dictionary} />;
  } else if (tab === "Extract" && Array.isArray(result)) {
    content = <ExtractResults entries={result as ExtractEntry[]} fileNames={fileNames} onSource={onSource} />;
  } else if (isAiAvailableResult(result)) {
    content = tab === "Ask"
      ? <AskResults result={result} fileNames={fileNames} onSource={onSource} />
      : <AiResults result={result} fileNames={fileNames} onSource={onSource} />;
  } else {
    content = <JsonValue value={result} fileNames={fileNames} onSource={onSource} />;
  }

  return (
    <section className={`panel results-panel${tab === "Analyze" ? " analysis-results-panel" : ""}`}>
      <ResultHeader
        {...(tab === "Ask" || tab === "Check" || tab === "Extract" || tab === "Analyze" ? {} : { eyebrow: `${tab.toUpperCase()} RESULT` })}
        title={tab === "Analyze" ? "분석 결과" : tab === "Ask" ? "답변" : tab === "Check" ? "검수 결과" : tab === "Extract" ? "추출 결과" : "작업 결과"}
        status={status}
        showMessage={tab !== "Analyze"}
        {...(tab === "Extract"
          ? { meta: resultActions }
          : tab === "Ask" || tab === "Check" || tab === "Analyze" ? {} : { meta: <span className="result-provenance">근거 연결 결과</span> })}
      />
      {content}
      {detail ? <SourceDetail entries={detail.entries} fileNames={fileNames} onClose={onCloseSource} /> : null}
    </section>
  );
}


function isAiAvailableResult(value: unknown): value is AiAvailableResult {
  return typeof value === "object" && value !== null && Array.isArray((value as AiAvailableResult).claims) && typeof (value as AiAvailableResult).operation === "string";
}

/**
 * Extract controls: which way of extracting, and — in field mode — which
 * fields. The field list is the schema, reused for every selected file, so ten
 * monthly reports become ten rows of the same columns.
 */
function CompareControls({ mode, busy, onMode }: {
  mode: "version" | "value-check";
  busy: boolean;
  onMode: (mode: "version" | "value-check") => void;
}) {
  return (
    <div className="compare-controls">
      <div className="compare-mode-row">
        <fieldset className="segmented compare-modes" aria-label="비교 방식">
          {(["version", "value-check"] as const).map((entry) => (
            <label key={entry}>
              <input
                type="radio"
                name="compare-mode"
                value={entry}
                checked={mode === entry}
                disabled={busy}
                onChange={() => onMode(entry)}
              />
              <span>{entry === "version" ? "버전 비교" : "값 일치 확인"}</span>
            </label>
          ))}
        </fieldset>
      </div>
    </div>
  );
}

function ExtractControls({ mode, fields, busy, runDisabled, onMode, onFields, onRun }: {
  mode: ExtractMode;
  fields: string[];
  busy: boolean;
  runDisabled: boolean;
  onMode: (mode: ExtractMode) => void;
  onFields: (fields: string[]) => void;
  onRun: () => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const value = draft.trim();
    if (!value || fields.includes(value)) { setDraft(""); return; }
    onFields([...fields, value]);
    setDraft("");
  };
  return (
    <div className="extract-controls">
      <div className="extract-control-row">
        <fieldset className="segmented extract-modes" aria-label="추출 방식">
          {(["auto", "fields"] as const).map((entry) => (
            <label key={entry}>
              <input type="radio" name="extract-mode" value={entry} checked={mode === entry} disabled={busy} onChange={() => onMode(entry)} />
              <span>{EXTRACT_MODE_LABELS[entry]}</span>
            </label>
          ))}
        </fieldset>
        <button type="button" className="extract-run" disabled={runDisabled} aria-label="추출 실행" onClick={onRun}>{busy ? "처리 중…" : RUN_LABEL}</button>
      </div>
      <p className="extract-mode-description">{mode === "auto"
        ? "문서에 명시된 구조화 항목과 반복 표를 자동으로 찾습니다."
        : "필요한 항목명을 지정해 파일별 값을 같은 열로 정리합니다."}</p>
      {mode === "fields" ? (
        <div className="extract-fields">
          {fields.map((field) => (
            <span className="extract-field" key={field}>
              {field}
              <button type="button" aria-label={`${field} 삭제`} disabled={busy} onClick={() => onFields(fields.filter((entry) => entry !== field))}>×</button>
            </span>
          ))}
          <input
            value={draft}
            aria-label="추출할 항목"
            placeholder="항목명 입력 (예: 회의일시)"
            maxLength={40}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }}
          />
          <button type="button" className="secondary-action" disabled={busy || !draft.trim()} onClick={add}>항목 추가</button>
        </div>
      ) : null}
    </div>
  );
}

function ResultExportButtons({ busy, onExport, xlsxOnly = false, disabled = false, label = "추출 결과 다운로드" }: {
  busy: boolean;
  onExport: (format: "csv" | "xlsx") => void | Promise<void>;
  xlsxOnly?: boolean;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="extract-export-actions" aria-label={label}>
      {!xlsxOnly ? <button type="button" className="secondary-action" onClick={() => void onExport("csv")} disabled={busy || disabled}>CSV 다운로드</button> : null}
      <button type="button" className="extract-download-primary" onClick={() => void onExport("xlsx")} disabled={busy || disabled}>XLSX 다운로드</button>
    </div>
  );
}

/**
 * Structured extraction result. Several files with one schema read as a table;
 * a single file reads as a field list. Both keep the value's own wording and
 * its source, and a field the document does not state stays visibly missing.
 */
function StructuredExtractResults({ result, fileNames, onSource, status, busy, onExport }: {
  result: StructuredExtract | null;
  fileNames: Map<string, string>;
  onSource: SourceHandler;
  status: ResultStatus | null;
  busy: boolean;
  onExport: (format: "csv" | "xlsx") => void | Promise<void>;
}) {
  const [expandedResult, setExpandedResult] = useState<StructuredExtract | null>(null);
  const recordsExpanded = expandedResult === result;
  if (!result) return null;

  const multiFile = result.files.length > 1;
  const columns = result.mode === "fields"
    ? result.requestedFields
    : [...new Set(result.files.flatMap((file) => file.fields.map((field) => field.field)))];
  const recordEntries = result.files.flatMap((file) =>
    file.records.map((record) => ({ file, record })));
  const isEmpty = result.summary.fields === 0 && result.summary.records === 0;
  const emptyTitle = result.mode === "fields"
    ? result.requestedFields.length === 1
      ? `'${result.requestedFields[0]}'을(를) 찾지 못했습니다.`
      : "요청한 항목을 찾지 못했습니다."
    : "자동으로 추출할 수 있는 구조화된 항목을 찾지 못했습니다.";

  return (
    <section className="panel results-panel extract-results">
      <ResultHeader title="추출 결과" status={status} />
      <div className="extract-result-toolbar">
        <p className="check-summary-line">
          <span className="metric">추출 항목 <b>{result.summary.fields}</b></span>
          {result.summary.missing ? <span className="metric needs-review">찾지 못함 <b>{result.summary.missing}</b></span> : null}
          {result.summary.lowConfidence ? <span className="metric needs-review">확인 필요 <b>{result.summary.lowConfidence}</b></span> : null}
          {result.summary.records ? <span className="metric">세부 표 <b>{result.summary.records}</b></span> : null}
        </p>
        {!isEmpty
          ? <ResultExportButtons busy={busy} onExport={onExport} />
          : null}
      </div>

      {isEmpty ? (
        <StatusPanel
          variant="info"
          className="result-clear"
          title={emptyTitle}
        >
          <p>{result.mode === "fields"
            ? "선택한 문서에서 해당 항목이나 값을 확인할 수 없습니다."
            : "필요한 항목이 정해져 있다면 항목 지정을 사용할 수 있습니다."}</p>
        </StatusPanel>
      ) : null}

      {!isEmpty && result.mode === "fields" ? (
        <div className={`data-table extract-fields-table${multiFile ? " multi-file" : ""}`} role="table" aria-label="지정 항목 추출 결과">
          <div className="data-head" role="row">
            {multiFile ? <span role="columnheader">파일</span> : null}
            <span role="columnheader">항목</span>
            <span role="columnheader">값</span>
            <span role="columnheader">근거</span>
          </div>
          {result.files.flatMap((file) => columns.map((column) => {
            const matches = file.fields.filter((entry) => entry.field === column);
            const distinctValues = new Set(matches.map((entry) => entry.displayValue)).size;
            return (
              <div className="data-row" role="row" key={`${file.file.id}-${column}`}>
                {multiFile ? <span role="cell" data-label="파일" title={file.file.name}>{file.file.name}</span> : null}
                <span role="cell" data-label="항목" className="extract-field-name">{column}</span>
                {matches.length ? (
                  <span role="cell" data-label="값" className="extract-field-value">
                    {matches.map((field, index) => (
                      <span key={`${field.displayValue}-${index}`} title={field.normalizedValue ? `정규화: ${field.normalizedValue}` : undefined}>
                        {field.displayValue}
                        {field.type !== "Text" || field.confidence
                          ? <small>{EXTRACT_TYPE_LABELS[field.type]}{field.confidence ? ` · 확신 ${extractConfidenceLabels[field.confidence]}` : ""}</small>
                          : null}
                      </span>
                    ))}
                    {distinctValues > 1 ? <small className="extract-conflict">서로 다른 값 {distinctValues}개</small> : null}
                  </span>
                ) : <span role="cell" data-label="값" className="extract-missing">문서에서 찾지 못함</span>}
                <span role="cell" data-label="근거">
                  {matches.length ? <CompactResultSource sources={matches.flatMap((field) => field.sources)} fileNames={fileNames} onSource={onSource} /> : <span className="source-empty">근거 없음</span>}
                </span>
              </div>
            );
          }))}
        </div>
      ) : null}

      {!isEmpty && result.mode === "auto" ? (
        <div className={`data-table extract-auto-table${multiFile ? " multi-file" : ""}`} role="table" aria-label="자동 추출 결과">
          <div className="data-head" role="row">
            {multiFile ? <span role="columnheader">파일</span> : null}
            <span role="columnheader">항목</span>
            <span role="columnheader">값</span>
            <span role="columnheader">근거</span>
          </div>
          {result.files.flatMap((file) => file.fields.map((field) => (
            <div className="data-row" role="row" key={`${file.file.id}-${field.field}-${field.displayValue}`}>
              {multiFile ? <span role="cell" data-label="파일" title={file.file.name}>{file.file.name}</span> : null}
              <span role="cell" data-label="항목" className="extract-field-name">{field.field}</span>
              <span role="cell" data-label="값" className="extract-field-value" title={field.normalizedValue ? `정규화: ${field.normalizedValue}` : undefined}>
                <span>{field.displayValue}</span>
                {field.type !== "Text" || field.confidence
                  ? <small>{EXTRACT_TYPE_LABELS[field.type]}{field.confidence ? ` · 확신 ${extractConfidenceLabels[field.confidence]}` : ""}</small>
                  : null}
              </span>
              <span role="cell" data-label="근거"><CompactResultSource sources={field.sources} fileNames={fileNames} onSource={onSource} /></span>
            </div>
          )))}
        </div>
      ) : null}

      {!isEmpty && result.mode === "auto" && recordEntries.length ? (
        <section className="extract-records">
          <button
            type="button"
            className="extract-records-toggle"
            aria-expanded={recordsExpanded}
            onClick={() => setExpandedResult(recordsExpanded ? null : result)}
          >
            <span>세부 표 {recordEntries.length}개</span>
            <span aria-hidden="true">{recordsExpanded ? "접기 ▴" : "펼치기 ▾"}</span>
          </button>
          {recordsExpanded ? (
            <div className="extract-record-list">
              {recordEntries.map(({ file, record }) => (
                <section className="result-subsection" key={`${file.file.id}-${record.id}`}>
                  <div className="subsection-heading">
                    <h4>{file.file.name} · {record.displayTitle ?? record.title}</h4>
                    <CompactResultSource sources={[record.source]} fileNames={fileNames} onSource={onSource} />
                  </div>
                  <div className="extract-table-wrap">
                    <table className="extract-table">
                      <thead><tr>{record.columns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
                      <tbody>
                        {record.rows.map((row, index) => (
                          <tr key={index}>{row.cells.map((cell, cellIndex) => <td key={cellIndex} title={cell}>{cell || "없음"}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {!isEmpty && result.mode === "fields" ? recordEntries.map(({ file, record }) => (
        <section className="result-subsection" key={`${file.file.id}-${record.id}`}>
          <div className="subsection-heading">
            <h4>{file.file.name} · {record.displayTitle ?? record.title}</h4>
            <CompactResultSource sources={[record.source]} fileNames={fileNames} onSource={onSource} />
          </div>
          <div className="extract-table-wrap">
            <table className="extract-table">
              <thead><tr>{record.columns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
              <tbody>
                {record.rows.map((row, index) => (
                  <tr key={index}>{row.cells.map((cell, cellIndex) => <td key={cellIndex} title={cell}>{cell || "없음"}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )) : null}
    </section>
  );
}

/**
 * Polish result list. Rewrites first, everything the run left alone folded
 * away: a review is read by what changed, not by what did not.
 */

function PolishCopyBlock({ label, text, revised = false }: {
  label: "원문" | "원문 유지" | "수정안";
  text: string;
  revised?: boolean;
}) {
  return (
    <div className={`polish-copy-block${revised ? " revised" : ""}`}>
      <div className="polish-copy-heading">
        <span className="polish-label">{label}</span>
        <CopyButton text={text} label={revised ? "복사" : "원문 복사"} />
      </div>
      <p className={revised ? "polish-revised" : undefined}>{text}</p>
    </div>
  );
}
function PolishSummaryLine({ summary }: { summary: PolishSummary }) {
  return (
    <div className="polish-summary-line">
      <p>
        <span className="metric changed">변경 <b>{summary.changed}</b></span>
        <span aria-hidden="true">·</span>
        <span className="metric unchanged">변경 없음 <b>{summary.unchanged}</b></span>
        {summary.rejected > 0 ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="polish-protection-metric">보호 항목 {summary.rejected}건 확인 필요</span>
          </>
        ) : null}
        {summary.failed > 0 ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="polish-protection-metric">처리 실패 {summary.failed}</span>
          </>
        ) : null}
      </p>
    </div>
  );
}

function PolishFailedItems({ outcomes }: { outcomes: readonly PolishOutcome[] }) {
  const [expanded, setExpanded] = useState(false);
  const failed = outcomes.filter((entry) => entry.status === "failed");
  if (!failed.length) return null;
  return (
    <div className="polish-unchanged">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        처리되지 않은 문장 {failed.length}건 {expanded ? "접기" : "보기"}
      </button>
      {expanded ? <ul>{failed.map((entry) => <li key={entry.id}><p>{entry.originalText}</p></li>)}</ul> : null}
    </div>
  );
}

function PolishResults({ result, fileNames, onSource, status }: {
  result: PolishResult | null;
  fileNames: Map<string, string>;
  onSource: SourceHandler;
  status: ResultStatus | null;
}) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  if (!result) return null;
  const changed = result.outcomes.filter((entry) => entry.status === "changed");
  const unchanged = result.outcomes.filter((entry) => entry.status === "unchanged");
  const rejected = result.outcomes.filter((entry) => entry.status === "rejected");

  return (
    <section className="panel results-panel polish-results">
      <ResultHeader
        title="윤문 결과"
        status={status}
        meta={<span className="polish-mode-meta">{POLISH_MODE_LABELS[result.mode]}</span>}
      />
      <PolishSummaryLine summary={result.summary} />

      {changed.length === 0 && rejected.length === 0 && result.summary.failed === 0 ? (
        <p className="polish-unchanged-message">현재 문서는 {POLISH_MODE_LABELS[result.mode]} 기준에서 별도 수정이 필요하지 않습니다.</p>
      ) : null}

      {changed.map((entry) => (
        <article className="polish-row" key={entry.id}>
          <PolishCopyBlock label="원문" text={entry.originalText} />
          <PolishCopyBlock label="수정안" text={entry.revisedText} revised />
          {entry.reasons.length ? (
            <div className="polish-reason">
              <span className="polish-label">변경 이유</span>
              <p>{entry.reasons.join(" · ")}</p>
            </div>
          ) : null}
          {entry.source ? <div className="polish-source"><ResultSource sources={[entry.source]} fileNames={fileNames} onSource={onSource} /></div> : null}
        </article>
      ))}

      {rejected.map((entry) => (
        <article className="polish-row rejected" key={entry.id}>
          <PolishCopyBlock label="원문 유지" text={entry.originalText} />
          <p className="polish-rejection-reason">
            {entry.rejection ? POLISH_REJECTION_LABELS[entry.rejection] : "수정안을 적용하지 않았습니다."}
          </p>
          {entry.source ? <div className="polish-source"><ResultSource sources={[entry.source]} fileNames={fileNames} onSource={onSource} /></div> : null}
        </article>
      ))}

      {unchanged.length && (changed.length > 0 || rejected.length > 0 || result.summary.failed > 0) ? (
        <div className="polish-unchanged">
          <button type="button" aria-expanded={showUnchanged} onClick={() => setShowUnchanged(!showUnchanged)}>
            변경 없음 {unchanged.length}건 {showUnchanged ? "접기" : "보기"}
          </button>
          {showUnchanged ? (
            <ul>
              {unchanged.map((entry) => (
                <li key={entry.id}>
                  <p>{entry.originalText}</p>
                  {entry.source ? <ResultSource sources={[entry.source]} fileNames={fileNames} onSource={onSource} /> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <PolishFailedItems outcomes={result.outcomes} />
    </section>
  );
}

/**
 * Clipboard with a fallback: a denied Clipboard API permission still has to
 * copy, and the confirmation stays inline instead of raising a page notice.
 */
function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const holder = document.createElement("textarea");
      holder.value = text;
      holder.setAttribute("readonly", "");
      holder.style.position = "fixed";
      holder.style.opacity = "0";
      document.body.append(holder);
      holder.select();
      document.execCommand("copy");
      holder.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_600);
  };
  return (
    <button type="button" className={["secondary-action", className].filter(Boolean).join(" ")} onClick={() => void copy()}>
      {copied ? "복사됨" : label}
    </button>
  );
}

/**
 * Pasted-text result. One block in, one block out: the original, the polished
 * text reassembled with its own line breaks and list markers, and the reasons.
 * No locator and no evidence inspector — the pasted text is the source, and a
 * fabricated SourceRef would claim a document that does not exist.
 */
function PolishTextResults({ result, status }: { result: PolishTextResult | null; status: ResultStatus | null }) {
  if (!result) return null;
  const reasons = [...new Set(result.outcomes.flatMap((entry) => entry.reasons))].slice(0, 6);
  const rejected = result.outcomes.filter((entry) => entry.status === "rejected");
  const changed = result.summary.changed > 0;
  const showComparison = changed || rejected.length > 0;

  return (
    <section className="panel results-panel polish-results polish-text-results">
      <ResultHeader
        title="윤문 결과"
        status={status}
        meta={<span className="polish-mode-meta">{POLISH_MODE_LABELS[result.mode]}</span>}
      />
      <PolishSummaryLine summary={result.summary} />

      {!showComparison && result.summary.failed === 0 ? (
        <p className="polish-unchanged-message">현재 문장은 {POLISH_MODE_LABELS[result.mode]} 기준에서 별도 수정이 필요하지 않습니다.</p>
      ) : showComparison ? (
        <article className="polish-row polish-text-run">
          <PolishCopyBlock label="원문" text={result.originalText} />
          <PolishCopyBlock label="수정안" text={result.revisedText} revised />
          {reasons.length ? (
            <div className="polish-reason">
              <span className="polish-label">변경 이유</span>
              <p>{reasons.join(" · ")}</p>
            </div>
          ) : null}
          {rejected.length ? (
            <p className="polish-rejection-reason">
              {[...new Set(rejected.map((entry) => entry.rejection ? POLISH_REJECTION_LABELS[entry.rejection] : "수정안을 적용하지 않았습니다."))].join(" · ")}
            </p>
          ) : null}
        </article>
      ) : null}
      <PolishFailedItems outcomes={result.outcomes} />
    </section>
  );
}


/**
 * The single source presentation for Analyze summaries and insights,
 * Ask claims, Compare changes, Check findings and Extract values.
 *
 * A result row answers "where" and "how many", not "list them all": repeated
 * locators collapse to `· N건`, several locators to `대표 외 N곳`, and one
 * action opens the evidence inspector on the whole set. Nothing is dropped —
 * every SourceRef reaches the inspector, which lists them one by one — so
 * this is presentation only and grounding is untouched.
 */
function ResultSource({ sources, fileNames, onSource, roleOf, emptyLabel = "근거 위치 없음", context }: {
  sources: readonly SourceRef[];
  fileNames: Map<string, string>;
  onSource: SourceHandler;
  roleOf?: (source: SourceRef) => SourceRole | undefined;
  emptyLabel?: string;
  context?: DetailEntry["context"];
}) {
  if (sources.length === 0) return <span className="source-empty">{emptyLabel}</span>;
  const acrossFiles = new Set(sources.map((source) => source.fileId)).size > 1;
  // 기준/대상 only earns its place when one row actually mixes both sides;
  // a row that cites a single side already says so through its own column.
  const mixedRoles = roleOf ? new Set(sources.map((source) => roleOf(source))).size > 1 : false;
  const describe = (source: SourceRef): string => {
    const prefix = (mixedRoles ? roleText(roleOf?.(source)) : undefined)
      ?? (acrossFiles && !roleOf ? fileNames.get(source.fileId) : undefined);
    return prefix ? `${prefix} · ${locatorText(source)}` : locatorText(source);
  };

  // Document order decides the representative: the list is never re-sorted.
  const groups: { label: string; count: number }[] = [];
  for (const source of sources) {
    const label = describe(source);
    const existing = groups.find((entry) => entry.label === label);
    if (existing) existing.count += 1;
    else groups.push({ label, count: 1 });
  }
  const [lead] = groups;
  const summary = groups.length > 1
    ? `${lead.label} 외 ${groups.length - 1}곳`

    : lead.count > 1 ? `${lead.label} · ${lead.count}건` : lead.label;
  // One action name everywhere: the count belongs to the locator summary, not
  // to the button, so a row never reads as a different kind of action.
  const ariaLabel = groups.length > 1
    ? `${lead.label} 외 ${groups.length - 1}곳 근거 보기`
    : lead.count > 1 ? `${lead.label} 근거 ${lead.count}건 보기` : `${lead.label} 근거 보기`;

  return (
    <span className="result-source">
      <span className="source-locator" title={groups.map((entry) => entry.count > 1 ? `${entry.label} · ${entry.count}건` : entry.label).join("\n")}>
        {summary}
      </span>
      <button
        type="button"
        className="source-action"
        aria-label={ariaLabel}
        onClick={(event) => onSource(sources.map((source) => ({ source, role: roleOf?.(source), context })), event.currentTarget)}
      >근거 보기</button>
    </span>
  );
}
function CompactResultSource({ sources, fileNames, onSource, locatorOf = locatorText }: {
  sources: readonly SourceRef[];
  fileNames: Map<string, string>;
  onSource: SourceHandler;
  locatorOf?: (source: SourceRef) => string;
}) {
  if (sources.length === 0) return <span className="source-empty">근거 위치 없음</span>;
  const acrossFiles = new Set(sources.map((source) => source.fileId)).size > 1;
  const groups: { label: string; count: number }[] = [];
  for (const source of sources) {
    const locator = locatorOf(source);
    const fileName = acrossFiles ? fileNames.get(source.fileId) : undefined;
    const label = fileName ? `${fileName} · ${locator}` : locator;
    const existing = groups.find((entry) => entry.label === label);
    if (existing) existing.count += 1;
    else groups.push({ label, count: 1 });
  }
  const [lead] = groups;
  const summary = groups.length > 1
    ? `${lead.label} 외 ${groups.length - 1}곳`
    : lead.count > 1 ? `${lead.label} · ${lead.count}건` : lead.label;
  const title = groups.map((entry) => entry.count > 1 ? `${entry.label} · ${entry.count}건` : entry.label).join("\n");
  return (
    <span className="result-source">
      <span className="source-locator" title={title}>{summary}</span>
      <button
        type="button"
        className="source-action"
        aria-label={`${summary} 근거 보기`}
        onClick={(event) => onSource(sources.map((source) => ({ source })), event.currentTarget)}
      >근거 보기</button>
    </span>
  );
}

function AnalyzeResults({ entries, enrichment, status, fileNames, onSource }: {
  entries: AnalyzeEntry[];
  enrichment: AiAvailableResult | null;
  status: ResultStatus | null;
  fileNames: Map<string, string>;
  onSource: SourceHandler;
}) {
  const confirmedFields = entries.flatMap((entry) => entry.extraction.fields);
  const presentation = analysisClaimPresentation(enrichment, confirmedFields, confirmedAnalysisItems(entries));
  const coreItems = presentation.content;
  const metrics = confirmedAnalysisMetrics(entries);
  const mismatches = entries.flatMap(({ file, analysis }) =>
    analysis.totals.filter((total) => total.actual !== total.expected).map((total) => ({ file, total })));
  const sourcesOf = (claim: GroundedClaim) => claim.evidence.map((binding) => binding.source);
  const renderClaim = (claim: GroundedClaim) => (
    <article className="analysis-reading-row" key={claim.id}>
      <p>{claimDisplayText(claim)}</p>
      <div className="analysis-reading-actions">
        <ResultSource sources={sourcesOf(claim)} fileNames={fileNames} onSource={onSource} />
      </div>
    </article>
  );
  const hasContent = presentation.summary.length + coreItems.length + metrics.length + presentation.insights.length
    + presentation.concerns.length + mismatches.length > 0;
  const hasWarnings = Boolean(status?.message || presentation.warnings.length);
  const multipleFiles = entries.length > 1;

  return (
    <div className="analysis-report">
      {presentation.summary.length ? (
        <section className="analysis-report-section analysis-summary-section" aria-labelledby="analysis-summary-title">
          <div className="subsection-heading">
            <h3 id="analysis-summary-title">핵심 요약</h3>
            <span>{presentation.summary.length}건</span>
          </div>
          <div className="analysis-reading-list">
            {presentation.summary.map((claim) => renderClaim(claim))}
          </div>
        </section>
      ) : null}

      {coreItems.length ? (
        <section className="analysis-report-section analysis-core-items-section" aria-labelledby="analysis-core-items-title">
          <div className="subsection-heading">
            <h3 id="analysis-core-items-title">주요 내용</h3>
            <span>{coreItems.length}건</span>
          </div>
          <div className="analysis-reading-list">
            {coreItems.map((item) => (
              <article className="analysis-reading-row analysis-core-item-row" key={item.id}>
                <p>{item.text}</p>
                <div className="analysis-reading-actions">
                  <ResultSource sources={item.sources} fileNames={fileNames} onSource={onSource} />
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {metrics.length ? (
        <section className="analysis-report-section" aria-labelledby="analysis-metrics-title">
          <div className="subsection-heading"><h3 id="analysis-metrics-title">확인된 수치</h3><span>{metrics.length}건</span></div>
          <div className="analysis-metric-wrap">
            <table className={`analysis-metric-table${multipleFiles ? " multi-file" : ""}`}>
              <thead>
                <tr>{multipleFiles ? <th>파일</th> : null}<th>항목</th><th>값</th><th>근거</th></tr>
              </thead>
              <tbody>
                {metrics.map((metric) => (
                  <tr key={metric.id}>
                    {multipleFiles ? <td className="analysis-metric-file" data-label="파일">{fileNames.get(metric.fileId) ?? metric.fileName}</td> : null}
                    <th scope="row" data-label="항목">{metric.label}</th>
                    <td className="numeric" data-label="값">{metric.value}</td>
                    <td data-label="근거"><ResultSource sources={metric.sources} fileNames={fileNames} onSource={onSource} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {presentation.insights.length ? (
        <section className="analysis-report-section analysis-insight-section" aria-labelledby="analysis-insight-title">
          <div className="subsection-heading">
            <h3 id="analysis-insight-title">분석 인사이트</h3>
            <span>{presentation.insights.length}건</span>
          </div>
          <div className="analysis-reading-list">
            {presentation.insights.map((claim) => renderClaim(claim))}
          </div>
        </section>
      ) : null}
      {presentation.concerns.length || mismatches.length ? (
        <section className="analysis-report-section analysis-concern-section" aria-labelledby="analysis-review-title">
          <div className="subsection-heading"><h3 id="analysis-review-title">확인 필요</h3><span>{presentation.concerns.length + mismatches.length}건</span></div>
          <div className="analysis-reading-list">
            {presentation.concerns.map((claim) => (
              <article className="analysis-reading-row concern" key={claim.id}>
                <p>{claimDisplayText(claim)}</p>
                <div className="analysis-reading-actions">
                  <ResultSource sources={sourcesOf(claim)} fileNames={fileNames} onSource={onSource} />
                </div>
              </article>
            ))}
            {mismatches.map(({ file, total }) => (
              <article className="analysis-reading-row concern" key={`${file.id}-${total.source.nodeId}`}>
                <p><strong>{file.name}</strong>의 {total.label} 표시값 {total.actual.toLocaleString("ko-KR")}과 계산값 {total.expected.toLocaleString("ko-KR")}이 일치하지 않습니다.</p>
                <div className="analysis-reading-actions">
                  <ResultSource sources={[total.source, ...total.contributingSources]} fileNames={fileNames} onSource={onSource} />
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {!hasContent ? <p className="analysis-empty">표시할 분석 결과가 없습니다.</p> : null}
      {hasWarnings ? (
        <section className="analysis-report-section analysis-warning-section" aria-labelledby="analysis-warning-title">
          <div className="subsection-heading"><h3 id="analysis-warning-title">결과 안내</h3></div>
          {status?.message ? (
            <p className="result-inline-warning" role="status">
              <span>{status.message}</span>
              {status.detail ? <small>{status.detail}</small> : null}
            </p>
          ) : null}
          {presentation.warnings.map((warning) => <p className="analysis-warning-line" key={warning.code}>{warning.message}</p>)}
        </section>
      ) : null}
    </div>
  );
}


const PAGE_SIZE = 20;

interface CheckViewProps {
  entries: CheckEntry[];
  fileNames: Map<string, string>;
  onSource: SourceHandler;
  userTerms: string[];
  ignoredRules: string[];
  onAddTerm: (term: string) => void;
  onRemoveTerm: (term: string) => void;
  onClearTerms: () => void;
  onToggleRule: (ruleId: string) => void;
}

function CheckResults({ entries, fileNames, onSource, userTerms, ignoredRules, onAddTerm, onRemoveTerm, onClearTerms, onToggleRule }: CheckViewProps) {

  const [groupFilter, setGroupFilter] = useState<"all" | CheckCategoryGroup>("all");
  const [showLowConfidence] = useState(false);
  const [ignoredIds, setIgnoredIds] = useState<string[]>([]);
  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [termDraft, setTermDraft] = useState("");

  const indexed = useMemo(
    () => entries.flatMap((entry) => entry.check.findings.map((finding) => ({ finding, file: entry.file }))),
    [entries],
  );
  const totals = useMemo(() => entries.reduce((accumulator, entry) => {
    const summary = entry.check.summary;
    accumulator.totalFound += summary.totalFound;
    accumulator.returned += summary.returned;
    accumulator.truncated = accumulator.truncated || summary.truncated;
    for (const severity of ["critical", "warning", "suggestion"] as const) accumulator.bySeverity[severity] += summary.bySeverity[severity];
    for (const group of ["writing", "consistency", "data", "privacy"] as const) accumulator.byGroup[group] += summary.byGroup[group];
    accumulator.lowConfidence += summary.byConfidence.low;
    return accumulator;
  }, {
    totalFound: 0,
    returned: 0,
    truncated: false,
    lowConfidence: 0,
    bySeverity: { critical: 0, warning: 0, suggestion: 0 } as Record<CheckSeverity, number>,
    byGroup: { writing: 0, consistency: 0, data: 0, privacy: 0 } as Record<CheckCategoryGroup, number>,
  }), [entries]);

  // A term added to the personal dictionary must disappear from the current
  // result immediately, without re-parsing the document.
  const suppressed = useMemo(() => new Set(userTerms.map((term) => term.trim().toLocaleLowerCase())), [userTerms]);
  const active = useMemo(() => indexed.filter(({ finding }) =>
    !ignoredIds.includes(finding.id)
    && !ignoredRules.includes(finding.ruleId)
    && !(finding.normalizedToken && suppressed.has(finding.normalizedToken.trim().toLocaleLowerCase()))
    && (showLowConfidence || finding.confidence !== "low")), [indexed, ignoredIds, ignoredRules, suppressed, showLowConfidence]);

  const counts = useMemo(() => ({
    critical: active.filter(({ finding }) => finding.severity === "critical").length,
    warning: active.filter(({ finding }) => finding.severity === "warning").length,
    suggestion: active.filter(({ finding }) => finding.severity === "suggestion").length,
  }), [active]);
  const groupCounts = useMemo(() => ({
    writing: active.filter(({ finding }) => checkCategoryGroup(finding.category) === "writing").length,
    consistency: active.filter(({ finding }) => checkCategoryGroup(finding.category) === "consistency").length,
    data: active.filter(({ finding }) => checkCategoryGroup(finding.category) === "data").length,
    privacy: active.filter(({ finding }) => checkCategoryGroup(finding.category) === "privacy").length,
  }), [active]);

  const filtered = useMemo(() => active.filter(({ finding }) =>
    groupFilter === "all" || checkCategoryGroup(finding.category) === groupFilter), [active, groupFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = useMemo(
    () => filtered.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE),
    [filtered, currentPage],
  );
  const resetPage = () => setPage(0);
  const ignoreFinding = (id: string) => {
    setIgnoredIds((current) => [...current, id]);
  };
  const addTerm = (term: string) => {
    onAddTerm(term);
  };
  const filterItems: Array<{ key: "all" | CheckCategoryGroup; label: string; count: number }> = [
    { key: "all", label: "전체", count: active.length },
    ...(Object.keys(checkGroupLabels) as CheckCategoryGroup[]).map((group) => ({ key: group, label: checkGroupLabels[group], count: groupCounts[group] })),
  ];

  return (
    <div className="result-sections check-results">
      <section className="qa-overview" aria-label="검수 요약">
        <p className="qa-summary-line" aria-label="심각도 요약">
          {(["critical", "warning", "suggestion"] as const).map((severity) => (
            <span key={severity} className={counts[severity] === 0 ? "muted" : undefined}>
              {severityLabels[severity]} <b>{counts[severity]}</b>
            </span>
          ))}
        </p>
        {totals.truncated ? (
          <small className="check-truncation" data-testid="check-truncation">
            전체 {totals.totalFound.toLocaleString("ko-KR")}건 중 우선순위가 높은 {totals.returned.toLocaleString("ko-KR")}건을 표시합니다.
          </small>
        ) : null}
      </section>

      {indexed.length === 0 ? (
        <StatusPanel variant="success" className="result-clear" title="확인된 문제가 없습니다."><p>현재 규칙 범위에서 문장, 일관성, 데이터와 개인정보 문제를 찾지 못했습니다.</p></StatusPanel>
      ) : (
        <>
          <div className="check-toolbar check-toolbar-compact">
            <div className="check-filters-compact" role="group" aria-label="검수 분류 필터">
              {filterItems.flatMap((item, index) => [
                index > 0 ? <span className="check-filter-sep" aria-hidden="true" key={`sep-${item.key}`}>·</span> : null,
                <button type="button" key={item.key} data-empty={item.count === 0} aria-pressed={groupFilter === item.key} onClick={() => { setGroupFilter(item.key); resetPage(); }}>
                  {item.label} <b>{item.count}</b>
                </button>,
              ])}
            </div>
            <div className="check-toolbar-actions">
              <div className="dictionary-anchor">
                <button type="button" className="dictionary-trigger" aria-expanded={dictionaryOpen} onClick={() => setDictionaryOpen((open) => !open)}>용어 사전</button>
                {dictionaryOpen ? (
                  <div className="dictionary-panel" role="dialog" aria-label="용어 사전">
                    <section className="dictionary-section">
                      <h4>회사 용어 <span>{companyTermFile.terms.length}</span></h4>
                      <p className="dictionary-note">회사 공용 사전은 읽기 전용입니다.</p>
                      <div className="dictionary-term-list">
                        {companyTermFile.terms.slice(0, 12).map((term) => <span className="dictionary-term" key={term}>{term}</span>)}
                        {companyTermFile.terms.length > 12 ? <span className="dictionary-term muted">외 {companyTermFile.terms.length - 12}개</span> : null}
                      </div>
                    </section>
                    <section className="dictionary-section">
                      <h4>내 용어 <span>{userTerms.length}</span></h4>
                      <form onSubmit={(event) => { event.preventDefault(); onAddTerm(termDraft); setTermDraft(""); }}>
                        <input value={termDraft} maxLength={64} placeholder="용어 추가" aria-label="개인 용어 추가" onChange={(event) => setTermDraft(event.target.value)} />
                        <button type="submit" disabled={!termDraft.trim()}>추가</button>
                      </form>
                      {userTerms.length ? (
                        <div className="dictionary-term-list">
                          {userTerms.map((term) => (
                            <span className="dictionary-term" key={term}>
                              {term}
                              <button type="button" aria-label={`${term} 삭제`} onClick={() => onRemoveTerm(term)}>×</button>
                            </span>
                          ))}
                        </div>
                      ) : <p className="dictionary-empty">등록한 개인 용어가 없습니다.</p>}
                      <div className="dictionary-actions">
                        <button type="button" onClick={onClearTerms} disabled={!userTerms.length}>전체 초기화</button>
                      </div>
                      <p className="dictionary-note">개인 사전은 이 브라우저에만 저장됩니다.</p>
                    </section>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {filtered.length ? (
            <>
              <section className="check-list" aria-label="문서 검수 이슈">
                {visible.map(({ finding }) => {
                  const sources = finding.sources.length ? finding.sources : [finding.source];
                  const group = checkCategoryGroup(finding.category);
                  return (
                    <article className={`check-issue severity-${finding.severity}`} key={finding.id} data-confidence={finding.confidence}>
                      <div className="check-issue-row">
                        <div className="check-issue-summary">
                          <div className="check-issue-meta">
                            <span className="check-severity"><i className={`severity-mark ${finding.severity}`} aria-hidden="true" />{severityLabels[finding.severity]}</span>
                            <span aria-hidden="true">·</span>
                            <span className="check-category">{checkGroupLabels[group]}</span>
                            <span className="check-category-detail">{checkCategoryLabels[finding.category]}</span>
                          </div>
                          <div className="check-issue-name">
                            <strong>{finding.issue}</strong>
                            <p>{finding.message}</p>
                          </div>
                        </div>
                        <div className="check-issue-support">
                          {finding.recommendation.trim() ? (
                            <div className="check-recommendation">
                              <span className="check-field-label">수정 제안</span>
                              <p><RecommendationText text={finding.recommendation} suggestedText={finding.suggestedText} /></p>
                            </div>
                          ) : null}
                          <div className="check-source">
                            <ResultSource
                              sources={sources}
                              fileNames={fileNames}
                              onSource={onSource}
                              context={{ issue: finding.issue, recommendation: finding.recommendation }}
                            />
                          </div>
                        </div>
                        <div className="finding-actions" aria-label={`${finding.issue} 작업`}>
                          <button type="button" onClick={() => ignoreFinding(finding.id)}>이번 항목 제외</button>
                          <button type="button" onClick={() => onToggleRule(finding.ruleId)}>동일 규칙 무시</button>
                          {finding.dictionaryEligible && finding.normalizedToken
                            ? <button type="button" onClick={() => addTerm(finding.normalizedToken!)}>내 용어에 추가</button>
                            : null}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </section>
              {pageCount > 1 ? (
                <nav className="check-pagination" aria-label="검수 결과 페이지">
                  <button type="button" onClick={() => setPage(currentPage - 1)} disabled={currentPage === 0}>이전</button>
                  <span>{currentPage * PAGE_SIZE + 1}-{currentPage * PAGE_SIZE + visible.length} / {filtered.length.toLocaleString("ko-KR")}</span>
                  <button type="button" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= pageCount - 1}>다음</button>
                </nav>
              ) : null}
            </>
          ) : (
            <div className="filter-empty">
              <strong>필터 조건에 맞는 이슈가 없습니다.</strong>
              <button type="button" onClick={() => { setGroupFilter("all"); setIgnoredIds([]); resetPage(); }}>필터 초기화</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ExtractResults({ entries, fileNames, onSource }: { entries: ExtractEntry[]; fileNames: Map<string, string>; onSource: SourceHandler }) {
  return (
    <div className="result-sections">
      {entries.map(({ file, extraction }) => (
        <article className="document-result" key={file.id}>
          <header className="document-result-heading"><div><span>STRUCTURED EXTRACT</span><h3 title={file.name}>{file.name}</h3></div><small>{extraction.tables.length} tables · {extraction.paragraphs.length} paragraphs</small></header>
          {extraction.tables.map((table, tableIndex) => (
            <section className="result-subsection" key={table.blockId}>
              <div className="subsection-heading"><h4>표 {tableIndex + 1}</h4><CompactResultSource sources={[table.source]} fileNames={fileNames} onSource={onSource} /></div>
              <div className="extract-table-wrap">
                <table className="extract-table">
                  <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`} title={cell.display}>{cell.display || "없음"}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </section>
          ))}
          {extraction.paragraphs.length ? (
            <section className="result-subsection">
              <div className="subsection-heading"><h4>문단</h4><span>{extraction.paragraphs.length}개</span></div>
              <div className="paragraph-list">{extraction.paragraphs.map((paragraph) => (
                <div key={paragraph.blockId}>
                  <p>{paragraph.text}</p>
                  <CompactResultSource sources={[paragraph.source]} fileNames={fileNames} onSource={onSource} />
                </div>
              ))}</div>

            </section>
          ) : null}
        </article>
      ))}
    </div>
  );
}
function AskResults({ result, fileNames, onSource }: {
  result: AiAvailableResult;
  fileNames: Map<string, string>;
  onSource: SourceHandler;
}) {
  if (result.operation !== "ask") return null;
  const fileOrder = new Map([...fileNames.keys()].map((fileId, index) => [fileId, index]));
  const claims = result.claims
    .map((claim, index) => ({ claim, index }))
    .sort((left, right) => {
      const position = (claim: GroundedClaim) => Math.min(...claim.evidence.map(({ source }) => fileOrder.get(source.fileId) ?? Number.MAX_SAFE_INTEGER));
      return position(left.claim) - position(right.claim) || left.index - right.index;
    })
    .map(({ claim }) => claim);

  return (
    <div className="ask-result">
      {claims.length ? (
        <section className="ask-answer" aria-label="답변 목록">
          <div className="ask-answer-list">
            {claims.map((claim) => {
              const sources = claim.evidence.map((binding) => binding.source);
              const sourceFileIds = [...new Set(sources.map((source) => source.fileId))];
              const sourceFiles = sourceFileIds.map((fileId) => fileNames.get(fileId) ?? fileId);
              return (
                <article className="ask-answer-row" key={claim.id}>
                  <span className="ask-answer-files" title={sourceFiles.join(" · ")}>{sourceFiles.join(" · ")}</span>
                  <div className="ask-answer-content">
                    <p>{claimDisplayText(claim)}</p>
                    <ResultSource sources={sources} fileNames={fileNames} onSource={onSource} />
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : (
        <p className="ask-result-info" role="status">선택한 파일에서 답변에 필요한 근거를 찾지 못했습니다.</p>
      )}
    </div>
  );
}


function AiResults({ result, fileNames, onSource }: {
  result: AiAvailableResult;
  fileNames: Map<string, string>;
  onSource: SourceHandler;
}) {
  return (
    <div className="ai-result">
      <section className="claim-list">
        <div className="subsection-heading"><h3>주요 내용</h3><span>{result.claims.length}건</span></div>
        {result.claims.map((claim) => (
          <article className="claim-row" key={claim.id}>
            <p>{claimDisplayText(claim)}</p>
            <ResultSource sources={claim.evidence.map((binding) => binding.source)} fileNames={fileNames} onSource={onSource} />
          </article>
        ))}
      </section>
      {result.warnings.length ? <StatusPanel variant="warning" className="result-warnings" title="일부 결과 안내">{result.warnings.map((warning) => <p key={warning.code}>{warning.message}</p>)}</StatusPanel> : null}
    </div>
  );
}

function JsonValue({ value, fileNames, onSource, depth = 0 }: { value: unknown; fileNames: Map<string, string>; onSource: SourceHandler; depth?: number }): React.ReactNode {
  if (isSourceRef(value)) return <ResultSource sources={[value]} fileNames={fileNames} onSource={onSource} />;
  if (Array.isArray(value)) return value.length ? <div className={`result-list depth-${Math.min(depth, 2)}`}>{value.map((item, index) => <div className="result-entry" key={index}><JsonValue value={item} fileNames={fileNames} onSource={onSource} depth={depth + 1} /></div>)}</div> : <span className="muted">항목 없음</span>;
  if (typeof value === "object" && value !== null) return <dl className="result-object">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{key}</dt><dd><JsonValue value={item} fileNames={fileNames} onSource={onSource} depth={depth + 1} /></dd></div>)}</dl>;
  return <span>{displayValue(value as string | number | boolean | null | undefined)}</span>;
}

function ComparisonView({ comparison, compareIds, enrichment, fileNames, detail, onSource, onCloseSource, status, busy, onExport }: {
  comparison: ComparisonResult | null;
  compareIds: { baseFileId: string; targetFileId: string } | null;
  enrichment: AiAvailableResult | null;
  fileNames: Map<string, string>;
  detail: DetailInfo | null;
  onSource: SourceHandler;
  onCloseSource: () => void;
  status: ResultStatus | null;
  busy: boolean;
  onExport: (format: "csv" | "xlsx") => void | Promise<void>;
}) {
  if (!comparison) return null;
  const roleOf = (source: SourceRef): SourceRole | undefined => {
    if (!compareIds) return undefined;
    if (source.fileId === compareIds.baseFileId) return "base";
    if (source.fileId === compareIds.targetFileId) return "current";
    return undefined;
  };
  const baseName = compareIds ? fileNames.get(compareIds.baseFileId) ?? "미선택" : "미선택";
  const targetName = compareIds ? fileNames.get(compareIds.targetFileId) ?? "미선택" : "미선택";
  const semanticClaims = enrichment?.operation === "semantic-check" ? enrichment.claims : [];
  const summaryItems = [
    { key: "total", label: "전체 변경", value: comparison.summary.total },
    { key: "changed", label: "변경", value: comparison.summary.changed },
    { key: "added", label: "추가", value: comparison.summary.added },
    { key: "removed", label: "삭제", value: comparison.summary.removed },
    { key: "structural", label: "구조 변경", value: comparison.summary.structural },
    { key: "important", label: "중요 변경", value: comparison.summary.important },
  ];
  const compareValue = (value: string | null): string => value === null || value === "" ? "—" : value;
  /** Pure numeric measures align right; calendar values remain left-aligned text. */
  const NUMERIC_TEXT = /^[+-]?[\d,]+(\.\d+)?\s*(%|원|건|개|명|배|배수|kg|km|톤|시간|분|일|주|개월|월|년)?$/u;
  const CALENDAR_TEXT = /^(?:\d{2,4}[-./]\d{1,2}(?:[-./]\d{1,2})?\.?|\d{4}년(?:\s*\d{1,2}월(?:\s*\d{1,2}일)?)?)$/u;
  const alignedValue = (value: string | null): boolean => {
    const text = (value ?? "").trim();
    return text.length > 0 && !CALENDAR_TEXT.test(text) && NUMERIC_TEXT.test(text);
  };
  /** Only a numbers-only column reads from the right; values and prose read from the left. */
  return (
    <section className="panel results-panel comparison-panel">
      <ResultHeader
        title="버전 비교 결과"
        status={status}
        meta={<ResultExportButtons busy={busy} onExport={onExport} />}
      />
      <div className="comparison-file-map" aria-label="비교 파일 방향">
        <div>
          <span>기준 파일</span>
          <strong title={baseName} tabIndex={0}>{baseName}</strong>
        </div>
        <span className="comparison-direction" aria-hidden="true">→</span>
        <div>
          <span>대상 파일</span>
          <strong title={targetName} tabIndex={0}>{targetName}</strong>
        </div>
      </div>
      <dl className="summary executive-summary">{summaryItems.map((item) => <div key={item.key} className={`summary-${item.key}`} data-empty={item.value === 0}><dt>{item.label}</dt><dd>{item.value.toLocaleString("ko-KR")}</dd></div>)}</dl>
      {comparison.items.length === 0 ? (
        <StatusPanel variant="success" className="result-clear" title="비교된 변경 사항이 없습니다."><p>지원되는 내용, 수치 및 구조 범위에서 두 파일이 같습니다.</p></StatusPanel>
      ) : (
        <div className="comparison-content">
          <div className="change-table" role="table" aria-label="버전 비교 변경 상세">
            <div className="change-head" role="row">
              <span role="columnheader" data-align="start">변경 유형</span>
              <span role="columnheader" data-align="start">기준 파일 값</span>
              <span role="columnheader" data-align="start">대상 파일 값</span>
              <span role="columnheader" data-align="start">변동</span>
              <span role="columnheader" data-align="start">근거</span>
            </div>
            {comparison.items.map((item: ComparisonItem) => (
              <div className="change-row" role="row" key={item.id} data-testid="change-row" data-category={item.category}>
                <span role="cell" className="change-category-cell"><strong className={`category-label category-${item.category.toLowerCase().replaceAll(" ", "-")}`}>{categoryLabels[item.category]}</strong></span>
                <span role="cell" data-label="기준 파일 값" className={alignedValue(item.previous) ? "numeric change-value" : "change-value"}>{compareValue(item.previous)}</span>
                <span role="cell" data-label="대상 파일 값" className={alignedValue(item.current) ? "numeric change-value" : "change-value"}>{compareValue(item.current)}</span>
                <span role="cell" data-label="변동" className={`numeric change-delta${item.deltaText === null ? " change-empty" : ""}`}>
                  {item.deltaText === null ? "—" : item.deltaText}
                  {item.deltaText === null || item.changePercent === null ? null : <small>{item.changePercent > 0 ? "+" : ""}{item.changePercent.toFixed(2)}%</small>}
                </span>
                <div role="cell" data-label="근거" className="source-actions"><ResultSource sources={item.sources} fileNames={fileNames} onSource={onSource} roleOf={roleOf} emptyLabel="근거 없음" /></div>
              </div>
            ))}
          </div>
        </div>
      )}
      {semanticClaims.length ? (
        <section className="result-subsection comparison-semantic-section" aria-labelledby="comparison-semantic-title">
          <div className="subsection-heading">
            <h3 id="comparison-semantic-title">주요 변화</h3>
            <span>{semanticClaims.length}건</span>
          </div>
          <div className="analysis-reading-list">
            {semanticClaims.map((claim) => (
              <article className="analysis-reading-row" key={claim.id}>
                <p>{claimDisplayText(claim)}</p>
                <div className="analysis-reading-actions">
                  <ResultSource
                    sources={claim.evidence.map((binding) => binding.source)}
                    fileNames={fileNames}
                    onSource={onSource}
                    roleOf={roleOf}
                  />
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {detail ? <SourceDetail entries={detail.entries} fileNames={fileNames} onClose={onCloseSource} /> : null}
    </section>
  );
}

function ValueCheckView({ result, fileNames, onSource, status, busy, onExport }: {
  result: ValueCheckResult | null;
  fileNames: Map<string, string>;
  onSource: SourceHandler;
  status: ResultStatus | null;
  busy: boolean;
  onExport: (format: "csv" | "xlsx") => void | Promise<void>;
}) {
  const [filter, setFilter] = useState<ValueCheckFilter>("all");
  if (!result) return null;

  const visible = filter === "all"
    ? result.groups
    : result.groups.filter((group) => group.status === filter);
  const filters: Array<{ key: ValueCheckFilter; label: string; count: number }> = [
    { key: "all", label: "전체", count: result.summary.total },
    { key: "different", label: "값 차이", count: result.summary.different },
    { key: "consistent", label: "일치", count: result.summary.consistent },
    { key: "partial", label: valueCheckStatusLabels.partial, count: result.summary.partial },
  ];
  const twoFiles = result.fileIds.length === 2;
  const comparedFileNames = result.fileIds.map((fileId) => fileNames.get(fileId) ?? fileId);

  return (
    <section className="panel results-panel value-check-panel">
      <ResultHeader
        title="값 일치 확인 결과"
        status={status}
        meta={result.groups.length ? <ResultExportButtons busy={busy} onExport={onExport} /> : undefined}
      />
      {/*
        * The filter row already carries every count, so a second summary line
        * would only repeat 전체 · 값 차이 · 일치 · 일부 파일만 확인 twice.
        */}
      <div className="value-check-toolbar">
        {result.groups.length ? (
          <fieldset className="segmented value-check-filters" aria-label="값 일치 결과 필터">
            {filters.map((entry) => (
              <label key={entry.key} data-empty={entry.count === 0} data-key={entry.key}>
                <input
                  type="radio"
                  name="value-check-filter"
                  value={entry.key}
                  checked={filter === entry.key}
                  onChange={() => setFilter(entry.key)}
                />
                <span>{entry.label} <b>{entry.count}</b></span>
              </label>
            ))}
          </fieldset>
        ) : null}
      </div>

      {result.groups.length === 0 ? (
        <StatusPanel variant="info" className="result-clear" title="공통으로 비교할 수 있는 항목이 없습니다.">
          <p>선택한 파일에서 같은 항목명이 두 개 이상 확인되면 값 일치 여부를 보여 줍니다.</p>
        </StatusPanel>
      ) : visible.length === 0 ? (
        <p className="value-check-filter-empty">이 상태에 해당하는 항목이 없습니다.</p>
      ) : twoFiles ? (
        <div className="value-check-matrix" role="table" aria-label="두 파일 값 일치 확인">
          <div className="value-check-matrix-head" role="row">
            <span role="columnheader">항목</span>
            {comparedFileNames.map((name, index) => <span role="columnheader" key={result.fileIds[index]} title={name} tabIndex={0}>{name}</span>)}
            <span role="columnheader">판정</span>
          </div>
          {visible.map((group) => (
            <div className="value-check-matrix-row" role="row" key={group.id} data-testid="value-check-group" data-status={group.status}>
              <strong role="rowheader" data-label="항목">{group.field}</strong>
              {result.fileIds.map((fileId, fileIndex) => {
                const occurrences = group.occurrences.filter((entry) => entry.fileId === fileId);
                return (
                  <div role="cell" className="value-check-matrix-value" data-label={comparedFileNames[fileIndex]} key={fileId}>
                    {occurrences.length ? occurrences.map((entry) => (
                      <div className="value-check-cell-entry" key={entry.id}>
                        <span>{entry.displayValue}</span>
                        <ResultSource sources={entry.sources} fileNames={fileNames} onSource={onSource} />
                      </div>
                    )) : <span className="value-check-no-value">—</span>}
                  </div>
                );
              })}
              <span role="cell" className="value-check-verdict" data-label="판정">
                <span className={`value-check-status status-${group.status}`}>{valueCheckStatusLabels[group.status]}</span>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="value-check-list" aria-label="값 일치 확인 항목">
          {visible.map((group) => {
            const collapsed = group.status === "consistent";
            const values = [...new Set(group.occurrences.map((entry) => entry.displayValue))];
            const sources = group.occurrences.flatMap((entry) => entry.sources);
            return (
              <article className="value-check-group" key={group.id} data-testid="value-check-group" data-status={group.status}>
                <header>
                  <h3>{group.field}</h3>
                  <span className={`value-check-status status-${group.status}`}>{valueCheckStatusLabels[group.status]}</span>
                </header>
                {group.missingFileIds.length ? (
                  <p className="value-check-missing">{valueCheckStatusLabels.partial}: {group.missingFileIds.map((fileId) => fileNames.get(fileId) ?? fileId).join(" · ")}</p>
                ) : null}
                <div className="value-check-occurrences">
                  {collapsed ? (
                    <div className="value-check-occurrence">
                      <span data-label="파일">{group.occurrences.map((entry) => fileNames.get(entry.fileId) ?? entry.fileName).join(" · ")}</span>
                      <strong data-label="값">{values.join(" · ")}</strong>
                      <div data-label="근거"><ResultSource sources={sources} fileNames={fileNames} onSource={onSource} /></div>
                    </div>
                  ) : group.occurrences.map((entry) => (

                    <div className="value-check-occurrence" key={entry.id}>
                      <span data-label="파일" title={entry.fileName}>{fileNames.get(entry.fileId) ?? entry.fileName}</span>
                      <strong data-label="값">{entry.displayValue}</strong>
                      <div data-label="근거"><ResultSource sources={entry.sources} fileNames={fileNames} onSource={onSource} /></div>
                    </div>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
const SHEET_PLAN_LABELS: Record<AggregationSheet["plan"]["kind"], string> = {
  target: "기준 시트",
  append: "기준 시트에 추가",
  summarized: "기준 요약으로 재계산",
  unmatched: "대응 시트 없음",
  ignored: "취합 대상 아님",
};

function AggregationResults({ draft, selection, busy, onSelection, onExport }: {
  draft: AggregationDraft | null;
  selection: AggregationSelection | null;
  busy: boolean;
  onSelection: (selection: AggregationSelection) => void;
  onExport: () => void | Promise<void>;
}) {
  const [allMappings, setAllMappings] = useState(false);
  // Nothing analysed yet is nothing to show: the section heading and the run
  // action already say what this destination does.
  if (!draft || !selection) return null;

  const selectedSheets = new Set(selection.sheetIds);
  const sheets = draft.workbooks.flatMap((workbook) => workbook.sheets);
  const sheetById = new Map(sheets.map((sheet) => [sheet.id, sheet]));
  const targetById = new Map(draft.targets.map((target) => [target.id, target]));
  const overrides = new Map(selection.mappings.map((mapping) => [mapping.id, mapping]));
  const mappings = draft.mappings.map((mapping) => ({ ...mapping, ...overrides.get(mapping.id) }));
  const resultTargets = draft.targets.filter((target) => selectedSheets.has(target.sheetId));
  // The same record set the XLSX writes: template rows, then each selected
  // source sheet's own table in selection order.
  const recordsOf = (target: AggregationTarget) => {
    const regions = new Map(target.sheetIds.filter((id) => selectedSheets.has(id)).map((id) => {
      const sheet = sheetById.get(id);
      return [id, sheet ? primaryRegion(sheet)?.id : undefined] as const;
    }));
    return draft.records.filter((record) => regions.has(record.sheetId) && (record.sheetId === target.sheetId || regions.get(record.sheetId) === record.regionId));
  };
  const tableTargets = resultTargets.filter((target) => target.kind === "records" || target.kind === "source");
  const recordsByTarget = new Map(tableTargets.map((target) => [target.id, recordsOf(target)]));
  const sequences = new Map(tableTargets.map((target) => [target.id, sequenceCells(recordsByTarget.get(target.id) ?? [], mappings.filter((mapping) => mapping.targetId === target.id), target.sheetId)]));
  const selectedRecords = [...recordsByTarget.values()].flat();
  const columnsOf = (target: AggregationTarget) => mappings
    .filter((mapping) => mapping.targetId === target.id && mapping.included)
    .sort((left, right) => (left.targetColumn ?? Number.MAX_SAFE_INTEGER) - (right.targetColumn ?? Number.MAX_SAFE_INTEGER));
  const relevant = mappings.filter((mapping) => {
    const target = targetById.get(mapping.targetId);
    return target && selectedSheets.has(target.sheetId) && mapping.sourceFields.some((field) => field.sheetId !== target.sheetId && selectedSheets.has(field.sheetId));
  });
  const reviewMappings = relevant.filter((mapping) => mapping.status === "review");
  const visibleMappings = allMappings ? relevant : reviewMappings;
  const linkedImages = new Set(selectedRecords.flatMap((record) => record.media.map((media) => `${media.source.fileId}\0${media.id}`)));
  const unlinkedImages = sheets
    .filter((sheet) => selectedSheets.has(sheet.id) && sheet.plan.kind !== "target")
    .flatMap((sheet) => {
      const headerEnd = Number(/:[A-Z]+(\d+)$/iu.exec(primaryRegion(sheet)?.headerRange ?? "")?.[1] ?? 0);
      return sheet.media.filter((media) => !linkedImages.has(`${media.source.fileId}\0${media.id}`) && (media.source.row ?? Infinity) > headerEnd);
    }).length;
  // A flagged sheet is settled once the user includes it; a note about how the
  // target's own rows are filled stays while that target is in the result.
  const pendingIssues = draft.issues.filter((issue) => {
    const sheet = sheetById.get(issue.id);
    return !sheet || !selectedSheets.has(sheet.id) || (sheet.role === "records" && sheet.plan.kind !== "unmatched");
  });
  const reviewCount = reviewMappings.length + unlinkedImages + pendingIssues.length;
  const toggleSheet = (sheetId: string) => onSelection({
    ...selection,
    sheetIds: selectedSheets.has(sheetId) ? selection.sheetIds.filter((id) => id !== sheetId) : [...selection.sheetIds, sheetId],
  });
  const updateMapping = (id: string, patch: Partial<AggregationSelection["mappings"][number]>) => onSelection({
    ...selection,
    mappings: selection.mappings.map((mapping) => mapping.id === id ? { ...mapping, ...patch } : mapping),
  });
  const previewValue = (record: AggregationRecord, mapping: AggregationFieldMapping, sequence: SequenceCells | undefined) => {
    const text = sequence?.mappingId === mapping.id ? sequence.cells.get(record.id)?.display ?? "" : targetCell(mappedFields(record, mapping), mapping).display;
    const images = mappedImageCount(record, mapping);
    return <>{text || (!images ? "—" : null)}{images ? <small className="aggregation-image-count">{text ? " · " : ""}이미지 {images}개</small> : null}</>;
  };
  const planTarget = (sheet: AggregationSheet) => "targetId" in sheet.plan && sheet.plan.targetId ? targetById.get(sheet.plan.targetId) : undefined;

  return (
    <section className="panel results-panel aggregation-results">
      <ResultHeader title="취합 결과" status={{ tone: "success", label: "취합 완료" }} />
      <div className="extract-result-toolbar aggregation-result-toolbar">
        <p className="check-summary-line">
          <span className="metric">파일 <b>{draft.workbooks.length}</b></span>
          <span className="metric">선택 시트 <b>{selection.sheetIds.length}</b></span>
          <span className="metric">결과 시트 <b>{resultTargets.length}</b></span>
          <span className="metric">취합 레코드 <b>{selectedRecords.length}</b></span>
          <span className="metric" data-empty={reviewCount === 0}>확인 필요 <b>{reviewCount}</b></span>
        </p>
        <ResultExportButtons busy={busy} disabled={resultTargets.length === 0} label="취합 결과 다운로드" xlsxOnly onExport={() => onExport()} />
      </div>

      <section className="aggregation-section" aria-labelledby="aggregation-sheets">
        <div className="aggregation-section-heading">
          <div><h3 id="aggregation-sheets">취합할 시트</h3><p>첫 번째 파일의 시트 구성을 결과로 사용하고, 나머지 파일의 같은 표는 그 아래에 이어 붙입니다.</p></div>
        </div>
        <div className="aggregation-workbooks">
          {draft.workbooks.map((workbook) => (
            <section className="aggregation-workbook" key={workbook.id}>
              <h4>{workbook.fileName}</h4>
              {workbook.sheets.length === 0 ? <p className="aggregation-sheet-empty">취합할 표를 찾지 못했습니다. 표 형태의 내용이 있는 파일을 선택하세요.</p> : null}
              {workbook.sheets.map((sheet) => {
                const target = planTarget(sheet);
                const fixed = sheet.role === "empty" || sheet.plan.kind === "summarized" || sheet.plan.kind === "ignored";
                return (
                  <label className="aggregation-sheet" key={sheet.id} data-role={sheet.plan.kind === "unmatched" ? "review" : sheet.role}>
                    <input type="checkbox" checked={selectedSheets.has(sheet.id)} disabled={fixed} onChange={() => toggleSheet(sheet.id)} />
                    <span><strong>{sheet.name}</strong><small>{sheet.visibility !== "visible" ? `${sheet.visibility} · ` : ""}{SHEET_PLAN_LABELS[sheet.plan.kind]}{sheet.plan.kind === "append" && target ? ` · ${target.name}` : ""}</small></span>
                    <span>{sheet.plan.kind === "summarized" || sheet.plan.kind === "unmatched" ? sheet.reason : sheet.regions.length ? sheet.regions.map((region) => region.recordRange ?? region.headerRange).filter(Boolean).join(", ") : sheet.reason}</span>
                    <b>{primaryRegion(sheet)?.records.length ?? 0}건</b>
                  </label>
                );
              })}
            </section>
          ))}
        </div>
      </section>

      <section className="aggregation-section" aria-labelledby="aggregation-result-sheets">
        <div className="aggregation-section-heading"><div><h3 id="aggregation-result-sheets">결과 시트 {resultTargets.length}개</h3><p>기준 파일의 시트 이름과 구성을 그대로 유지합니다.</p></div></div>
        <ul className="aggregation-result-sheets">
          {resultTargets.map((target) => (
            <li key={target.id}>
              <strong>{target.name}</strong>
              <span>{target.kind === "calculated" ? "기준 수식으로 재계산" : target.kind === "static" ? "기준 시트 유지" : `${recordsByTarget.get(target.id)?.length ?? 0}건`}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="aggregation-section" aria-labelledby="aggregation-mappings">
        <div className="aggregation-section-heading">
          <div>
            <h3 id="aggregation-mappings">확인이 필요한 항목</h3>
            <p>{reviewMappings.length ? `기준 파일 항목과 이름이 달라 확인이 필요한 항목 ${reviewMappings.length}개가 있습니다.` : unlinkedImages ? "이미지를 연결할 레코드를 확인하세요." : "모든 항목을 기준 파일 항목에 자동으로 연결했습니다."}</p>
          </div>
          <button type="button" className="secondary-action" aria-expanded={allMappings} onClick={() => setAllMappings((value) => !value)}>
            {allMappings ? "확인 항목만 보기" : "전체 매핑 보기"}
          </button>
        </div>
        {unlinkedImages > 0 ? <p className="aggregation-unlinked" role="status">미연결 이미지 {unlinkedImages}건 · 첨부 이미지 시트에서 출처와 위치를 확인하세요.</p> : null}
        {pendingIssues.length > 0 ? (
          <ul className="aggregation-issues">
            {pendingIssues.map((issue) => (
              <li key={`${issue.id}:${issue.message}`}><strong>{issue.fileName}{issue.sheetName ? ` · ${issue.sheetName}` : ""}</strong><span>{issue.message}</span></li>
            ))}
          </ul>
        ) : null}
        {visibleMappings.length ? (
          <div className="aggregation-mappings">
            {visibleMappings.map((mapping) => {
              const target = targetById.get(mapping.targetId);
              return (
                <div className="aggregation-mapping" key={mapping.id}>
                  <label><input type="checkbox" checked={mapping.included} onChange={(event) => updateMapping(mapping.id, { included: event.target.checked })} /><span>포함</span></label>
                  {mapping.targetColumn === undefined
                    ? <input value={mapping.targetField} aria-label={`${mapping.targetField} 출력 항목명`} onChange={(event) => updateMapping(mapping.id, { targetField: event.target.value })} />
                    : <strong className="aggregation-mapping-target">{mapping.targetField}</strong>}
                  <div>{mapping.sourceFields.filter((source) => source.sheetId !== target?.sheetId).map((source) => {
                    const sheet = sheetById.get(source.sheetId);
                    return <span key={`${source.sheetId}:${source.field}`}>{sheet?.fileName} · {sheet?.name} · {source.field}</span>;
                  })}</div>
                  <em data-status={mapping.status}>{mapping.status === "review" ? mapping.targetColumn === undefined ? "대응 없음" : "확인" : "연결"}</em>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <section className="aggregation-section" aria-labelledby="aggregation-preview">
        <div className="aggregation-section-heading"><div><h3 id="aggregation-preview">결과 미리보기</h3><p>다운로드할 결과 시트와 같은 기준 항목으로 시트당 최대 20건을 표시합니다.</p></div></div>
        {tableTargets.map((target) => {
          const columns = columnsOf(target);
          const records = recordsByTarget.get(target.id) ?? [];
          if (records.length === 0 || columns.length === 0) {
            return <p className="aggregation-preview-empty" key={target.id}>{target.name}: {records.length ? "포함된 항목이 없습니다." : "표시할 레코드가 없습니다."}</p>;
          }
          const files = draft.workbooks.filter((workbook) => workbook.sheets.some((sheet) => target.sheetIds.includes(sheet.id) && selectedSheets.has(sheet.id)));
          return (
            <section className="aggregation-preview-group" key={target.id} aria-label={`${target.name} 미리보기`}>
              <div className="aggregation-preview-heading"><h4>{target.name}</h4><span>{Math.min(records.length, 20)} / {records.length}건</span></div>
              <div className="aggregation-preview-wrap" role="region" aria-label={`${target.name} 표, 가로로 스크롤 가능`} tabIndex={0}>
                <table className="aggregation-preview" style={{ minWidth: Math.max(760, columns.length * 150) }}>
                  <thead><tr>{columns.map((mapping) => <th scope="col" key={mapping.id}>{mapping.targetField}</th>)}</tr></thead>
                  <tbody>{records.slice(0, 20).map((record) => (
                    <tr key={record.id}>{columns.map((mapping) => <td key={mapping.id}>{previewValue(record, mapping, sequences.get(target.id))}</td>)}</tr>
                  ))}</tbody>
                </table>
              </div>
              <p className="aggregation-preview-provenance">출처: {files.map((workbook) => workbook.fileName).join(", ")}{records.some((record) => record.duplicateOf) ? " · 중복 후보 포함" : ""}</p>
            </section>
          );
        })}
        {resultTargets.length === 0 ? <p className="aggregation-preview-empty">시트를 선택하면 결과를 미리 볼 수 있습니다.</p> : null}
      </section>
    </section>
  );
}

/**
 * The inspector groups only byte-identical quotes from the same file. Every
 * SourceRef remains in the group so location coverage is preserved.
 */
function SourceDetail({ entries, fileNames, onClose }: {
  entries: readonly DetailEntry[];
  fileNames: Map<string, string>;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);
  const fileList = [...new Set(entries.map(({ source }) => fileNames.get(source.fileId)).filter((name): name is string => Boolean(name)))];
  const fileHeading = fileList.join(" · ");
  const multipleFiles = new Set(entries.map(({ source }) => source.fileId)).size > 1;
  const groups: Array<{ key: string; entries: DetailEntry[] }> = [];
  const groupByKey = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    const quote = entry.source.quote?.trim();
    const key = quote ? `${entry.source.fileId}\0${quote}` : `${entry.source.fileId}\0${entry.source.nodeId}\0${index}`;
    const groupIndex = groupByKey.get(key);
    if (groupIndex === undefined) {
      groupByKey.set(key, groups.length);
      groups.push({ key, entries: [entry] });
    } else {
      groups[groupIndex].entries.push(entry);
    }
  }
  return (
    <aside ref={panelRef} className="source-detail" aria-label="근거 상세" tabIndex={-1}>
      <header>
        <div>
          <h2>근거 상세</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="닫기">닫기</button>
      </header>
      {fileHeading ? <p className="evidence-file-list" title={fileHeading}>{fileHeading}</p> : null}
      <div className="evidence-type"><span>원문</span><p>문서에서 확인된 근거 · {entries.length.toLocaleString("ko-KR")}곳</p></div>
      {groups.map((group, index) => {
        const [lead] = group.entries;
        const locations = [...new Set(group.entries.map(({ source, role }) => {
          const roleLabel = roleText(role);
          return `${locatorText(source)}${roleLabel ? ` · ${roleLabel}` : ""}`;
        }))];
        const fileName = multipleFiles ? fileNames.get(lead.source.fileId) : undefined;
        return (
          <section className="evidence-entry" key={group.key}>
            <h3>근거 {index + 1}{fileName ? ` · ${fileName}` : ""}</h3>
            <ul className="evidence-location-list" aria-label={`근거 ${index + 1} 위치`}>
              {locations.map((location) => <li key={location}>{location}</li>)}
            </ul>
            <blockquote>{lead.source.quote ?? "인용문이 제공되지 않았습니다."}</blockquote>
          </section>
        );
      })}
    </aside>
  );
}
