"use client";

import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AiAvailableResult, AiRequest, EvidenceBinding, GroundedClaim } from "@/domain/ai";
import type { ComparisonItem, ComparisonResult } from "@/domain/compare";
import type { DocumentMetadata, SourceRef } from "@/domain/document";
import {
  checkCategoryGroup,
  type AnalyzeResult,
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
  extractServerAi,
  generateServerAi,
  interruptServerAi,
  polishServerAi,
  SERVER_AI_MESSAGES,
  type ServerAiFailure,
} from "@/client/server-ai-client";
import { SERVER_AI_MAX_FILES, type ServerAiErrorCode } from "@/lib/ai/api";
import type { CheckEntry as WorkerCheckEntry, WorkspaceFile } from "@/client/protocol";
import {
  EXTRACT_MODE_LABELS,
  EXTRACT_TYPE_LABELS,
  type ExtractMode,
  type StructuredExtract,
} from "@/domain/extract";
import { structuredCsvExport, structuredXlsxExport } from "@/lib/extract/export";
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
  type PolishTextResult,
} from "@/domain/polish";
import { polishClipboardText, polishResult, polishTextResult, reviewProposal, summarizePolish } from "@/lib/polish/engine";
import { isProse } from "@/lib/polish/candidates";
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
import { analysisClaimPresentation, claimDisplayText } from "@/lib/analysis-presentation";
import {
  BarChart3,
  BookMarked,
  GitCompareArrows,
  MessageSquareText,
  PenLine,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Table2,
} from "lucide-react";

type ShellView = Tab | "Dictionary" | "Settings";
export interface CompanyTermEntry { id: number; term: string; description: string | null; active: boolean }
const tabIcons: Record<Tab, typeof BarChart3> = {
  Analyze: BarChart3,
  Ask: MessageSquareText,
  Compare: GitCompareArrows,
  Check: ShieldCheck,
  Polish: PenLine,
  Extract: Table2,
  Brief: ScrollText,
};
type ApiError = { code: string; message: string; retryable?: boolean };
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
type Notice = { tone: "error" | "success" | "info" | "warning"; message: string; scope: NoticeScope; code?: ServerAiErrorCode };

function noticeTitle(notice: Notice): string {
  if (notice.tone === "success") return "작업 완료";
  if (notice.tone === "warning") return "기본 결과를 유지했습니다";
  if (notice.tone !== "error") return "처리 상태";
  return notice.code ? "추가 처리를 완료하지 못했습니다" : "작업을 완료하지 못했습니다";
}

const tabs = ["Analyze", "Ask", "Compare", "Check", "Polish", "Extract", "Brief"] as const;
type Tab = (typeof tabs)[number];
const tabMeta: Record<Tab, { label: string; description: string }> = {
  Analyze: { label: "분석", description: "구조와 수치" },
  Ask: { label: "질문", description: "파일에 질문" },
  Compare: { label: "비교", description: "버전 차이" },
  Check: { label: "검수", description: "품질과 위험" },
  Polish: { label: "윤문", description: "문장 윤문" },
  Extract: { label: "추출", description: "데이터 추출" },
  Brief: { label: "요약", description: "업무 요약" },
};
const completionLabels: Record<Tab, string> = {
  Analyze: "분석 완료",
  Ask: "답변 완료",
  Compare: "비교 완료",
  Check: "검수 완료",
  Polish: "윤문 완료",
  Extract: "추출 완료",
  Brief: "브리프 완료",
};
type ResultStatus = { tone: "success" | "warning"; label: string; message?: string };
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
const severityLabels: Record<CheckFinding["severity"], string> = {
  critical: "Critical",
  warning: "Warning",
  suggestion: "Suggestion",
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
  privacy: "개인정보",
  structure: "구조",
  placeholder: "미완성 문구",
};
const checkGroupLabels: Record<CheckCategoryGroup, string> = {
  writing: "문장",
  consistency: "일관성",
  data: "데이터",
  privacy: "개인정보",
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

function partialPolishMessage(error: unknown, count: number): string {
  const failure = error as Partial<ServerAiFailure>;
  if (failure.code === "RATE_LIMITED") {
    return `윤문 결과는 준비되었습니다. ${count}개 문장은 AI 사용량 제한으로 원문을 유지했습니다.`;
  }
  if (failure.code === "CANCELLED") {
    return `윤문 결과는 준비되었습니다. ${count}개 문장은 처리하지 않았습니다.`;
  }
  return `윤문 결과는 준비되었습니다. ${count}개 문장은 처리하지 못해 원문을 유지했습니다.`;
}

type SourceRole = "base" | "current";
/**
 * The inspector always receives the full set a result row summarised, each
 * source with its own role so a comparison stays readable entry by entry.
 */
type DetailEntry = { source: SourceRef; role?: SourceRole };
type DetailInfo = { entries: readonly DetailEntry[] };


export default function Home() {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("Analyze");
  const [shellView, setShellView] = useState<ShellView>("Analyze");
  const [companyTerms, setCompanyTerms] = useState<CompanyTermEntry[]>([]);
  const [companyTermsSource, setCompanyTermsSource] = useState<"d1" | "seed" | "pending">("pending");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [compareIds, setCompareIds] = useState<{ baseFileId: string; targetFileId: string } | null>(null);
  const [enrichmentResult, setEnrichmentResult] = useState<AiAvailableResult | null>(null);
  const [extractMode, setExtractMode] = useState<ExtractMode>("auto");
  const [extractFields, setExtractFields] = useState<string[]>([]);
  const [structured, setStructured] = useState<StructuredExtract | null>(null);
  const [extractProgress, setExtractProgress] = useState<{ done: number; total: number } | null>(null);
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
  const notifyView = (tone: Notice["tone"], message: string, code?: ServerAiErrorCode) =>
    setNotice({ tone, message, scope: shellView, ...(code ? { code } : {}) });
  /** Affects the whole tab — an upload or a workspace reset — so it follows. */
  const notifyWorkspace = (tone: Notice["tone"], message: string) => setNotice({ tone, message, scope: "workspace" });

  const clearResults = useCallback(() => {
    setOperationResult(null);
    setComparison(null);
    setCompareIds(null);
    setEnrichmentResult(null);
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
      notifyWorkspace("success", `${file.name} 분석이 완료되었습니다.`);
    } catch (error) {
      notifyWorkspace("error", (error as ApiError).message ?? "파일을 처리하지 못했습니다.");
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

  const reportAiFailure = (error: unknown) => {
    const failure = error as Partial<ServerAiFailure>;
    if (failure.code === "CANCELLED") {
      notifyView("info", SERVER_AI_MESSAGES.CANCELLED, failure.code);
      return;
    }
    notifyView("error", failure.message ?? "추가 처리를 완료하지 못했습니다.", failure.code);
  };

  const reportPartialAiFailure = (error: unknown, completedMessage: string) => {
    const failure = error as Partial<ServerAiFailure>;
    const reason = failure.message ?? "추가 처리를 완료하지 못했습니다.";
    notifyView(
      failure.code === "CANCELLED" ? "info" : "warning",
      `${completedMessage} ${reason}`,
      failure.code,
    );
  };

  /**
   * The worker selects and bounds evidence; grounding remains authoritative in
   * the worker after the same-origin server returns model claims.
   */
  const generateGroundedResult = async (request: AiRequest): Promise<AiAvailableResult> => {
    let windowId: string | undefined;
    const noEvidenceMessage = request.operation === "ask"
      ? "선택한 문서에서 답변에 필요한 근거를 찾지 못했습니다."
      : request.operation === "brief"
        ? "선택한 문서에서 브리프에 필요한 근거를 찾지 못했습니다."
        : SERVER_AI_MESSAGES.NO_EVIDENCE;
    try {
      const evidence = await runInWorker({ kind: "evidence", fileIds: selected, request });
      windowId = evidence.windowId;
      if (evidence.items.length === 0) {
        throw { code: "NO_EVIDENCE", message: noEvidenceMessage } satisfies ServerAiFailure;
      }
      const claims = await generateServerAi(request, evidence.items);
      const result = await runInWorker({ kind: "ground", windowId, request, claims });
      windowId = undefined;
      const allowPartialGrounding = request.operation === "ask" || request.operation === "brief";
      if (result.rejectedClaimCount > 0 && !allowPartialGrounding) {
        throw { code: "GROUNDING_REJECTED", message: SERVER_AI_MESSAGES.GROUNDING_REJECTED } satisfies ServerAiFailure;
      }
      if (result.claims.length === 0) {
        throw { code: "NO_EVIDENCE", message: noEvidenceMessage } satisfies ServerAiFailure;
      }
      return result;
    } catch (error) {
      if ((error as Partial<ApiError>).code === "NO_EVIDENCE") {
        throw { code: "NO_EVIDENCE", message: noEvidenceMessage } satisfies ServerAiFailure;
      }
      throw error;
    } finally {
      if (windowId) void runInWorker({ kind: "release-evidence", windowId });
    }
  };

  const runServerTask = async (request: AiRequest, success: string) => {
    if (selected.length > SERVER_AI_MAX_FILES) {
      notifyView("error", `추가 처리는 최대 ${SERVER_AI_MAX_FILES}개 파일만 선택할 수 있습니다.`);
      return;
    }
    setBusy(true);
    setNotice(null);
    setDetail(null);
    try {
      const result = await generateGroundedResult(request);
      setOperationResult(result);
      if ((request.operation === "ask" || request.operation === "brief") && result.rejectedClaimCount > 0) {
        notifyView("warning", "일부 내용은 문서 근거와 연결되지 않아 결과에서 제외했습니다.");
      } else {
        notifyView("success", success);
      }
      return result;
    } catch (error) {
      setOperationResult(null);
      reportAiFailure(error);
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
      notifyView("error", `AI 작업은 최대 ${SERVER_AI_MAX_FILES}개 파일만 선택할 수 있습니다.`);
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
        reportAiFailure(partialFailure);
        return;
      }
      const result = polishResult(polishMode, outcomes);
      setPolish(result);
      if (partialFailure) {
        notifyView("warning", partialPolishMessage(partialFailure, result.summary.failed), (partialFailure as Partial<ServerAiFailure>).code);
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
        reportAiFailure(partialFailure);
        return;
      }
      const result = polishTextResult(polishMode, input, segments, outcomes);
      setPolishTextRun(result);
      if (partialFailure) {
        notifyView("warning", partialPolishMessage(partialFailure, result.summary.failed), (partialFailure as Partial<ServerAiFailure>).code);
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
      let deterministic: unknown;
      try {
        deterministic = await runInWorker({ kind: "analyze", fileIds: selected });
        setOperationResult(deterministic);
      } catch (error) {
        setOperationResult(null);
        notifyView("error", (error as ApiError).message ?? "문서 분석에 실패했습니다.");
        return;
      }

      if (selected.length > SERVER_AI_MAX_FILES) {
        notifyView("warning", `기본 분석을 완료했습니다. 추가 해석은 파일 ${SERVER_AI_MAX_FILES}개 이하에서 실행됩니다.`);
        return deterministic;
      }
      try {
        const enriched = await generateGroundedResult({ operation: "analyze" });
        setEnrichmentResult(enriched);
        notifyView("success", "문서 분석을 완료했습니다. 추가 해석도 반영했습니다.");
      } catch (error) {
        reportPartialAiFailure(error, "기본 분석은 완료했습니다. 추가 해석은 이번 실행에서 제외되었습니다.");
      }
      return deterministic;
    } finally {
      setBusy(false);
      primaryRunInFlight.current = false;
    }
  };

  const runCompare = async () => {
    if (primaryRunInFlight.current || selected.length !== 2) return;
    primaryRunInFlight.current = true;
    setBusy(true);
    setNotice(null);
    setDetail(null);
    setEnrichmentResult(null);
    try {
      const [baseFileId, targetFileId] = selected;
      let deterministic: ComparisonResult;
      try {
        deterministic = await runInWorker({ kind: "compare", baseFileId, targetFileId });
        setComparison(deterministic);
        setCompareIds({ baseFileId, targetFileId });
      } catch (error) {
        setComparison(null);
        setCompareIds(null);
        notifyView("error", (error as ApiError).message ?? "파일 비교에 실패했습니다.");
        return;
      }

      try {
        const enriched = await generateGroundedResult({
          operation: "semantic-check",
          statement: "선택한 문서 사이의 중요한 의미 변화를 근거와 함께 점검하세요.",
        });
        setEnrichmentResult(enriched);
        notifyView("success", "파일 비교를 완료했습니다. 의미 차이 확인도 반영했습니다.");
      } catch (error) {
        reportPartialAiFailure(error, "기본 비교는 완료했습니다. 의미 차이 확인은 이번 실행에서 제외되었습니다.");
      }
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

      if (selected.length > SERVER_AI_MAX_FILES) {
        notifyView("warning", `기본 검수를 완료했습니다. 추가 문장 확인은 파일 ${SERVER_AI_MAX_FILES}개 이하에서 실행됩니다.`);
        return base;
      }
      const request: AiRequest = {
        operation: "semantic-check",
        statement: "선택한 문서의 한글 맞춤법, 띄어쓰기, 조사, 어색한 표현과 용어 일관성을 보수적으로 점검하세요. 확신이 낮은 항목은 제안으로만 표시하세요.",
      };
      try {
        const aiResult = await generateGroundedResult(request);
        const merged = base.map((entry) => {
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
        const total = merged.reduce((sum, entry) => sum + entry.check.findings.length, 0)
          - base.reduce((sum, entry) => sum + entry.check.findings.length, 0);
        notifyView(
          "success",
          total > 0
            ? `문서 검수를 완료했습니다. 추가 문장 제안 ${total}건을 반영했습니다.`
            : "문서 검수를 완료했습니다. 추가할 문장 제안이 없었습니다.",
        );
        return merged;
      } catch (error) {
        reportPartialAiFailure(error, "기본 검수는 완료했습니다. 추가 문장 확인은 이번 실행에서 제외되었습니다.");
        return base;
      }
    } finally {
      setBusy(false);
      primaryRunInFlight.current = false;
    }
  };

  const runActive = async () => {
    if (activeTab === "Polish" && polishInput === "text") return runTextPolish();
    if (!selected.length) return;
    if (activeTab === "Compare") return runCompare();
    if (activeTab === "Analyze") return runAnalyze();
    if (activeTab === "Check") return runCheck();
    if (activeTab === "Extract") return runExtract();
    if (activeTab === "Polish") return runPolish();
    const typed = question.trim();
    return activeTab === "Ask"
      ? runServerTask({ operation: "ask", question: typed }, "질문 결과를 준비했습니다.")
      : runServerTask({ operation: "brief", ...(typed ? { instruction: typed } : {}) }, "핵심 요약을 준비했습니다.");
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
        notifyView("success", `추출 항목 ${deterministic.summary.fields}개 · 확인 필요 ${deterministic.summary.missing}개`);
        return;
      }
      let resolved = deterministic;
      setExtractProgress({ done: 0, total: pending.length });
      for (const [index, task] of pending.entries()) {
        if (extractCancelled.current) break;
        resolved = await resolveFieldWithAi(resolved, task.fileId, task.field);
        setStructured(resolved);
        setExtractProgress({ done: index + 1, total: pending.length });
      }
      notifyView("success", `추출 항목 ${resolved.summary.fields}개 · 확인 필요 ${resolved.summary.missing}개`);
    } catch (error) {
      if (deterministic) {
        reportPartialAiFailure(error, "기본 추출은 완료했습니다. 추가 항목 확인은 이번 실행에서 제외되었습니다.");
      } else {
        reportAiFailure(error);
      }
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

  const deleteAll = () => {
    if (!window.confirm("이 탭에서 처리한 파일과 결과를 모두 지우시겠습니까?")) return;
    disposeWorkspace();
    interruptServerAi();
    setFiles([]);
    setSelected([]);
    clearResults();
    notifyWorkspace("info", "브라우저 메모리에서 파일과 결과를 모두 지웠습니다.");
  };

  // Pasted text is its own input: the Polish action then depends on the
  // textarea, not on the workspace selection, which stays untouched.
  const polishTextMode = activeTab === "Polish" && polishInput === "text";
  const [workSectionTitle, workSectionDescription] = polishTextMode
    ? ["텍스트 윤문", "붙여넣은 내용을 문장 단위로 다듬고 숫자·날짜·인용과 문서 구조를 유지합니다."]
    : workSectionCopy[activeTab];
  const actionDisabled = busy
    || (polishTextMode
      ? polishText.trim().length === 0
      : selected.length === 0 || (activeTab === "Compare" && selected.length !== 2) || (activeTab === "Ask" && !question.trim()));
  const hasCategoryResult = activeTab === "Compare"
    ? comparison !== null
    : activeTab === "Polish"
      ? (polishTextMode ? polishTextRun !== null : polish !== null)
      : activeTab === "Extract" && extractMode !== "text"
        ? structured !== null
        : operationResult !== null;
  const inlineResultNotice = hasCategoryResult
    && notice?.scope === activeTab
    && (notice.tone === "success" || notice.tone === "warning")
    ? notice
    : null;
  const resultStatus: ResultStatus | null = inlineResultNotice
    ? {
      tone: inlineResultNotice.tone === "warning" ? "warning" : "success",
      label: inlineResultNotice.tone === "warning"
        ? activeTab === "Ask" || activeTab === "Brief"
          ? completionLabels[activeTab]
          : activeTab === "Check" ? "검수 완료 · 일부 제외" : activeTab === "Polish" ? "윤문 완료 · 확인 필요" : `${tabMeta[activeTab].label} 부분 완료`
        : completionLabels[activeTab],
      ...(inlineResultNotice.tone === "warning" ? { message: inlineResultNotice.message } : {}),
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
  const companyTermNames = companyTerms.filter((entry) => entry.active).map((entry) => entry.term);
  /**
   * One split, used everywhere: the seven document features share the
   * workspace file state and its actions, the two utility destinations show
   * neither — while the files themselves stay in memory untouched.
   */
  const isUtilityView = shellView === "Dictionary" || shellView === "Settings";
  const isDocumentWorkspaceView = !isUtilityView;
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
        <div className="rail-footer">
          {(["Dictionary", "Settings"] as const).map((view) => {
            const Icon = view === "Dictionary" ? BookMarked : SlidersHorizontal;
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
                <span>{view === "Dictionary" ? "용어 사전" : "설정"}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <div className="shell-main">
        {isUtilityView ? (
          <header className="context-bar utility-bar">
            <h1>{shellView === "Dictionary" ? "용어 사전" : "설정"}</h1>
            <span className="context-names">
              {shellView === "Dictionary"
                ? "맞춤법과 용어 오탐을 줄이기 위한 사전입니다."
                : "이 브라우저에만 적용되는 항목입니다."}
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
              <span className="session-state">파일은 브라우저에서 처리</span>
              {files.length > 0 ? (
                <div className="file-actions">
                  <button type="button" className="file-add" onClick={() => inputRef.current?.click()} disabled={uploading}>
                    {uploading ? "분석 중…" : "파일 추가"}
                  </button>
                  <button type="button" className="delete-all" onClick={deleteAll} disabled={busy}>모두 삭제</button>
                </div>
              ) : null}
            </div>
          </header>
        )}

        <section className="workspace" id="workspace-content" aria-busy={busy || uploading}>
          <input
            ref={inputRef}
            className="file-input"
            type="file"
            multiple
            accept=".xlsx,.csv,.pdf,.docx,.pptx"
            aria-label="작업 파일 선택"
            onChange={(event: ChangeEvent<HTMLInputElement>) => { enqueueUploads(event.target.files); event.target.value = ""; }}
          />
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
                <strong>{uploading ? "파일을 읽고 구조를 분석하는 중" : "파일 추가"}</strong>
                <span>XLSX, CSV, PDF, DOCX, PPTX · 파일당 100 MB · 최대 300 MB</span>
              </div>
              <div className="drop-actions">
                <span className="drop-hint">여기로 끌어놓기</span>
                <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading}>
                  {uploading ? "분석 중…" : "파일 추가"}
                </button>
              </div>
            </div>
          ) : null}

          {isDocumentWorkspaceView && notice && !inlineResultNotice && (notice.scope === "workspace" || notice.scope === shellView) ? (
            <StatusPanel
              className={`notice ${notice.tone}`}
              variant={notice.tone === "error"
                ? "error"
                : notice.tone === "success"
                  ? "success"
                  : notice.tone === "warning"
                    ? "warning"
                    : "info"}
              tone={notice.tone === "error" ? "alert" : "status"}
              live={notice.tone === "error" ? "assertive" : "polite"}
              title={noticeTitle(notice)}
            >
              <p>{notice.message}</p>
              {notice.tone === "error" && !notice.code && notice.scope === "workspace"
                ? <small>파일 형식과 선택 상태를 확인한 뒤 다시 시도하세요.</small>
                : null}
            </StatusPanel>
          ) : null}

          {!isDocumentWorkspaceView ? (
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
          ) : (
            <>
              {polishTextMode || files.length === 0 ? null : (
                <section className="file-list" aria-labelledby="files-heading">
                  <div className="file-list-head" aria-hidden="true"><span>선택</span><span>파일</span><span>상태</span><span>구조</span><span>주의</span></div>
                  {files.map((file) => {
                    const checked = selected.includes(file.id);
                    const counts = structureCounts(file.metadata);
                    return (
                      <article className={`file-row${checked ? " selected" : ""}`} key={file.id}>
                        <label className="select-file">
                          <input type="checkbox" checked={checked} disabled={!checked && selected.length === 10} onChange={() => toggleFile(file.id)} aria-label={`${file.name} 선택`} />
                          <span />
                        </label>
                        <div className="file-info">
                          <strong title={file.name}>{file.name}</strong>
                          <span>{file.kind.toUpperCase()} · {formatBytes(file.size)}</span>
                        </div>
                        <span className={`status status-${file.status.toLowerCase()}`}><span aria-hidden="true" />{file.status}</span>
                        <div className="structure-counts">{counts.length ? counts.map((count) => <span key={count.label}>{count.label}: <b>{count.value}</b></span>) : <span>순서 기반 구조</span>}</div>
                        {file.warnings.length ? <span className="warning" title={file.warnings.join("\n")}>주의 {file.warnings.length}</span> : <span className="muted">없음</span>}
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
                {(activeTab === "Ask" || activeTab === "Brief") ? (
                  <label className="question-field">
                    <input
                      value={question}
                      maxLength={2000}
                      aria-label={activeTab === "Ask" ? "질문 입력" : "브리프 중점 입력"}
                      onChange={(event) => setQuestion(event.target.value)}
                      placeholder={activeTab === "Ask" ? "선택한 문서에서 확인할 내용을 입력하세요" : "중점적으로 정리할 내용을 입력하세요 (선택)"}
                    />
                    <small>{question.length.toLocaleString("ko-KR")} / 2,000</small>
                  </label>
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
                            onChange={() => setPolishInput(input)}
                          />
                          <span>{input === "file" ? "파일 윤문" : "텍스트 윤문"}</span>
                        </label>
                      ))}
                    </fieldset>
                    <fieldset className="segmented polish-modes" aria-label="윤문 방식">
                      {POLISH_MODES.map((mode) => (
                        <label key={mode}>
                          <input
                            type="radio"
                            name="polish-mode"
                            value={mode}
                            checked={polishMode === mode}
                            disabled={busy}
                            onChange={() => setPolishMode(mode)}
                          />
                          <span>{POLISH_MODE_LABELS[mode]}</span>
                        </label>
                      ))}
                    </fieldset>
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
                {activeTab !== "Extract" ? (
                  <div className="operation-actions">
                    <button type="button" onClick={runActive} disabled={actionDisabled} aria-label={`${tabMeta[activeTab].label} ${RUN_LABEL}`}>{busy ? "처리 중…" : RUN_LABEL}</button>
                  </div>
                ) : null}
              </section>

              {busy && polishProgress ? (
                <StatusPanel variant="info" className="processing-bar compact-progress" live="polite" title={`윤문 처리 중 ${polishProgress.done}/${polishProgress.total}`}>
                  <small>문장 단위로 처리하고 있습니다.</small>
                  <div className="ai-status-actions">
                    <button type="button" className="secondary-action" onClick={() => { polishCancelled.current = true; interruptServerAi(); }}>생성 중지</button>
                  </div>
                </StatusPanel>
              ) : busy && extractProgress ? (
                <StatusPanel variant="info" className="processing-bar compact-progress" live="polite" title={`항목 확인 중 ${extractProgress.done}/${extractProgress.total}`}>
                  <small>항목별 근거를 확인하고 있습니다.</small>
                  <div className="ai-status-actions">
                    <button type="button" className="secondary-action" onClick={() => { extractCancelled.current = true; interruptServerAi(); }}>생성 중지</button>
                  </div>
                </StatusPanel>
              ) : null}

              {activeTab === "Compare"
                ? <ComparisonView comparison={comparison} compareIds={compareIds} fileNames={fileNames} detail={null} onSource={openSource} onCloseSource={closeSource} status={resultStatus} />
                : polishTextMode
                  ? <PolishTextResults result={polishTextRun} status={resultStatus} />
                  : activeTab === "Polish"
                  ? <PolishResults result={polish} fileNames={fileNames} onSource={openSource} status={resultStatus} />
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
                    polishMode={polishMode}
                    resultActions={activeTab === "Extract" && extractMode === "text"
                      ? <ExtractExportButtons busy={busy} onExport={exportFiles} />
                      : undefined}
                    dictionary={{ userTerms, ignoredRules, onAddTerm: addTerm, onRemoveTerm: removeTerm, onClearTerms: clearTerms, onToggleRule: toggleRule }}
                  />}
              {enrichmentResult && activeTab !== "Analyze"
                ? <EnrichmentResultView tab={activeTab} result={enrichmentResult} fileNames={fileNames} onSource={openSource} polishMode={polishMode} />
                : null}
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
 * Check, Extract, Brief and the dictionary surfaces cannot drift apart.
 *
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
      return `Slide ${locator.slide} · ${locator.tableCell ? "표" : "본문"}`;
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
  role === "base" ? "기준" : role === "current" ? "현재" : undefined;

/**
 * The evidence inspector is the one surface that must name the file. The
 * document version stays in the SourceRef — it is how two same-named
 * revisions are told apart in code — but it is not shown: a user reads a file
 * name and a locator, not a hash.
 */
function sourceLabel(source: SourceRef, fileNames: Map<string, string>, role?: SourceRole): string {
  const fileName = fileNames.get(source.fileId);
  const parts = [fileName, locatorText(source), roleText(role)].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

type AnalyzeEntry = { file: { id: string; name: string }; analysis: AnalyzeResult };
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
  polishMode: PolishMode;
  dictionary: Omit<CheckViewProps, "entries" | "fileNames" | "onSource">;
  resultActions?: React.ReactNode;
}

/** Shared heading copy for every category's lower work section. */
const workSectionCopy: Record<Tab, [string, string]> = {
  Analyze: ["문서 분석", "선택한 파일의 구조와 주요 수치를 분석합니다."],
  Ask: ["질문하기", "선택한 파일을 근거로 질문에 답합니다."],
  Compare: ["파일 비교", "선택한 파일 간 주요 변경 사항과 차이를 비교합니다."],
  Check: ["문서 검수", "선택한 파일의 문장·일관성·데이터·개인정보를 검수합니다."],
  Polish: ["문서 윤문", "선택한 파일의 번역투와 중복 표현을 문장 단위로 다듬습니다."],
  Extract: ["정보 추출", "선택한 파일에서 필요한 항목과 값을 찾아 정리합니다."],
  Brief: ["핵심 요약", "선택한 파일의 핵심 내용을 업무 문서 형식으로 정리합니다."],
};

function ResultHeader({ eyebrow, title, status, meta }: {
  eyebrow?: string;
  title: string;
  status: ResultStatus | null;
  meta?: React.ReactNode;
}) {
  return (
    <>
      <div className="panel-heading result-heading">
        <div>{eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}<h2>{title}</h2></div>
        <div className="result-heading-meta">
          {meta}
          {status ? <span className={`result-status ${status.tone}`} role="status">{status.label}</span> : null}
        </div>
      </div>
      {status?.message ? <p className="result-inline-warning" role="status">{status.message}</p> : null}
    </>
  );
}


function ResultView({ tab, result, enrichment, status, fileNames, detail, onSource, onCloseSource, dictionary, polishMode, resultActions }: ResultViewProps) {
  if (!result) return null;

  let content: React.ReactNode;
  if (tab === "Analyze" && Array.isArray(result)) {
    content = <AnalyzeResults entries={result as AnalyzeEntry[]} enrichment={enrichment} fileNames={fileNames} onSource={onSource} polishMode={polishMode} />;
  } else if (tab === "Check" && Array.isArray(result)) {
    content = <CheckResults entries={result as CheckEntry[]} fileNames={fileNames} onSource={onSource} {...dictionary} />;
  } else if (tab === "Extract" && Array.isArray(result)) {
    content = <ExtractResults entries={result as ExtractEntry[]} fileNames={fileNames} onSource={onSource} polishMode={polishMode} />;
  } else if (isAiAvailableResult(result)) {
    content = tab === "Ask"
      ? <AskResults result={result} fileNames={fileNames} onSource={onSource} polishMode={polishMode} />
      : <AiResults result={result} fileNames={fileNames} onSource={onSource} polishMode={polishMode} />;
  } else {
    content = <JsonValue value={result} fileNames={fileNames} onSource={onSource} />;
  }

  return (
    <section className="panel results-panel">
      <ResultHeader
        {...(tab === "Ask" || tab === "Check" || tab === "Extract" ? {} : { eyebrow: `${tab.toUpperCase()} RESULT` })}
        title={tab === "Ask" ? "파일 답변" : tab === "Check" ? "검수 결과" : tab === "Extract" ? "추출 결과" : tab === "Brief" ? "핵심 요약" : "작업 결과"}
        status={status}
        {...(tab === "Extract"
          ? { meta: resultActions }
          : tab === "Ask" || tab === "Check" ? {} : { meta: <span className="result-provenance">근거 연결 결과</span> })}
      />
      {content}
      {detail ? <SourceDetail entries={detail.entries} fileNames={fileNames} onClose={onCloseSource} /> : null}
    </section>
  );
}


function EnrichmentResultView({ tab, result, fileNames, onSource, polishMode }: {
  tab: Tab;
  result: AiAvailableResult;
  fileNames: Map<string, string>;
  onSource: SourceHandler;
  polishMode: PolishMode;
}) {
  return (
    <section className="panel results-panel enrichment-results">
      <div className="panel-heading result-heading">
        <div>
          <p className="eyebrow">{tabMeta[tab].label} 추가 결과</p>
          <h2>{tab === "Compare" ? "의미 차이" : "추가 해석"}</h2>
        </div>
        <span className="result-provenance">근거 연결 결과</span>
      </div>
      <AiResults result={result} fileNames={fileNames} onSource={onSource} polishMode={polishMode} />
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
          {(["auto", "fields", "text"] as const).map((entry) => (
            <label key={entry}>
              <input type="radio" name="extract-mode" value={entry} checked={mode === entry} disabled={busy} onChange={() => onMode(entry)} />
              <span>{entry === "text" ? "전체 텍스트" : EXTRACT_MODE_LABELS[entry]}</span>
            </label>
          ))}
        </fieldset>
        <button type="button" className="extract-run" disabled={runDisabled} aria-label="추출 실행" onClick={onRun}>{busy ? "처리 중…" : RUN_LABEL}</button>
      </div>
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

function ExtractExportButtons({ busy, onExport }: {
  busy: boolean;
  onExport: (format: "csv" | "xlsx") => void | Promise<void>;
}) {
  return (
    <div className="extract-export-actions">
      <button type="button" className="secondary-action" onClick={() => void onExport("csv")} disabled={busy}>CSV 다운로드</button>
      <button type="button" className="secondary-action" onClick={() => void onExport("xlsx")} disabled={busy}>XLSX 다운로드</button>
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
  const [view, setView] = useState<"fields" | "table">("table");
  if (!result) return null;

  const multiFile = result.files.length > 1;
  const asTable = view === "table";
  const columns = result.mode === "fields"
    ? result.requestedFields
    : [...new Set(result.files.flatMap((file) => file.fields.map((field) => field.field)))];
  const types = new Set(result.files.flatMap((file) => file.fields.map((field) => field.type)));
  const showType = [...types].some((type) => type !== "Text");
  const isEmpty = result.summary.fields === 0 && result.summary.records === 0;

  return (
    <section className="panel results-panel extract-results">
      <ResultHeader title="추출 결과" status={status} />
      <div className="extract-result-toolbar">
        <p className="check-summary-line">
          <span className="metric">추출 항목 <b>{result.summary.fields}</b></span>
          <span className={`metric${result.summary.missing ? " needs-review" : ""}`}>확인 필요 <b>{result.summary.missing}</b></span>
          {result.summary.records ? <span className="metric">반복 표 <b>{result.summary.records}</b></span> : null}
          {result.summary.lowConfidence ? <span className="metric needs-review">낮은 확신 <b>{result.summary.lowConfidence}</b></span> : null}
        </p>
        {!isEmpty ? (
          <div className="extract-result-actions">
            <div className="extract-view-toggle">
              <button type="button" aria-pressed={asTable} onClick={() => setView("table")}>표 보기</button>
              <button type="button" aria-pressed={!asTable} onClick={() => setView("fields")}>항목 보기</button>
            </div>
            {result.summary.fields > 0 ? <ExtractExportButtons busy={busy} onExport={onExport} /> : null}
          </div>
        ) : null}
      </div>

      {isEmpty ? (
        <StatusPanel
          variant="info"
          className="result-clear"
          title={result.mode === "fields" && result.summary.missing
            ? "선택한 파일에서 지정한 항목을 찾지 못했습니다."
            : "추출된 항목이 없습니다."}
        >
          <p>필요한 항목이 정해져 있다면 항목 지정 추출을 사용해 보세요. 원문 전체가 필요하면 전체 텍스트 내보내기를 선택하세요.</p>
        </StatusPanel>
      ) : null}

      {!isEmpty && asTable && result.mode === "fields" ? (
        <div className="extract-table-wrap requested-fields-table">
          <table className="extract-table">
            <thead><tr>{multiFile ? <th>파일</th> : null}{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
            <tbody>
              {result.files.map((file) => (
                <tr key={file.file.id}>
                  {multiFile ? <td data-label="파일" title={file.file.name}>{file.file.name}</td> : null}
                  {columns.map((column) => {
                    const field = file.fields.find((entry) => entry.field === column);
                    return (
                      <td key={column} data-label={column}>
                        {field ? (
                          <div className="extract-value-cell">
                            <span>{field.displayValue}</span>
                            <CompactResultSource sources={field.sources} fileNames={fileNames} onSource={onSource} />
                          </div>
                        ) : <span className="extract-missing">확인 필요</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {!isEmpty && asTable && result.mode === "auto" ? (
        <div className={`data-table extract-auto-table${multiFile ? " multi-file" : ""}${showType ? " with-type" : ""}`} role="table" aria-label="자동 추출 결과">
          <div className="data-head" role="row">
            {multiFile ? <span role="columnheader">파일</span> : null}
            <span role="columnheader">항목</span>
            <span role="columnheader">값</span>
            {showType ? <span role="columnheader">형식</span> : null}
            <span role="columnheader">근거</span>
          </div>
          {result.files.flatMap((file) => file.fields.map((field) => (
            <div className="data-row" role="row" key={`${file.file.id}-${field.field}-${field.displayValue}`}>
              {multiFile ? <span role="cell" data-label="파일" title={file.file.name}>{file.file.name}</span> : null}
              <span role="cell" data-label="항목" className="extract-field-name">{field.field}</span>
              <span role="cell" data-label="값" className="extract-field-value" title={field.normalizedValue ? `정규화: ${field.normalizedValue}` : undefined}>{field.displayValue}</span>
              {showType ? <span role="cell" data-label="형식" className="extract-field-type">{EXTRACT_TYPE_LABELS[field.type]}{field.confidence ? ` · 확신 ${field.confidence}` : ""}</span> : null}
              <span role="cell" data-label="근거"><CompactResultSource sources={field.sources} fileNames={fileNames} onSource={onSource} /></span>
            </div>
          )))}
        </div>
      ) : null}

      {!isEmpty && !asTable ? result.files.map((file) => (
        <article className="document-result extract-item-view" key={file.file.id}>
          <header className="document-result-heading"><div><span>추출 파일</span><h3 title={file.file.name}>{file.file.name}</h3></div><small>항목 {file.fields.length}개</small></header>
          <dl className="extract-field-list">
            {file.fields.map((field) => (
              <div key={`${field.field}-${field.displayValue}`}>
                <dt>{field.field}</dt>
                <dd>
                  <strong>{field.displayValue}</strong>
                  {showType ? <span className="extract-field-meta">{EXTRACT_TYPE_LABELS[field.type]}{field.confidence ? ` · 확신 ${field.confidence}` : ""}</span> : null}
                  <CompactResultSource sources={field.sources} fileNames={fileNames} onSource={onSource} />
                </dd>
              </div>
            ))}
            {file.missing.map((field) => (
              <div className="extract-missing-row" key={`missing-${field}`}>
                <dt>{field}</dt>
                <dd><span className="extract-missing">확인 필요</span></dd>
              </div>
            ))}
          </dl>
        </article>
      )) : null}

      {!isEmpty ? result.files.flatMap((file) => file.records.map((record) => (
        <section className="result-subsection" key={`${file.file.id}-${record.id}`}>
          <div className="subsection-heading"><h4>{file.file.name} · {record.title}</h4><CompactResultSource sources={[record.source]} fileNames={fileNames} onSource={onSource} /></div>
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
      ))) : null}
    </section>
  );
}

/**
 * Polish result list. Rewrites first, everything the run left alone folded
 * away: a review is read by what changed, not by what did not.
 */
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
    <section className="panel results-panel">
      <ResultHeader
        eyebrow="POLISH RESULT"
        title="문장 윤문"
        status={status}
        meta={<span className="result-provenance">{POLISH_MODE_LABELS[result.mode]}</span>}
      />
      <p className="check-summary-line">
        <span className="metric">변경 제안 <b>{result.summary.changed}</b></span>
        <span className="metric">변경 없음 <b>{result.summary.unchanged}</b></span>
        <span className="metric">보호 검증 차단 <b>{result.summary.rejected}</b></span>
        {changed.length ? (
          <button type="button" className="secondary-action" onClick={() => void navigator.clipboard?.writeText(polishClipboardText(result.outcomes))}>전체 복사</button>
        ) : null}
      </p>

      {changed.length === 0 && rejected.length === 0 ? (
        <StatusPanel variant="success" className="result-clear" title="다듬을 문장을 찾지 못했습니다."><p>선택한 문서의 문장은 이미 자연스럽습니다.</p></StatusPanel>
      ) : null}

      {changed.map((entry) => (
        <article className="polish-row" key={entry.id}>
          <div className="polish-text">
            <span className="polish-label">원문</span>
            <p>{entry.originalText}</p>
            <span className="polish-label">윤문</span>
            <p className="polish-revised">{entry.revisedText}</p>
            {entry.reasons.length ? <em>{entry.reasons.join(" · ")}</em> : null}
          </div>
          <div className="polish-actions">
            {entry.source ? <ResultSource sources={[entry.source]} fileNames={fileNames} onSource={onSource} /> : null}
            <button type="button" className="secondary-action" onClick={() => void navigator.clipboard?.writeText(entry.revisedText)}>복사</button>
          </div>
        </article>
      ))}

      {rejected.map((entry) => (
        <article className="polish-row rejected" key={entry.id}>
          <div className="polish-text">
            <span className="polish-label">원문 유지</span>
            <p>{entry.originalText}</p>
            <em>{entry.rejection ? POLISH_REJECTION_LABELS[entry.rejection] : "윤문 결과를 적용하지 않았습니다."}</em>
          </div>
          <div className="polish-actions">
            {entry.source ? <ResultSource sources={[entry.source]} fileNames={fileNames} onSource={onSource} /> : null}
          </div>
        </article>
      ))}

      {unchanged.length ? (
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
    </section>
  );
}

/**
 * Clipboard with a fallback: a denied Clipboard API permission still has to
 * copy, and the confirmation stays inline instead of raising a page notice.
 */
function CopyButton({ text, label }: { text: string; label: string }) {
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
    <button type="button" className="secondary-action" onClick={() => void copy()}>
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

  return (
    <section className="panel results-panel">
      <ResultHeader
        eyebrow="POLISH RESULT"
        title="텍스트 윤문"
        status={status}
        meta={<span className="result-provenance">{POLISH_MODE_LABELS[result.mode]}</span>}
      />
      <p className="check-summary-line">
        <span className="metric">변경 제안 <b>{result.summary.changed}</b></span>
        <span className="metric">변경 없음 <b>{result.summary.unchanged}</b></span>
        <span className="metric">보호 검증 차단 <b>{result.summary.rejected}</b></span>
      </p>

      {changed ? null : (
        <StatusPanel variant="success" className="result-clear" title="변경 없음">
          <p>현재 문장은 별도 수정이 필요하지 않습니다.</p>
        </StatusPanel>
      )}

      <article className="polish-row polish-text-run">
        <div className="polish-text">
          <span className="polish-label">원문</span>
          <p className="polish-block">{result.originalText}</p>
          <span className="polish-label">윤문</span>
          <p className="polish-block polish-revised">{result.revisedText}</p>
          {reasons.length ? (
            <>
              <span className="polish-label">변경 이유</span>
              <ul className="polish-reasons">{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            </>
          ) : null}
        </div>
        <div className="polish-actions">
          <CopyButton text={result.revisedText} label="윤문 결과 복사" />
          <CopyButton text={result.originalText} label="원문 복사" />
        </div>
      </article>

      {rejected.length ? (
        <StatusPanel variant="warning" className="result-warnings" title={`보호 정보 검증으로 ${rejected.length}개 문장을 원문 그대로 유지했습니다.`}>
          {[...new Set(rejected.map((entry) => entry.rejection ? POLISH_REJECTION_LABELS[entry.rejection] : "윤문 결과를 적용하지 않았습니다."))].map((message) => (
            <p key={message}>{message}</p>
          ))}
        </StatusPanel>
      ) : null}
    </section>
  );
}

/**
 * The inline 윤문 action other features use. One prose string, the shared
 * engine, the same deterministic guard: Ask and Brief claims, Check
 * recommendations and Extract paragraphs all polish through this.
 */
function PolishAction({ text, label, origin, source, mode }: {
  text: string;
  /** Spoken context for the action, e.g. "Ask 답변". */
  label: string;
  origin: PolishCandidate["origin"];
  source?: SourceRef;
  mode: PolishMode;
}) {
  const [outcome, setOutcome] = useState<PolishOutcome | null>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async () => {
    setRunning(true);
    setFailure(null);
    try {
      // No document source, no source: a placeholder locator would name a
      // node that does not exist.
      const candidate: PolishCandidate = {
        id: source?.nodeId ?? label,
        text,
        ...(source ? { source } : {}),
        origin,
      };
      setOutcome(reviewProposal(candidate, await polishServerAi(text, mode)));
    } catch (error) {
      setFailure((error as ServerAiFailure).message ?? "윤문에 실패했습니다.");
    } finally {
      setRunning(false);
    }
  };
  return (
    <span className="polish-inline">
      <button type="button" className="secondary-action" aria-label={`${label} 윤문`} disabled={running} onClick={() => void run()}>
        {running ? "윤문 중…" : "윤문"}
      </button>
      {failure ? <em className="polish-inline-note">{failure}</em> : null}
      {outcome?.status === "changed" ? (
        <span className="polish-inline-result">
          <span className="polish-label">윤문</span>
          <p>{outcome.revisedText}</p>
          {outcome.reasons.length ? <em>{outcome.reasons.join(" · ")}</em> : null}
          <button type="button" className="secondary-action" onClick={() => void navigator.clipboard?.writeText(outcome.revisedText)}>복사</button>
        </span>
      ) : null}
      {outcome?.status === "unchanged" ? <em className="polish-inline-note">이미 자연스러운 문장입니다.</em> : null}
      {outcome?.status === "rejected" ? (
        <em className="polish-inline-note">{outcome.rejection ? POLISH_REJECTION_LABELS[outcome.rejection] : "윤문 결과를 적용하지 않았습니다."}</em>
      ) : null}
    </span>
  );
}

/**
 * The single source presentation for every result type: Analyze insight,
 * Ask/Brief claim, Compare change, Check finding, Extract value.
 *
 * A result row answers "where" and "how many", not "list them all": repeated
 * locators collapse to `· N건`, several locators to `대표 외 N곳`, and one
 * action opens the evidence inspector on the whole set. Nothing is dropped —
 * every SourceRef reaches the inspector, which lists them one by one — so
 * this is presentation only and grounding is untouched.
 */
function ResultSource({ sources, fileNames, onSource, roleOf, emptyLabel = "근거 위치 없음" }: {
  sources: readonly SourceRef[];
  fileNames: Map<string, string>;
  onSource: SourceHandler;
  roleOf?: (source: SourceRef) => SourceRole | undefined;
  emptyLabel?: string;
}) {
  if (sources.length === 0) return <span className="source-empty">{emptyLabel}</span>;
  const acrossFiles = new Set(sources.map((source) => source.fileId)).size > 1;
  const describe = (source: SourceRef): string => {
    // 기준/현재 already identifies the file in a comparison, and the panel
    // header spells both names out; only an unlabelled cross-file item needs
    // the name inline.
    const prefix = roleText(roleOf?.(source)) ?? (acrossFiles ? fileNames.get(source.fileId) : undefined);
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
        onClick={(event) => onSource(sources.map((source) => ({ source, role: roleOf?.(source) })), event.currentTarget)}
      >근거 보기</button>
    </span>
  );
}
function CompactResultSource({ sources, fileNames, onSource }: {
  sources: readonly SourceRef[];
  fileNames: Map<string, string>;
  onSource: SourceHandler;
}) {
  if (sources.length === 0) return <span className="source-empty">근거 위치 없음</span>;
  const acrossFiles = new Set(sources.map((source) => source.fileId)).size > 1;
  const groups: { label: string; count: number }[] = [];
  for (const source of sources) {
    const locator = locatorText(source);
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
  return (
    <button
      type="button"
      className="source-summary-link"
      title={groups.map((entry) => entry.count > 1 ? `${entry.label} · ${entry.count}건` : entry.label).join("\n")}
      aria-label={`${summary} 근거 상세 보기`}
      onClick={(event) => onSource(sources.map((source) => ({ source })), event.currentTarget)}
    >{summary}</button>
  );
}

function AnalyzeResults({ entries, enrichment, fileNames, onSource, polishMode }: {
  entries: AnalyzeEntry[];
  enrichment: AiAvailableResult | null;
  fileNames: Map<string, string>;
  onSource: SourceHandler;
  polishMode: PolishMode;
}) {
  const presentation = analysisClaimPresentation(enrichment);
  const fallbackMetrics = entries.flatMap(({ file, analysis }) => analysis.numeric.count > 0 ? [
    { id: `${file.id}-count`, label: `${file.name} · 숫자 값`, value: analysis.numeric.count.toLocaleString("ko-KR"), sources: analysis.numeric.sources },
    { id: `${file.id}-sum`, label: `${file.name} · 합계`, value: analysis.numeric.sum.toLocaleString("ko-KR"), sources: analysis.numeric.sources },
    { id: `${file.id}-average`, label: `${file.name} · 평균`, value: analysis.numeric.average.toLocaleString("ko-KR", { maximumFractionDigits: 2 }), sources: analysis.numeric.sources },
    { id: `${file.id}-range`, label: `${file.name} · 범위`, value: `${analysis.numeric.minimum.toLocaleString("ko-KR")} ~ ${analysis.numeric.maximum.toLocaleString("ko-KR")}`, sources: analysis.numeric.sources },
  ] : []);
  const metrics = presentation.metrics.length ? presentation.metrics : fallbackMetrics;
  const mismatches = entries.flatMap(({ file, analysis }) =>
    analysis.totals.filter((total) => total.actual !== total.expected).map((total) => ({ file, total })));
  const sourcesOf = (claim: GroundedClaim) => claim.evidence.map((binding) => binding.source);
  const renderClaim = (claim: GroundedClaim, allowPolish = false) => (
    <article className="analysis-reading-row" key={claim.id}>
      <p>{claimDisplayText(claim)}</p>
      <div className="analysis-reading-actions">
        <ResultSource sources={sourcesOf(claim)} fileNames={fileNames} onSource={onSource} />
        {allowPolish ? <PolishAction text={claim.text} label="분석 내용" origin="claim" source={claim.evidence[0]?.source} mode={polishMode} /> : null}
      </div>
    </article>
  );

  return (
    <div className="analysis-report">
      <section className="analysis-report-section analysis-summary-section" aria-labelledby="analysis-summary-title">
        <div className="subsection-heading">
          <h3 id="analysis-summary-title">핵심 요약</h3>
          <span>{presentation.summary.length || entries.length}건</span>
        </div>
        {presentation.summary.length ? (
          <div className="analysis-reading-list">{presentation.summary.map((claim) => renderClaim(claim))}</div>
        ) : (
          <div className="analysis-reading-list">
            {entries.map(({ file, analysis }) => {
              const sources = analysis.structure.tables.map((table) => table.source);
              return (
                <article className="analysis-reading-row" key={file.id}>
                  <p>
                    <strong>{file.name}</strong>에서 표 {analysis.structure.tableCount.toLocaleString("ko-KR")}개,
                    문단 {analysis.structure.paragraphCount.toLocaleString("ko-KR")}개,
                    숫자 값 {analysis.numeric.count.toLocaleString("ko-KR")}개를 확인했습니다.
                  </p>
                  {sources.length ? <ResultSource sources={sources} fileNames={fileNames} onSource={onSource} /> : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {metrics.length ? (
        <section className="analysis-report-section" aria-labelledby="analysis-metrics-title">
          <div className="subsection-heading"><h3 id="analysis-metrics-title">주요 수치</h3><span>{metrics.length}건</span></div>
          <div className="analysis-metric-wrap">
            <table className="analysis-metric-table">
              <thead><tr><th>항목</th><th>값</th><th>근거</th></tr></thead>
              <tbody>
                {metrics.map((metric) => (
                  <tr key={metric.id}>
                    <th scope="row">{metric.label}</th>
                    <td className="numeric">{metric.value}</td>
                    <td>{metric.sources.length ? <ResultSource sources={metric.sources} fileNames={fileNames} onSource={onSource} /> : <span className="source-empty">근거 위치 없음</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {presentation.content.length ? (
        <section className="analysis-report-section" aria-labelledby="analysis-content-title">
          <div className="subsection-heading"><h3 id="analysis-content-title">주요 내용</h3><span>{presentation.content.length}건</span></div>
          <div className="analysis-reading-list">
            {presentation.content.slice(0, 6).map((claim) => renderClaim(claim, true))}
          </div>
          {presentation.content.length > 6 ? (
            <details className="analysis-more">
              <summary>상세 내용 {presentation.content.length - 6}건 보기</summary>
              <div className="analysis-reading-list">{presentation.content.slice(6).map((claim) => renderClaim(claim, true))}</div>
            </details>
          ) : null}
        </section>
      ) : null}

      {presentation.concerns.length || presentation.warnings.length || mismatches.length ? (
        <section className="analysis-report-section analysis-concerns" aria-labelledby="analysis-concerns-title">
          <div className="subsection-heading"><h3 id="analysis-concerns-title">주의 / 확인 필요</h3></div>
          {presentation.concerns.map((claim) => renderClaim(claim))}
          {presentation.warnings.map((warning) => <p className="analysis-warning-line" key={warning.code}><strong>{warning.code}</strong>{warning.message}</p>)}
          {mismatches.map(({ file, total }) => (
            <article className="analysis-reading-row" key={`${file.id}-${total.source.nodeId}`}>
              <p><strong>{file.name}</strong>의 {total.label} 표시값 {total.actual.toLocaleString("ko-KR")}과 계산값 {total.expected.toLocaleString("ko-KR")}이 일치하지 않습니다.</p>
              <ResultSource sources={[total.source]} fileNames={fileNames} onSource={onSource} />
            </article>
          ))}
        </section>
      ) : null}

      <details className="analysis-details">
        <summary>기본 분석 세부 정보</summary>
        <div className="result-sections">
          {entries.map(({ file, analysis }) => (
            <article className="document-result" key={file.id}>
              <header className="document-result-heading"><div><span>FILE ANALYSIS</span><h3 title={file.name}>{file.name}</h3></div><small>{analysis.structure.tableCount} tables · {analysis.structure.paragraphCount} paragraphs</small></header>
              <dl className="summary executive-summary">
                <div><dt>numeric values</dt><dd>{analysis.numeric.count.toLocaleString("ko-KR")}</dd></div>
                <div><dt>Sum</dt><dd>{analysis.numeric.sum.toLocaleString("ko-KR")}</dd></div>
                <div><dt>Average</dt><dd>{analysis.numeric.average.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}</dd></div>
                <div><dt>Minimum</dt><dd>{analysis.numeric.minimum.toLocaleString("ko-KR")}</dd></div>
                <div><dt>Maximum</dt><dd>{analysis.numeric.maximum.toLocaleString("ko-KR")}</dd></div>
                <div><dt>Characters</dt><dd>{analysis.text.characterCount.toLocaleString("ko-KR")}</dd></div>
              </dl>
              {analysis.structure.tables.length ? (
                <section className="result-subsection">
                  <div className="subsection-heading"><h4>구조</h4><span>{analysis.structure.tables.length}개 표</span></div>
                  <div className="data-table analyze-table" role="table" aria-label={`${file.name} 표 구조`}>
                    <div className="data-head" role="row"><span role="columnheader">위치</span><span role="columnheader">행</span><span role="columnheader">열</span><span role="columnheader">근거</span></div>
                    {analysis.structure.tables.map((table) => <div className="data-row" role="row" key={table.blockId}><span role="cell" title={table.source.label}>{table.source.label}</span><span role="cell" className="numeric">{table.rowCount.toLocaleString("ko-KR")}</span><span role="cell" className="numeric">{table.columnCount.toLocaleString("ko-KR")}</span><span role="cell"><ResultSource sources={[table.source]} fileNames={fileNames} onSource={onSource} /></span></div>)}
                  </div>
                </section>
              ) : null}
              {analysis.totals.length ? (
                <section className="result-subsection">
                  <div className="subsection-heading"><h4>명시된 합계 검증</h4><span>{analysis.totals.length}건</span></div>
                  {analysis.totals.map((total) => (
                    <div className={`total-row${total.actual === total.expected ? " verified" : " mismatch"}`} key={`${total.label}-${total.source.nodeId}`}>
                      <strong title={total.label}>{total.label}</strong>
                      <span>표시값 <b className="numeric">{total.actual.toLocaleString("ko-KR")}</b></span>
                      <span>계산값 <b className="numeric">{total.expected.toLocaleString("ko-KR")}</b></span>
                      <span className="verification-label">{total.actual === total.expected ? "일치" : "불일치"}</span>
                      <ResultSource sources={[total.source]} fileNames={fileNames} onSource={onSource} />
                    </div>
                  ))}
                </section>
              ) : null}
            </article>
          ))}
        </div>
      </details>
    </div>
  );
}


const PAGE_SIZE = 50;

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
  const [expandedFindingId, setExpandedFindingId] = useState<string | null>(null);
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
  const byId = useMemo(() => new Map(indexed.map(({ finding }) => [finding.id, finding])), [indexed]);

  const resetPage = () => setPage(0);
  const ignoreFinding = (id: string) => {
    setIgnoredIds((current) => [...current, id]);
    setExpandedFindingId(null);
  };
  const addTerm = (term: string) => {
    onAddTerm(term);
    setExpandedFindingId(null);
  };

  return (
    <div className="result-sections check-results">
      <section className="qa-overview" aria-label="검수 요약">
        <div className="qa-intro">
          <h3>문서 품질 검수</h3>
          <p>문장·일관성·데이터·개인정보를 확인한 결과입니다.</p>
          {totals.truncated ? (
            <small className="check-truncation" data-testid="check-truncation">
              전체 {totals.totalFound.toLocaleString("ko-KR")}건 중 우선순위가 높은 {totals.returned.toLocaleString("ko-KR")}건을 표시합니다.
            </small>
          ) : null}
        </div>
        <dl className="qa-summary" aria-label="심각도 요약">
          {(["critical", "warning", "suggestion"] as const).map((severity) => (
            <div key={severity}>
              <span className={`severity-mark ${severity}`} aria-hidden="true" />
              <dt>{severityLabels[severity]}</dt>
              <dd>{counts[severity]}</dd>
            </div>
          ))}
        </dl>
      </section>

      {indexed.length === 0 ? (
        <StatusPanel variant="success" className="result-clear" title="확인된 문제가 없습니다."><p>현재 규칙 범위에서 문장, 일관성, 데이터와 개인정보 문제를 찾지 못했습니다.</p></StatusPanel>
      ) : (
        <>
          <div className="check-toolbar">
            <section className="check-filters" aria-label="검수 분류 필터">
              <fieldset>
                <legend>분류</legend>
                <div>
                  <button type="button" data-empty={active.length === 0} aria-pressed={groupFilter === "all"} onClick={() => { setGroupFilter("all"); resetPage(); }}>전체 <b>{active.length}</b></button>
                  {(Object.keys(checkGroupLabels) as CheckCategoryGroup[]).map((group) => (
                    <button type="button" key={group} data-empty={groupCounts[group] === 0} aria-pressed={groupFilter === group} onClick={() => { setGroupFilter(group); resetPage(); }}>
                      {checkGroupLabels[group]} <b>{groupCounts[group]}</b>
                    </button>
                  ))}
                </div>
              </fieldset>
            </section>
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
                {visible.map(({ finding, file }) => {
                  const expanded = expandedFindingId === finding.id;
                  const sources = finding.sources.length ? finding.sources : [finding.source];
                  const group = checkCategoryGroup(finding.category);
                  return (
                    <article className={`check-issue severity-${finding.severity}${expanded ? " expanded" : ""}`} key={finding.id} data-confidence={finding.confidence}>
                      <div className="check-issue-row">
                        <div className="check-issue-meta">
                          <span className="check-severity"><i className={`severity-mark ${finding.severity}`} aria-hidden="true" />{severityLabels[finding.severity]}</span>
                          <span aria-hidden="true">·</span>
                          <span className="check-category">{checkGroupLabels[group]}</span>
                          <span className="check-category-detail">{checkCategoryLabels[finding.category]}</span>
                        </div>
                        <div className="check-issue-name">
                          <small title={file.name}>{file.name}</small>
                          <strong>{finding.issue}</strong>
                          <p>{finding.message}</p>
                        </div>
                        <div className="check-issue-support">
                          <div className="check-source">
                            <span className="check-field-label">근거</span>
                            <ResultSource sources={sources} fileNames={fileNames} onSource={onSource} />
                          </div>
                          <div className="check-recommendation">
                            <span className="check-field-label">권고</span>
                            <p>{finding.recommendation}</p>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="issue-detail-toggle"
                          aria-expanded={expanded}
                          aria-label={`${finding.issue} ${expanded ? "닫기" : "상세 보기"}`}
                          onClick={() => setExpandedFindingId(expanded ? null : finding.id)}
                        >{expanded ? "닫기" : "상세 보기"}</button>
                      </div>
                      {expanded ? (
                        <div className="check-issue-detail">
                          <div><span>이유</span><p>{finding.reason}</p></div>
                          {finding.originalText ? <div><span>원문</span><blockquote>{finding.originalText}</blockquote></div> : null}
                          {finding.suggestedText ? (
                            <div className="suggested-copy">
                              <span>제안</span>
                              <blockquote>{finding.suggestedText}</blockquote>
                            </div>
                          ) : null}
                          {finding.relatedFindingIds?.length ? (
                            <div className="related-findings"><span>관련 이슈</span><div>{finding.relatedFindingIds.map((id) => {
                              const related = byId.get(id);
                              return related ? <button type="button" key={id} onClick={() => setExpandedFindingId(id)}>{related.issue}</button> : null;
                            })}</div></div>
                          ) : null}
                          <div className="finding-actions">
                            <span>작업</span>
                            <button type="button" onClick={() => ignoreFinding(finding.id)}>이번 항목 무시</button>
                            <button type="button" onClick={() => onToggleRule(finding.ruleId)}>동일 규칙 무시</button>
                            {finding.dictionaryEligible && finding.normalizedToken
                              ? <button type="button" onClick={() => addTerm(finding.normalizedToken!)}>내 용어에 추가</button>
                              : null}
                          </div>
                        </div>
                      ) : null}
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

function ExtractResults({ entries, fileNames, onSource, polishMode }: { entries: ExtractEntry[]; fileNames: Map<string, string>; onSource: SourceHandler; polishMode: PolishMode }) {
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
                  {isProse(paragraph.text) ? <PolishAction text={paragraph.text} label={`${locatorText(paragraph.source)} 문단`} origin="paragraph" source={paragraph.source} mode={polishMode} /> : null}
                </div>
              ))}</div>

            </section>
          ) : null}
        </article>
      ))}
    </div>
  );
}
function AskResults({ result, fileNames, onSource, polishMode }: {
  result: AiAvailableResult;
  fileNames: Map<string, string>;
  onSource: SourceHandler;
  polishMode: PolishMode;
}) {
  if (result.operation !== "ask") return null;
  const answer = result.claims.map(claimDisplayText).filter(Boolean).join("\n");
  const sourceEntries: SourceRef[] = [];
  const seen = new Set<string>();
  for (const claim of result.claims) {
    for (const binding of claim.evidence) {
      const key = `${binding.source.fileId}\0${binding.source.nodeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sourceEntries.push(binding.source);
    }
  }
  const acrossFiles = new Set(sourceEntries.map((source) => source.fileId)).size > 1;
  const sourceText = (source: SourceRef) => acrossFiles ? sourceLabel(source, fileNames) : locatorText(source);

  return (
    <div className="ask-result">
      {answer ? (
        <section className="ask-answer" aria-labelledby="ask-answer-title">
          <h3 id="ask-answer-title">답변</h3>
          <p>{answer}</p>
          <PolishAction text={answer} label="답변" origin="claim" source={result.claims[0]?.evidence[0]?.source} mode={polishMode} />
        </section>
      ) : (
        <p className="ask-result-info" role="status">선택한 파일에서 답변에 필요한 근거를 찾지 못했습니다.</p>
      )}
      {sourceEntries.length ? (
        <section className="ask-evidence" aria-labelledby="ask-evidence-title">
          <div className="subsection-heading"><h3 id="ask-evidence-title">근거</h3><span>{sourceEntries.length}곳</span></div>
          <ul className="ask-evidence-list">
            {sourceEntries.map((source) => {
              const label = sourceText(source);
              return (
                <li key={`${source.fileId}-${source.nodeId}`}>
                  <button
                    type="button"
                    className="ask-source-link"
                    aria-label={`${label} 상세 근거 보기`}
                    onClick={(event) => onSource([{ source }], event.currentTarget)}
                  >{label}</button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function AiResults({ result, fileNames, onSource, polishMode }: {
  result: AiAvailableResult;
  fileNames: Map<string, string>;
  onSource: SourceHandler;
  polishMode: PolishMode;
}) {
  const lead = result.operation === "ask" ? result.answer : result.operation === "brief" ? result.brief : undefined;
  const polishLabel = result.operation === "ask" ? "Ask 답변" : result.operation === "brief" ? "Brief 요약" : "분석 결과";
  const leadLabel = result.operation === "ask" ? "답변 · 근거 검증됨" : result.operation === "brief" ? "요약 · 근거 검증됨" : "분석 · 근거 검증됨";
  return (
    <div className="ai-result">
      {lead ? <section className="answer-document"><span className="result-type">{leadLabel}</span><p>{lead}</p><PolishAction text={lead} label={polishLabel} origin="claim" mode={polishMode} /></section> : null}
      <section className="claim-list">
        <div className="subsection-heading"><h3>주요 근거</h3><span>{result.claims.length}건</span></div>
        {result.claims.map((claim) => <ClaimRow key={claim.id} claim={claim} fileNames={fileNames} onSource={onSource} polishMode={polishMode} polishLabel={polishLabel} />)}
      </section>
      {result.operation !== "brief" && result.warnings.length ? <StatusPanel variant="warning" className="result-warnings" title="일부 결과 안내">{result.warnings.map((warning) => <p key={warning.code}>{warning.message}</p>)}</StatusPanel> : null}
    </div>
  );
}

function ClaimRow({ claim, fileNames, onSource, polishMode, polishLabel }: {
  claim: GroundedClaim;
  fileNames: Map<string, string>;
  onSource: SourceHandler;
  polishMode: PolishMode;
  polishLabel: string;
}) {
  return (
    <article className="claim-row">
      <div className="claim-kind">
        <span className={claim.kind === "fact" ? "fact" : "inference"}>{claim.kind === "fact" ? "문서 사실" : "분석 내용"}</span>
        {/* Prose, so it can be polished; the evidence binding below is untouched. */}
        <PolishAction text={claim.text} label={polishLabel} origin="claim" source={claim.evidence[0]?.source} mode={polishMode} />
      </div>
      <p>{claimDisplayText(claim)}</p>
      <div className="claim-evidence">
        {claim.evidence.map((binding: EvidenceBinding, index) => (
          <div key={`${binding.source.nodeId}-${index}`}>
            <span>{binding.support === "direct" ? "원문" : binding.support === "computed" ? "계산 결과" : "문맥"}</span>
            <ResultSource sources={[binding.source]} fileNames={fileNames} onSource={onSource} />
          </div>
        ))}
      </div>
    </article>
  );
}

function JsonValue({ value, fileNames, onSource, depth = 0 }: { value: unknown; fileNames: Map<string, string>; onSource: SourceHandler; depth?: number }): React.ReactNode {
  if (isSourceRef(value)) return <ResultSource sources={[value]} fileNames={fileNames} onSource={onSource} />;
  if (Array.isArray(value)) return value.length ? <div className={`result-list depth-${Math.min(depth, 2)}`}>{value.map((item, index) => <div className="result-entry" key={index}><JsonValue value={item} fileNames={fileNames} onSource={onSource} depth={depth + 1} /></div>)}</div> : <span className="muted">항목 없음</span>;
  if (typeof value === "object" && value !== null) return <dl className="result-object">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{key}</dt><dd><JsonValue value={item} fileNames={fileNames} onSource={onSource} depth={depth + 1} /></dd></div>)}</dl>;
  return <span>{displayValue(value as string | number | boolean | null | undefined)}</span>;
}

function ComparisonView({ comparison, compareIds, fileNames, detail, onSource, onCloseSource, status }: { comparison: ComparisonResult | null; compareIds: { baseFileId: string; targetFileId: string } | null; fileNames: Map<string, string>; detail: DetailInfo | null; onSource: SourceHandler; onCloseSource: () => void; status: ResultStatus | null }) {
  if (!comparison) return null;
  const roleOf = (source: SourceRef): SourceRole | undefined => {
    if (!compareIds) return undefined;
    if (source.fileId === compareIds.baseFileId) return "base";
    if (source.fileId === compareIds.targetFileId) return "current";
    return undefined;
  };
  const summaryItems = [
    { key: "total", label: "전체 변경", value: comparison.summary.total },
    { key: "changed", label: "변경", value: comparison.summary.changed },
    { key: "added", label: "추가", value: comparison.summary.added },
    { key: "removed", label: "삭제", value: comparison.summary.removed },
    { key: "structural", label: "구조 변경", value: comparison.summary.structural },
    { key: "important", label: "중요 변경", value: comparison.summary.important },
  ];
  return (
    <section className="panel results-panel comparison-panel">
      <ResultHeader
        eyebrow="COMPARE RESULT"
        title="파일 비교 결과"
        status={status}
        meta={(
          <div className="compare-files">
            <span><b>기준</b>{compareIds ? fileNames.get(compareIds.baseFileId) : "미선택"}</span>
            <span><b>현재</b>{compareIds ? fileNames.get(compareIds.targetFileId) : "미선택"}</span>
          </div>
        )}
      />
      <dl className="summary executive-summary">{summaryItems.map((item) => <div key={item.key} className={`summary-${item.key}`}><dt>{item.label}</dt><dd>{item.value.toLocaleString("ko-KR")}</dd></div>)}</dl>
      {comparison.items.length === 0 ? (
        <StatusPanel variant="success" className="result-clear" title="비교된 변경 사항이 없습니다."><p>지원되는 내용, 수치 및 구조 범위에서 두 파일이 같습니다.</p></StatusPanel>
      ) : (
        <div className="comparison-content">
          <div className="comparison-index" aria-label="변경 유형 요약">
            {summaryItems.slice(1).map((item) => <span key={item.key}><i className={`category-dot ${item.key}`} aria-hidden="true" />{item.label}<b>{item.value}</b></span>)}
          </div>
          <div className="change-table" role="table" aria-label="파일 변경 상세">
            <div className="change-head" role="row"><span role="columnheader">구분</span><span role="columnheader">항목</span><span role="columnheader">Previous</span><span role="columnheader">Current</span><span role="columnheader">Difference</span><span role="columnheader">Change %</span><span role="columnheader">근거</span></div>
            {comparison.items.map((item: ComparisonItem) => (
              <div className="change-row" role="row" key={item.id} data-testid="change-row" data-category={item.category}>
                <span role="cell"><strong className={`category-label category-${item.category.toLowerCase().replaceAll(" ", "-")}`}>{categoryLabels[item.category]}</strong></span>
                <span role="cell" className="change-label" title={item.label}>{item.label}</span>
                <span role="cell" className="numeric">{displayValue(item.previous)}</span>
                <span role="cell" className="numeric">{displayValue(item.current)}</span>
                <span role="cell" className="numeric difference">{displayValue(item.difference)}</span>
                <span role="cell" className="numeric">{item.changePercent === null ? "해당 없음" : `${item.changePercent > 0 ? "+" : ""}${item.changePercent.toFixed(2)}%`}</span>
                <div role="cell" className="source-actions"><ResultSource sources={item.sources} fileNames={fileNames} onSource={onSource} roleOf={roleOf} emptyLabel="근거 없음" /></div>
              </div>
            ))}
          </div>
        </div>
      )}
      {detail ? <SourceDetail entries={detail.entries} fileNames={fileNames} onClose={onCloseSource} /> : null}
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
          <p className="eyebrow">근거</p>
          <h2>근거 상세</h2>
          {fileHeading ? <p className="evidence-file-list" title={fileHeading}>{fileHeading}</p> : null}
        </div>
        <button type="button" onClick={onClose} aria-label="닫기">×</button>
      </header>
      <div className="evidence-type"><span>원문</span><p>문서에서 확인된 근거</p></div>
      {groups.map((group, index) => {
        const [lead] = group.entries;
        const locations = [...new Set(group.entries.map(({ source, role }) => {
          const roleLabel = roleText(role);
          return `${locatorText(source)}${roleLabel ? ` · ${roleLabel}` : ""}`;
        }))];
        const fileName = multipleFiles ? fileNames.get(lead.source.fileId) : undefined;
        return (
          <section className="evidence-entry" key={group.key}>
            <h3>
              <span>근거 {index + 1}{fileName ? ` · ${fileName}` : ""}</span>
              {locations.join(" · ")}
            </h3>
            <blockquote>{lead.source.quote ?? "인용문이 제공되지 않았습니다."}</blockquote>
          </section>
        );
      })}
    </aside>
  );
}
