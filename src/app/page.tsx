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
  type CheckConfidence,
  type CheckFinding,
  type CheckResult,
  type CheckSeverity,
  type ExtractResult,
} from "@/domain/operations";
import { WorkLensLogo } from "./worklens-logo";
import { disposeWorkspace, runInWorker } from "@/client/document-client";
import {
  browserAiState,
  cancelBrowserAiLoad,
  confirmBrowserAi,
  disposeBrowserAi,
  generateBrowserAi,
  interruptBrowserAi,
  loadBrowserAi,
  probeBrowserAi,
  subscribeBrowserAi,
  type BrowserAiFailure,
} from "@/client/browser-ai-client";
import {
  BROWSER_AI_MAX_FILES,
  BROWSER_AI_MESSAGES,
  BROWSER_AI_MODEL_LABEL,
  BROWSER_AI_MODEL_MB,
  type BrowserAiState,
} from "@/client/browser-ai-protocol";
import type { CheckEntry as WorkerCheckEntry, WorkspaceFile } from "@/client/protocol";
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
  BarChart3,
  BookMarked,
  GitCompareArrows,
  MessageSquareText,
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
  Extract: Table2,
  Brief: ScrollText,
};
type ApiError = { code: string; message: string; retryable?: boolean };
type Notice = { tone: "error" | "success" | "info"; message: string };
const tabs = ["Analyze", "Ask", "Compare", "Check", "Extract", "Brief"] as const;
type Tab = (typeof tabs)[number];
const tabMeta: Record<Tab, { label: string; description: string }> = {
  Analyze: { label: "Analyze", description: "구조와 수치" },
  Ask: { label: "Ask", description: "파일에 질문" },
  Compare: { label: "Compare", description: "버전 차이" },
  Check: { label: "Check", description: "품질과 위험" },
  Extract: { label: "Extract", description: "데이터 추출" },
  Brief: { label: "Brief", description: "업무 요약" },
};
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
  spelling: "Spelling",
  grammar: "Grammar",
  wording: "Wording",
  terminology: "Terminology",
  duplication: "Duplication",
  formatting: "Formatting",
  numeric: "Numeric",
  date: "Date",
  unit: "Unit",
  total: "Total",
  privacy: "Privacy",
  structure: "Structure",
  placeholder: "Placeholder",
};
const checkGroupLabels: Record<CheckCategoryGroup, string> = {
  writing: "Writing",
  consistency: "Consistency",
  data: "Data",
  privacy: "Privacy",
};

/** Server render has no WebGPU and no model: AI actions stay enabled until the
 * client snapshot proves otherwise, and the status box starts silent. */
const serverAiState: () => BrowserAiState = () => ({ phase: "idle" });

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
type SourceRole = "base" | "current";
type DetailInfo = { source: SourceRef; role?: SourceRole };

function isCheckEntries(value: unknown): value is WorkerCheckEntry[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) =>
    typeof entry === "object" && entry !== null
    && Array.isArray((entry as WorkerCheckEntry).check?.findings)
    && typeof (entry as WorkerCheckEntry).check?.summary?.totalFound === "number");
}

export default function Home() {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("Analyze");
  const [shellView, setShellView] = useState<ShellView>("Analyze");
  const [companyTerms, setCompanyTerms] = useState<CompanyTermEntry[]>([]);
  const [companyTermsSource, setCompanyTermsSource] = useState<"d1" | "seed" | "pending">("pending");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [compareIds, setCompareIds] = useState<{ baseFileId: string; targetFileId: string } | null>(null);
  const [operationResult, setOperationResult] = useState<unknown>(null);
  const [detail, setDetail] = useState<DetailInfo | null>(null);
  const [question, setQuestion] = useState("");
  const [userTerms, setUserTerms] = useState<string[]>(readUserTerms);
  const [ignoredRules, setIgnoredRules] = useState<string[]>(readIgnoredRules);
  // The AI layer is an external system: state and capability are read through
  // the store instead of mirrored into React state inside an effect.
  const aiState = useSyncExternalStore(subscribeBrowserAi, browserAiState, serverAiState);
  const aiUnsupported = aiState.phase === "unsupported";
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadQueue = useRef<Promise<void>>(Promise.resolve());
  const detailTrigger = useRef<HTMLElement | null>(null);

  const openSource = useCallback((source: SourceRef, role: SourceRole | undefined, trigger: HTMLElement | null) => {
    detailTrigger.current = trigger;
    setDetail({ source, role });
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

  const clearResults = useCallback(() => {
    setOperationResult(null);
    setComparison(null);
    setCompareIds(null);
    setDetail(null);
  }, []);

  // Both workers belong to this tab: documents live in the parser worker, the
  // model lives in the AI worker. Unloading the page releases both.
  useEffect(() => () => {
    disposeWorkspace();
    disposeBrowserAi();
  }, []);

  // Capability is probed when the user actually moves to an AI destination, so
  // the landing view stays silent and nothing is downloaded up front.
  useEffect(() => {
    if (activeTab === "Ask" || activeTab === "Brief") void probeBrowserAi();
  }, [activeTab]);

  const upload = async (file: File) => {
    setUploading(true);
    setNotice({ tone: "info", message: `${file.name}을(를) 분석 중입니다.` });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const summary = await runInWorker(
        { kind: "parse", fileId: crypto.randomUUID(), fileName: file.name, bytes },
        [bytes.buffer],
      );
      setFiles((current) => [...current, summary]);
      setNotice({ tone: "success", message: `${file.name} 분석이 완료되었습니다.` });
    } catch (error) {
      setNotice({ tone: "error", message: (error as ApiError).message ?? "파일을 처리하지 못했습니다." });
    } finally {
      setUploading(false);
    }
  };

  const enqueueUploads = (list: FileList | null) => {
    for (const file of Array.from(list ?? [])) uploadQueue.current = uploadQueue.current.then(() => upload(file));
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    enqueueUploads(event.dataTransfer.files);
  };
  const toggleFile = (id: string) => {
    setSelected((current) => current.includes(id) ? current.filter((fileId) => fileId !== id) : current.length < 10 ? [...current, id] : current);
    clearResults();
  };

  const runDeterministic = async (
    kind: "analyze" | "check" | "extract",
    success: string,
  ) => {
    setBusy(true);
    setNotice(null);
    setDetail(null);
    try {
      const result = kind === "analyze"
        ? await runInWorker({ kind: "analyze", fileIds: selected })
        : kind === "check"
          ? await runInWorker({ kind: "check", fileIds: selected, userTerms, companyTerms: companyTermNames })
          : await runInWorker({ kind: "extract", fileIds: selected });
      setOperationResult(result);
      setNotice({ tone: "success", message: success });
    } catch (error) {
      setOperationResult(null);
      setNotice({ tone: "error", message: (error as ApiError).message ?? "작업에 실패했습니다." });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Browser-local AI orchestration. The main thread only routes ids: the
   * document worker ranks and bounds the evidence, the AI worker sees just that
   * window, and grounding happens back in the document worker where the
   * canonical sources live. No document text is ever held in React state.
   */
  const runBrowserTask = async (request: AiRequest, success: string) => {
    if (selected.length > BROWSER_AI_MAX_FILES) {
      setNotice({ tone: "error", message: `브라우저 AI 작업은 최대 ${BROWSER_AI_MAX_FILES}개 파일만 선택할 수 있습니다.` });
      return;
    }
    const capability = await probeBrowserAi();
    if (capability.phase === "unsupported" || capability.phase === "awaiting-confirmation") return;
    setBusy(true);
    setNotice(null);
    setDetail(null);
    let windowId: string | undefined;
    try {
      const evidence = await runInWorker({ kind: "evidence", fileIds: selected, request });
      windowId = evidence.windowId;
      const claims = await generateBrowserAi(request, evidence.items);
      const result = await runInWorker({ kind: "ground", windowId, request, claims });
      windowId = undefined;
      if (result.rejectedClaimCount > 0 || result.claims.length === 0) {
        throw { code: "GROUNDING_REJECTED", message: BROWSER_AI_MESSAGES.GROUNDING_REJECTED } satisfies BrowserAiFailure;
      }
      setOperationResult(result);
      setNotice({ tone: "success", message: success });
      return result;
    } catch (error) {
      setOperationResult(null);
      reportAiFailure(error);
    } finally {
      if (windowId) void runInWorker({ kind: "release-evidence", windowId });
      setBusy(false);
    }
  };

  /** Capability problems belong in the AI status box, never in the error notice. */
  const reportAiFailure = (error: unknown) => {
    const failure = error as BrowserAiFailure;
    const silent = failure.code === "NO_WEBGPU" || failure.code === "ADAPTER_FAILED"
      || failure.code === "MODEL_LOAD_FAILED" || failure.code === "MODEL_DOWNLOAD_FAILED"
      || failure.code === "OUT_OF_MEMORY";
    if (silent) setNotice(null);
    else if (failure.code === "CANCELLED") setNotice({ tone: "info", message: BROWSER_AI_MESSAGES.CANCELLED });
    else setNotice({ tone: "error", message: failure.message ?? "브라우저 AI 작업에 실패했습니다." });
  };

  const runActive = async () => {
    if (!selected.length) return;
    if (activeTab === "Compare") {
      if (selected.length !== 2) return;
      setBusy(true);
      setNotice(null);
      try {
        const [baseFileId, targetFileId] = selected;
        const result = await runInWorker({ kind: "compare", baseFileId, targetFileId });
        setComparison(result);
        setCompareIds({ baseFileId, targetFileId });
        setNotice({ tone: "success", message: "비교 결과를 준비했습니다." });
      } catch (error) {
        setNotice({ tone: "error", message: (error as ApiError).message ?? "비교에 실패했습니다." });
      } finally {
        setBusy(false);
      }
      return;
    }
    if (activeTab === "Analyze") return runDeterministic("analyze", "구조 및 수치 분석을 완료했습니다.");
    if (activeTab === "Check") return runDeterministic("check", "콘텐츠 및 개인정보 점검을 완료했습니다.");
    if (activeTab === "Extract") return runDeterministic("extract", "구조화 추출을 완료했습니다.");
    const typed = question.trim();
    return activeTab === "Ask"
      ? runBrowserTask({ operation: "ask", question: typed }, "Ask 결과를 준비했습니다.")
      : runBrowserTask({ operation: "brief", ...(typed ? { instruction: typed } : {}) }, "Brief 결과를 준비했습니다.");
  };

  /**
   * Browser semantic layer for Check: the deterministic result stays
   * authoritative and model suggestions are folded in as suggestions only.
   */
  const runSemanticCheck = async () => {
    if (selected.length > BROWSER_AI_MAX_FILES) {
      setNotice({ tone: "error", message: `브라우저 AI 작업은 최대 ${BROWSER_AI_MAX_FILES}개 파일만 선택할 수 있습니다.` });
      return;
    }
    const capability = await probeBrowserAi();
    if (capability.phase === "unsupported" || capability.phase === "awaiting-confirmation") return;
    setBusy(true);
    setNotice(null);
    setDetail(null);
    const request: AiRequest = {
      operation: "semantic-check",
      statement: "선택한 문서의 한글 맞춤법, 띄어쓰기, 조사, 어색한 표현과 용어 일관성을 보수적으로 점검하세요. 확신이 낮은 항목은 제안으로만 표시하세요.",
    };
    let windowId: string | undefined;
    try {
      const base = isCheckEntries(operationResult)
        ? operationResult
        : await runInWorker({ kind: "check", fileIds: selected, userTerms, companyTerms: companyTermNames });
      const evidence = await runInWorker({ kind: "evidence", fileIds: selected, request });
      windowId = evidence.windowId;
      const modelClaims = await generateBrowserAi(request, evidence.items);
      const aiResult = await runInWorker({ kind: "ground", windowId, request, claims: modelClaims });
      windowId = undefined;
      const claims = aiResult.claims;
      const merged = base.map((entry) => {
        const forFile = claims.filter((claim) => claim.evidence.some((binding) => binding.source.fileId === entry.file.id));
        const findings = sortFindings(mergeSemanticFindings(entry.check.findings, semanticFindings(forFile)), new Map());
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
      const total = merged.reduce((sum, entry) => sum + entry.check.findings.length, 0) - base.reduce((sum, entry) => sum + entry.check.findings.length, 0);
      setNotice({
        tone: "success",
        message: total > 0
          ? `브라우저 AI 문장 검수 ${total}건을 제안으로 추가했습니다. "낮은 확신 포함"을 켜면 모두 볼 수 있습니다.`
          : "브라우저 AI 문장 검수에서 추가할 제안이 없었습니다.",
      });
    } catch (error) {
      reportAiFailure(error);
    } finally {
      if (windowId) void runInWorker({ kind: "release-evidence", windowId });
      setBusy(false);
    }
  };

  const runAiAssist = () => {
    if (activeTab === "Analyze") return runBrowserTask({ operation: "analyze" }, "브라우저 AI 분석 결과를 준비했습니다.");
    if (activeTab === "Check") return runSemanticCheck();
    return runBrowserTask(
      { operation: "semantic-check", statement: "선택한 문서 사이의 중요한 의미 변화를 근거와 함께 점검하세요." },
      "브라우저 AI 보조 점검 결과를 준비했습니다.",
    );
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
      setNotice({ tone: "success", message: `${format.toUpperCase()} 파일을 다운로드했습니다. 다운로드된 복사본은 사용자 기기에서 직접 관리하세요.` });
    } catch (error) {
      setNotice({ tone: "error", message: (error as ApiError).message ?? "내보내기에 실패했습니다." });
    } finally {
      setBusy(false);
    }
  };

  const deleteAll = () => {
    if (!window.confirm("이 탭에서 처리한 파일과 결과를 모두 지우시겠습니까?")) return;
    disposeWorkspace();
    disposeBrowserAi();
    setFiles([]);
    setSelected([]);
    clearResults();
    setNotice({ tone: "info", message: "브라우저 메모리에서 파일과 결과를 모두 지웠습니다." });
  };

  const aiTab = activeTab === "Ask" || activeTab === "Brief";
  const actionDisabled = busy || selected.length === 0 || (activeTab === "Compare" && selected.length !== 2) || (activeTab === "Ask" && !question.trim()) || (aiTab && aiUnsupported);
  const fileNames = new Map(files.map((file) => [file.id, file.name]));
  const companyTermNames = companyTerms.filter((entry) => entry.active).map((entry) => entry.term);
  const isUtilityView = shellView === "Dictionary" || shellView === "Settings";
  const selectedNames = files.filter((file) => selected.includes(file.id)).map((file) => file.name).join(", ");

  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace-content">본문으로 건너뛰기</a>
      <nav className="rail" aria-label="Workspace views">
        <div className="rail-brand">
          <WorkLensLogo size={40} />
        </div>
        <p className="rail-group-label">Workspace</p>
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
                  aria-label={tab}
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
                onClick={() => setShellView(view)}
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
          <header className="context-bar">
            <div className="context-files">
              <h1 id="files-heading">작업 파일</h1>
              <span className="context-counts">
                <b>{files.length}</b>개
                <i aria-hidden="true" />
                선택 <b>{selected.length}</b>개
              </span>
              <span className="context-names" title={selectedNames || undefined}>
                {selectedNames || "선택 없음"}
              </span>
            </div>
            <div className="context-actions">
              <span className="session-state">
                <span className="state-dot" aria-hidden="true" />
                In-browser session · 서버 저장 없음
              </span>
              {files.length > 0 ? (
                <button type="button" className="secondary-action" onClick={() => inputRef.current?.click()} disabled={uploading}>
                  {uploading ? "분석 중…" : "Add files"}
                </button>
              ) : null}
              <button type="button" className="delete-all" onClick={deleteAll} disabled={busy}>모두 삭제</button>
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
          {files.length === 0 && !isUtilityView ? (
            <div
              className={`dropzone${uploading ? " busy" : ""}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={onDrop}
            >
              <div>
                <strong>{uploading ? "파일을 읽고 구조를 분석하는 중" : "업무 파일 추가"}</strong>
                <span>XLSX, CSV, PDF, DOCX, PPTX · 파일당 최대 50 MB · 임시 처리</span>
              </div>
              <span className="drop-hint">여기로 끌어놓기</span>
              <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading}>
                {uploading ? "분석 중…" : "파일 선택"}
              </button>
            </div>
          ) : null}

          {notice ? (
            <div className={`notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"} aria-live={notice.tone === "error" ? "assertive" : "polite"}>
              <span className="notice-marker" aria-hidden="true" />
              <div>
                <strong>{notice.tone === "error" ? "작업을 완료하지 못했습니다" : notice.tone === "success" ? "작업 완료" : "처리 상태"}</strong>
                <p>{notice.message}</p>
                {notice.tone === "error" ? <small>{notice.message.includes("브라우저 AI") ? "Analyze, Compare, Check, Extract는 브라우저 AI 없이 계속 사용할 수 있습니다." : "파일 형식과 선택 상태를 확인한 뒤 다시 시도하세요."}</small> : null}
              </div>
            </div>
          ) : null}

          {isUtilityView ? (
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
              {files.length === 0 ? (
                <div className="empty-state">
                  <strong>아직 파일이 없습니다.</strong>
                  <p>파일을 추가하면 구조를 확인하고 분석·비교·검수할 수 있습니다.</p>
                </div>
              ) : (
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

              <section className="operation-bar" aria-label={`${activeTab} action`}>
                <div className="operation-context">
                  <strong>{activeTab}</strong>
                  <span>{activeTab === "Compare" ? "기준과 현재 파일을 순서대로 두 개 선택하세요." : activeTab === "Check" ? "Writing · Consistency · Data · Privacy를 한 번에 검수합니다." : aiTab ? `브라우저 AI는 최대 ${BROWSER_AI_MAX_FILES}개 파일에서 근거를 확인합니다.` : "최대 10개 파일을 함께 처리할 수 있습니다."}</span>
                </div>
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
                <div className="operation-actions">
                  {(activeTab === "Analyze" || activeTab === "Compare" || activeTab === "Check") ? <button type="button" className="secondary-action" onClick={runAiAssist} disabled={busy || selected.length === 0 || aiUnsupported}>{activeTab === "Check" ? "브라우저 AI 문장 검수" : "브라우저 AI 보조"}</button> : null}
                  <button type="button" onClick={runActive} disabled={actionDisabled}>{busy ? "처리 중…" : `${activeTab} 실행`}</button>
                </div>
              </section>

              <BrowserAiStatus
                state={aiState}
                onConfirm={() => { confirmBrowserAi(); void loadBrowserAi().catch(reportAiFailure); }}
                onCancelLoad={cancelBrowserAiLoad}
                onInterrupt={interruptBrowserAi}
              />

              {busy ? <div className="processing-bar" role="status"><span aria-hidden="true" /><strong>{activeTab} 처리 중</strong><small>선택한 파일의 구조와 근거를 확인하고 있습니다.</small></div> : null}
              {activeTab === "Extract" && operationResult ? (
                <div className="export-actions">
                  <span>전체 추출 결과를 파일로 저장합니다.</span>
                  <button type="button" className="secondary-action" onClick={() => exportFiles("csv")} disabled={busy}>CSV 다운로드</button>
                  <button type="button" onClick={() => exportFiles("xlsx")} disabled={busy}>XLSX 다운로드</button>
                </div>
              ) : null}

              {activeTab === "Compare"
                ? <ComparisonView comparison={comparison} compareIds={compareIds} fileNames={fileNames} detail={null} onSource={openSource} onCloseSource={closeSource} />
                : <ResultView
                  tab={activeTab}
                  result={operationResult}
                  fileNames={fileNames}
                  detail={null}
                  onSource={openSource}
                  onCloseSource={closeSource}
                  dictionary={{ userTerms, ignoredRules, onAddTerm: addTerm, onRemoveTerm: removeTerm, onClearTerms: clearTerms, onToggleRule: toggleRule }}
                />}
            </>
          )}
        </section>
      </div>

      {detail ? (
        <aside className="evidence-inspector">
          <SourceDetail source={detail.source} label={sourceLabel(detail.source, fileNames, detail.role)} onClose={closeSource} />
        </aside>
      ) : null}
    </div>
  );
}

/**
 * Model lifecycle for the browser AI layer. A missing adapter or a failed
 * download is a capability notice, never a workspace error: deterministic
 * Analyze/Compare/Check/Extract keep working underneath it. The first download
 * is opt-in, and a download and a running generation cancel differently.
 */
function BrowserAiStatus({ state, onConfirm, onCancelLoad, onInterrupt }: {
  state: BrowserAiState;
  onConfirm: () => void;
  onCancelLoad: () => void;
  onInterrupt: () => void;
}) {
  if (state.phase === "unsupported") {
    return (
      <div className="ai-status" role="status">
        <strong>브라우저 AI를 사용할 수 없습니다</strong>
        <p>{BROWSER_AI_MESSAGES[state.code]}</p>
      </div>
    );
  }
  if (state.phase === "checking") {
    return (
      <div className="ai-status" role="status">
        <strong>브라우저 AI 확인 중</strong>
        <p>이 장치에서 AI를 실행할 수 있는지 확인하고 있습니다.</p>
      </div>
    );
  }
  if (state.phase === "awaiting-confirmation") {
    return (
      <div className="ai-status confirm" role="group" aria-label="브라우저 AI 준비">
        <strong>브라우저 AI 준비</strong>
        <p>
          Ask와 Brief를 사용하려면 AI 모델을 이 브라우저에 한 번 다운로드해야 합니다.
          약 {(BROWSER_AI_MODEL_MB / 1_000).toFixed(1)} GB · WebGPU 필요 · 문서는 외부로 전송되지 않습니다.
        </p>
        <div className="ai-status-actions">
          <button type="button" className="ai-confirm" onClick={onConfirm}>AI 준비</button>
          <button type="button" className="secondary-action" onClick={onCancelLoad}>취소</button>
        </div>
      </div>
    );
  }
  if (state.phase === "loading") {
    const percent = Math.round(Math.min(Math.max(state.progress, 0), 1) * 100);
    return (
      <div className="ai-status loading" role="status" aria-live="polite">
        <strong>브라우저 AI 준비 중</strong>
        <p>모델 다운로드 중에도 Analyze · Compare · Check · Extract는 계속 사용할 수 있습니다.</p>
        <span className="ai-progress">
          <progress max={100} value={percent} />
          모델 다운로드 {percent}%
        </span>
        <div className="ai-status-actions">
          <button type="button" className="secondary-action" onClick={onCancelLoad}>다운로드 취소</button>
          <button type="button" className="secondary-action" onClick={onInterrupt}>생성 중지</button>
        </div>
      </div>
    );
  }
  if (state.phase === "ready") {
    return (
      <div className="ai-status ready" role="status">
        <strong>브라우저 AI 준비 완료</strong>
        <p>{BROWSER_AI_MODEL_LABEL} 모델이 이 브라우저에 있습니다.</p>
      </div>
    );
  }
  if (state.phase === "failed") {
    return (
      <div className="ai-status failed" role="status">
        <strong>브라우저 AI 준비 실패</strong>
        <p>{state.message}</p>
        {state.detail ? <small className="ai-detail">{state.detail}</small> : null}
      </div>
    );
  }
  return null;
}

/** Dictionary and Settings share one surface; both are browser-local by design. */
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
          <div><dt>localStorage</dt><dd>개인 사전 단어와 무시한 규칙 ID만 저장합니다. 문서 본문과 근거는 저장하지 않습니다.</dd></div>
          <div><dt>무시한 규칙</dt><dd>
            {ignoredRules.length
              ? <div className="dictionary-term-list">{ignoredRules.map((rule) => (
                <span className="dictionary-term" key={rule}>{rule}
                  <button type="button" aria-label={`${rule} 복원`} onClick={() => onToggleRule(rule)}>×</button>
                </span>
              ))}</div>
              : "없음"}
          </dd></div>
          <div><dt>브라우저 AI</dt><dd>Ask, Brief, 문장 검수는 이 브라우저에서 실행됩니다. 처음 사용할 때 모델을 한 번 내려받고(약 {BROWSER_AI_MODEL_MB.toLocaleString("ko-KR")} MB, WebGPU 필요) 모델 파일만 브라우저 캐시에 남습니다. 문서와 질문은 어디에도 전송·저장하지 않습니다.</dd></div>
        </dl>
      </section>
    );
  }
  return (
    <section className="settings-surface" aria-label="Dictionary">
      <div className="dictionary-section">
        <h4>Company Terms <span>{companyTerms.length}</span></h4>
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
        <h4>My Terms <span>{userTerms.length}</span></h4>
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
        <div className="dictionary-actions">
          <button type="button" onClick={onClearTerms} disabled={!userTerms.length}>전체 초기화</button>
        </div>
        <p className="dictionary-note">개인 사전은 이 브라우저에만 저장됩니다.</p>
      </div>
    </section>
  );
}

function sourceLabel(source: SourceRef, fileNames: Map<string, string>, role?: SourceRole): string {
  const fileName = fileNames.get(source.fileId);
  const roleLabel = role === "base" ? "기준" : role === "current" ? "현재" : undefined;
  const revision = source.documentVersion
    ? `버전 ${source.documentVersion.slice(0, 8)}`
    : `파일 ${source.fileId.slice(0, 8)}`;
  const locator = source.locator?.kind === "pptx"
    ? `Slide ${source.locator.slide}`
    : source.locator?.kind === "pdf"
      ? `Page ${source.locator.page}`
      : source.label;
  const suffix = [revision, roleLabel].filter((part): part is string => Boolean(part)).join(" · ");
  return fileName ? `${fileName} · ${locator} (${suffix})` : `${locator} (${suffix})`;
}

type AnalyzeEntry = { file: { id: string; name: string }; analysis: AnalyzeResult };
type CheckEntry = { file: { id: string; name: string }; check: CheckResult };
type ExtractEntry = { file: { id: string; name: string }; extraction: ExtractResult };
type SourceHandler = (source: SourceRef, role: SourceRole | undefined, trigger: HTMLElement | null) => void;

interface ResultViewProps {
  tab: Tab;
  result: unknown;
  fileNames: Map<string, string>;
  detail: DetailInfo | null;
  onSource: SourceHandler;
  onCloseSource: () => void;
  dictionary: Omit<CheckViewProps, "entries" | "fileNames" | "onSource">;
}

/** One line of work name plus one line of scope; no state wording, no eyebrow. */
const placeholderCopy: Record<Exclude<Tab, "Compare">, [string, string]> = {
  Analyze: ["문서 분석", "파일을 선택하면 문서 구조와 주요 수치를 분석합니다."],
  Ask: ["질문하기", "선택한 파일을 근거로 질문에 답합니다."],
  Check: ["문서 검수", "파일을 선택하면 문장·일관성·데이터·개인정보를 검수합니다."],
  Extract: ["정보 추출", "파일을 선택하면 표·날짜·금액·인물·할 일을 추출합니다."],
  Brief: ["브리프 작성", "파일을 선택하면 핵심 내용을 업무 문서 형식으로 정리합니다."],
};

function ResultView({ tab, result, fileNames, detail, onSource, onCloseSource, dictionary }: ResultViewProps) {
  if (!result) {
    const [title, body] = placeholderCopy[tab as Exclude<Tab, "Compare">];
    return <section className="state-card result-placeholder"><h2>{title}</h2><p>{body}</p></section>;
  }

  let content: React.ReactNode;
  if (tab === "Analyze" && Array.isArray(result)) content = <AnalyzeResults entries={result as AnalyzeEntry[]} fileNames={fileNames} onSource={onSource} />;
  else if (tab === "Check" && Array.isArray(result)) content = <CheckResults entries={result as CheckEntry[]} fileNames={fileNames} onSource={onSource} {...dictionary} />;
  else if (tab === "Extract" && Array.isArray(result)) content = <ExtractResults entries={result as ExtractEntry[]} fileNames={fileNames} onSource={onSource} />;
  else if (isAiAvailableResult(result)) content = <AiResults result={result} fileNames={fileNames} onSource={onSource} />;
  else content = <JsonValue value={result} fileNames={fileNames} onSource={onSource} />;

  return (
    <section className="panel results-panel">
      <div className="panel-heading result-heading">
        <div><p className="eyebrow">{tab} result</p><h2>{tab === "Ask" ? "파일 답변" : tab === "Brief" ? "업무 브리프" : "작업 결과"}</h2></div>
        <span className="result-provenance">근거 연결 결과</span>
      </div>
      {content}
      {detail ? <SourceDetail source={detail.source} label={sourceLabel(detail.source, fileNames, detail.role)} onClose={onCloseSource} /> : null}
    </section>
  );
}

function isAiAvailableResult(value: unknown): value is AiAvailableResult {
  return typeof value === "object" && value !== null && Array.isArray((value as AiAvailableResult).claims) && typeof (value as AiAvailableResult).operation === "string";
}

function SourceButton({ source, fileNames, onSource, role, compact = false }: { source: SourceRef; fileNames: Map<string, string>; onSource: SourceHandler; role?: SourceRole; compact?: boolean }) {
  return <button type="button" className={compact ? "source-link compact" : "source-link"} onClick={(event) => onSource(source, role, event.currentTarget)}>{sourceLabel(source, fileNames, role)}</button>;
}

function AnalyzeResults({ entries, fileNames, onSource }: { entries: AnalyzeEntry[]; fileNames: Map<string, string>; onSource: SourceHandler }) {
  return (
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
          {analysis.numeric.sources.length ? (
            <section className="numeric-evidence">
              <div><strong>Numeric source evidence</strong><span>{analysis.numeric.sources.length} locations</span></div>
              <div className="source-evidence-list">{analysis.numeric.sources.map((source, index) => <SourceButton key={`${source.nodeId}-${index}`} source={source} fileNames={fileNames} onSource={onSource} compact />)}</div>
            </section>
          ) : null}
          <section className="result-subsection">
            <div className="subsection-heading"><h4>구조</h4><span>{analysis.structure.tables.length}개 표</span></div>
            {analysis.structure.tables.length ? (
              <div className="data-table analyze-table" role="table" aria-label={`${file.name} 표 구조`}>
                <div className="data-head" role="row"><span role="columnheader">위치</span><span role="columnheader">행</span><span role="columnheader">열</span><span role="columnheader">Source</span></div>
                {analysis.structure.tables.map((table) => <div className="data-row" role="row" key={table.blockId}><span role="cell" title={table.source.label}>{table.source.label}</span><span role="cell" className="numeric">{table.rowCount.toLocaleString("ko-KR")}</span><span role="cell" className="numeric">{table.columnCount.toLocaleString("ko-KR")}</span><span role="cell"><SourceButton source={table.source} fileNames={fileNames} onSource={onSource} compact /></span></div>)}
              </div>
            ) : <p className="inline-empty">표가 없습니다. 문단 {analysis.text.paragraphCount.toLocaleString("ko-KR")}개를 분석했습니다.</p>}
          </section>
          <section className="result-subsection">
            <div className="subsection-heading"><h4>명시된 합계 검증</h4><span>{analysis.totals.length}건</span></div>
            {analysis.totals.length ? analysis.totals.map((total) => (
              <div className={`total-row${total.actual === total.expected ? " verified" : " mismatch"}`} key={`${total.label}-${total.source.nodeId}`}>
                <strong title={total.label}>{total.label}</strong>
                <span>표시값 <b className="numeric">{total.actual.toLocaleString("ko-KR")}</b></span>
                <span>계산값 <b className="numeric">{total.expected.toLocaleString("ko-KR")}</b></span>
                <span className="verification-label">{total.actual === total.expected ? "일치" : "불일치"}</span>
                <SourceButton source={total.source} fileNames={fileNames} onSource={onSource} compact />
              </div>
            )) : <p className="inline-empty">검증할 명시적 합계가 없습니다.</p>}
          </section>
        </article>
      ))}
    </div>
  );
}

const PAGE_SIZE = 50;
const confidenceLabels: Record<CheckConfidence, string> = { high: "HIGH", medium: "MED", low: "LOW" };

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
  const [severityFilter, setSeverityFilter] = useState<"all" | CheckSeverity>("all");
  const [groupFilter, setGroupFilter] = useState<"all" | CheckCategoryGroup>("all");
  const [showLowConfidence, setShowLowConfidence] = useState(false);
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
    (severityFilter === "all" || finding.severity === severityFilter)
    && (groupFilter === "all" || checkCategoryGroup(finding.category) === groupFilter)), [active, severityFilter, groupFilter]);

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
      <section className="qa-overview" aria-label="Check summary">
        <div className="qa-intro">
          <span className="result-type">PRE-SHARE REVIEW</span>
          <h3>문서 제출 전 최종 검수</h3>
          <p className="check-summary-line">
            <span className="metric"><b>{counts.critical}</b> Critical</span>
            <span className="metric"><b>{counts.warning}</b> Warning</span>
            <span className="metric"><b>{counts.suggestion}</b> Suggestion</span>
            <span className="metric"><b>{groupCounts.writing}</b> Writing</span>
            <span className="metric"><b>{groupCounts.consistency}</b> Consistency</span>
            <span className="metric"><b>{groupCounts.data}</b> Data</span>
            <span className="metric"><b>{groupCounts.privacy}</b> Privacy</span>
          </p>
          {totals.truncated ? (
            <small className="check-truncation" data-testid="check-truncation">
              전체 {totals.totalFound.toLocaleString("ko-KR")}건 중 우선순위가 높은 {totals.returned.toLocaleString("ko-KR")}건을 표시합니다.
            </small>
          ) : null}
          <small>Severity는 문제의 중요도, Confidence는 판단의 확실성입니다. 문장 단위 추가 검수는 브라우저 AI 문장 검수로 실행합니다.</small>
        </div>
        <dl className="qa-summary">
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
        <div className="empty-state success-state"><strong>확인된 문제가 없습니다.</strong><p>현재 규칙 범위에서 작성, 일관성, 데이터와 개인정보 문제를 찾지 못했습니다.</p></div>
      ) : (
        <>
          <div className="check-toolbar">
            <section className="check-filters" aria-label="Check result filters">
              <fieldset>
                <legend>Severity</legend>
                <div>
                  <button type="button" data-empty={active.length === 0} aria-pressed={severityFilter === "all"} onClick={() => { setSeverityFilter("all"); resetPage(); }}>All <b>{active.length}</b></button>
                  {(["critical", "warning", "suggestion"] as const).map((severity) => (
                    <button type="button" key={severity} data-empty={counts[severity] === 0} aria-pressed={severityFilter === severity} onClick={() => { setSeverityFilter(severity); resetPage(); }}>
                      {severityLabels[severity]} <b>{counts[severity]}</b>
                    </button>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>Category</legend>
                <div>
                  <button type="button" data-empty={active.length === 0} aria-pressed={groupFilter === "all"} onClick={() => { setGroupFilter("all"); resetPage(); }}>All <b>{active.length}</b></button>
                  {(Object.keys(checkGroupLabels) as CheckCategoryGroup[]).map((group) => (
                    <button type="button" key={group} data-empty={groupCounts[group] === 0} aria-pressed={groupFilter === group} onClick={() => { setGroupFilter(group); resetPage(); }}>
                      {checkGroupLabels[group]} <b>{groupCounts[group]}</b>
                    </button>
                  ))}
                </div>
              </fieldset>
            </section>
            <div className="check-toolbar-actions">
              <label className="low-confidence-toggle">
                <input type="checkbox" checked={showLowConfidence} onChange={(event) => { setShowLowConfidence(event.target.checked); resetPage(); }} />
                낮은 확신 포함 <b>{totals.lowConfidence}</b>
              </label>
              <div className="dictionary-anchor">
                <button type="button" className="dictionary-trigger" aria-expanded={dictionaryOpen} onClick={() => setDictionaryOpen((open) => !open)}>용어 사전</button>
                {dictionaryOpen ? (
                  <div className="dictionary-panel" role="dialog" aria-label="용어 사전">
                    <section className="dictionary-section">
                      <h4>Company Terms <span>{companyTermFile.terms.length}</span></h4>
                      <p className="dictionary-note">회사 공용 사전은 읽기 전용입니다.</p>
                      <div className="dictionary-term-list">
                        {companyTermFile.terms.slice(0, 12).map((term) => <span className="dictionary-term" key={term}>{term}</span>)}
                        {companyTermFile.terms.length > 12 ? <span className="dictionary-term muted">외 {companyTermFile.terms.length - 12}개</span> : null}
                      </div>
                    </section>
                    <section className="dictionary-section">
                      <h4>My Terms <span>{userTerms.length}</span></h4>
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
              <section className="check-table" role="table" aria-label="문서 검수 결과">
                <div className="check-table-head" role="row">
                  <span role="columnheader">Severity</span>
                  <span role="columnheader">Category</span>
                  <span role="columnheader">Issue</span>
                  <span role="columnheader">Source</span>
                  <span role="columnheader">Recommendation</span>
                </div>
                <div className="check-table-body">
                  {visible.map(({ finding, file }) => {
                    const expanded = expandedFindingId === finding.id;
                    return (
                      <article className={`check-issue severity-${finding.severity}${expanded ? " expanded" : ""}`} key={finding.id} data-confidence={finding.confidence}>
                        <div className="check-issue-row" role="row">
                          <span role="cell" className="check-severity"><i className={`severity-mark ${finding.severity}`} aria-hidden="true" />{severityLabels[finding.severity]}</span>
                          <span role="cell" className="check-category">
                            {checkCategoryLabels[finding.category]}
                            <b className={`confidence-badge ${finding.confidence}`} title={`Confidence: ${finding.confidence}`}>{confidenceLabels[finding.confidence]}</b>
                          </span>
                          <span role="cell" className="check-issue-name">
                            <small title={file.name}>{file.name}</small>
                            <button type="button" aria-expanded={expanded} onClick={() => setExpandedFindingId(expanded ? null : finding.id)}>{finding.issue}<span>{expanded ? "닫기" : "상세"}</span></button>
                            <em>{finding.message}</em>
                          </span>
                          <span role="cell" className="check-source"><SourceButton source={finding.source} fileNames={fileNames} onSource={onSource} compact /></span>
                          <span role="cell" className="check-recommendation">{finding.recommendation}</span>
                        </div>
                        {expanded ? (
                          <div className="check-issue-detail">
                            <div><span>Reason</span><p>{finding.reason}</p></div>
                            {finding.originalText ? <div><span>Original</span><blockquote>{finding.originalText}</blockquote></div> : null}
                            {finding.suggestedText ? <div className="suggested-copy"><span>Suggested</span><blockquote>{finding.suggestedText}</blockquote></div> : null}
                            <div className="detail-sources"><span>Sources</span><div>{finding.sources.map((source, index) => <SourceButton key={`${source.nodeId}-${index}`} source={source} fileNames={fileNames} onSource={onSource} compact />)}</div></div>
                            {finding.relatedFindingIds?.length ? (
                              <div className="related-findings"><span>Related</span><div>{finding.relatedFindingIds.map((id) => {
                                const related = byId.get(id);
                                return related ? <button type="button" key={id} onClick={() => setExpandedFindingId(id)}>{related.issue}</button> : null;
                              })}</div></div>
                            ) : null}
                            <div className="finding-actions">
                              <span>Actions</span>
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
                </div>
              </section>
              {pageCount > 1 ? (
                <nav className="check-pagination" aria-label="Check result pages">
                  <button type="button" onClick={() => setPage(currentPage - 1)} disabled={currentPage === 0}>이전</button>
                  <span>{currentPage * PAGE_SIZE + 1}-{currentPage * PAGE_SIZE + visible.length} / {filtered.length.toLocaleString("ko-KR")}</span>
                  <button type="button" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= pageCount - 1}>다음</button>
                </nav>
              ) : null}
            </>
          ) : (
            <div className="filter-empty">
              <strong>필터 조건에 맞는 Finding이 없습니다.</strong>
              <button type="button" onClick={() => { setSeverityFilter("all"); setGroupFilter("all"); setIgnoredIds([]); resetPage(); }}>필터 초기화</button>
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
              <div className="subsection-heading"><h4>표 {tableIndex + 1}</h4><SourceButton source={table.source} fileNames={fileNames} onSource={onSource} compact /></div>
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
              <div className="paragraph-list">{extraction.paragraphs.map((paragraph) => <div key={paragraph.blockId}><p>{paragraph.text}</p><SourceButton source={paragraph.source} fileNames={fileNames} onSource={onSource} compact /></div>)}</div>
            </section>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function AiResults({ result, fileNames, onSource }: { result: AiAvailableResult; fileNames: Map<string, string>; onSource: SourceHandler }) {
  const lead = result.operation === "ask" ? result.answer : result.operation === "brief" ? result.brief : undefined;
  return (
    <div className="ai-result">
      {lead ? <section className="answer-document"><span className="result-type">AI INTERPRETATION · 근거 검증됨</span><p>{lead}</p></section> : null}
      <section className="claim-list">
        <div className="subsection-heading"><h3>근거별 주장</h3><span>{result.claims.length} claims</span></div>
        {result.claims.map((claim) => <ClaimRow key={claim.id} claim={claim} fileNames={fileNames} onSource={onSource} />)}
      </section>
      {result.warnings.length ? <section className="result-warnings"><h3>부분 결과 및 주의</h3>{result.warnings.map((warning) => <p key={warning.code}><strong>{warning.code}</strong>{warning.message}</p>)}</section> : null}
    </div>
  );
}

function ClaimRow({ claim, fileNames, onSource }: { claim: GroundedClaim; fileNames: Map<string, string>; onSource: SourceHandler }) {
  return (
    <article className="claim-row">
      <div className="claim-kind"><span className={claim.kind === "fact" ? "fact" : "inference"}>{claim.kind === "fact" ? "FILE FACT" : "AI INTERPRETATION"}</span></div>
      <p>{claim.text}</p>
      <div className="claim-evidence">
        {claim.evidence.map((binding: EvidenceBinding, index) => (
          <div key={`${binding.source.nodeId}-${index}`}>
            <span>{binding.support === "direct" ? "원문" : binding.support === "computed" ? "계산 결과" : "문맥"}</span>
            <SourceButton source={binding.source} fileNames={fileNames} onSource={onSource} compact />
          </div>
        ))}
      </div>
    </article>
  );
}

function JsonValue({ value, fileNames, onSource, depth = 0 }: { value: unknown; fileNames: Map<string, string>; onSource: SourceHandler; depth?: number }): React.ReactNode {
  if (isSourceRef(value)) return <SourceButton source={value} fileNames={fileNames} onSource={onSource} />;
  if (Array.isArray(value)) return value.length ? <div className={`result-list depth-${Math.min(depth, 2)}`}>{value.map((item, index) => <div className="result-entry" key={index}><JsonValue value={item} fileNames={fileNames} onSource={onSource} depth={depth + 1} /></div>)}</div> : <span className="muted">항목 없음</span>;
  if (typeof value === "object" && value !== null) return <dl className="result-object">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{key}</dt><dd><JsonValue value={item} fileNames={fileNames} onSource={onSource} depth={depth + 1} /></dd></div>)}</dl>;
  return <span>{displayValue(value as string | number | boolean | null | undefined)}</span>;
}

function ComparisonView({ comparison, compareIds, fileNames, detail, onSource, onCloseSource }: { comparison: ComparisonResult | null; compareIds: { baseFileId: string; targetFileId: string } | null; fileNames: Map<string, string>; detail: DetailInfo | null; onSource: SourceHandler; onCloseSource: () => void }) {
  if (!comparison) {
    return <section className="state-card result-placeholder"><h2>파일 비교</h2><p>비교할 파일을 선택하면 변경 사항과 차이를 확인합니다.</p></section>;
  }
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
      <div className="panel-heading result-heading">
        <div><p className="eyebrow">Executive summary</p><h2>파일 비교 결과</h2></div>
        <div className="compare-files">
          <span><b>기준</b>{compareIds ? fileNames.get(compareIds.baseFileId) : "미선택"}</span>
          <span><b>현재</b>{compareIds ? fileNames.get(compareIds.targetFileId) : "미선택"}</span>
        </div>
      </div>
      <dl className="summary executive-summary">{summaryItems.map((item) => <div key={item.key} className={`summary-${item.key}`}><dt>{item.label}</dt><dd>{item.value.toLocaleString("ko-KR")}</dd></div>)}</dl>
      {comparison.items.length === 0 ? (
        <div className="empty-state success-state"><strong>비교된 변경 사항이 없습니다.</strong><p>지원되는 내용, 수치 및 구조 범위에서 두 파일이 같습니다.</p></div>
      ) : (
        <div className="comparison-content">
          <div className="comparison-index" aria-label="변경 유형 요약">
            {summaryItems.slice(1).map((item) => <span key={item.key}><i className={`category-dot ${item.key}`} aria-hidden="true" />{item.label}<b>{item.value}</b></span>)}
          </div>
          <div className="change-table" role="table" aria-label="파일 변경 상세">
            <div className="change-head" role="row"><span role="columnheader">구분</span><span role="columnheader">항목</span><span role="columnheader">Previous</span><span role="columnheader">Current</span><span role="columnheader">Difference</span><span role="columnheader">Change %</span><span role="columnheader">Source evidence</span></div>
            {comparison.items.map((item: ComparisonItem) => (
              <div className="change-row" role="row" key={item.id} data-testid="change-row" data-category={item.category}>
                <span role="cell"><strong className={`category-label category-${item.category.toLowerCase().replaceAll(" ", "-")}`}>{categoryLabels[item.category]}</strong></span>
                <span role="cell" className="change-label" title={item.label}>{item.label}</span>
                <span role="cell" className="numeric">{displayValue(item.previous)}</span>
                <span role="cell" className="numeric">{displayValue(item.current)}</span>
                <span role="cell" className="numeric difference">{displayValue(item.difference)}</span>
                <span role="cell" className="numeric">{item.changePercent === null ? "해당 없음" : `${item.changePercent > 0 ? "+" : ""}${item.changePercent.toFixed(2)}%`}</span>
                <div role="cell" className="source-actions">{item.sources.length ? item.sources.map((source, index) => <SourceButton compact source={source} fileNames={fileNames} role={roleOf(source)} onSource={onSource} key={`${source.nodeId}-${index}`} />) : <span className="muted">없음</span>}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {detail ? <SourceDetail source={detail.source} label={sourceLabel(detail.source, fileNames, detail.role)} onClose={onCloseSource} /> : null}
    </section>
  );
}

function SourceDetail({ source, label, onClose }: { source: SourceRef; label: string; onClose: () => void }) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);
  return (
    <aside ref={panelRef} className="source-detail" aria-label="Source detail" tabIndex={-1}>
      <header><div><p className="eyebrow">Source evidence</p><h2 title={label}>{label}</h2></div><button type="button" onClick={onClose} aria-label="닫기">×</button></header>
      <div className="evidence-type"><span>FILE FACT</span><p>원문에서 확인된 근거</p></div>
      <blockquote>{source.quote ?? "인용문이 제공되지 않았습니다."}</blockquote>
      <dl>{source.page !== undefined ? <div><dt>Page / Slide</dt><dd>{source.page}</dd></div> : null}{source.sheet ? <div><dt>Sheet</dt><dd>{source.sheet}</dd></div> : null}{source.cellRange ? <div><dt>Range</dt><dd>{source.cellRange}</dd></div> : null}</dl>
    </aside>
  );
}
