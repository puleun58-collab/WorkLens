"use client";

import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from "react";
import type { AiAvailableResult, EvidenceBinding, GroundedClaim } from "@/domain/ai";
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
import type { WorkspaceFile } from "@/client/protocol";
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

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}
function apiError(payload: unknown, fallback: string): ApiError {
  return (payload as { error?: ApiError })?.error ?? { code: "REQUEST_FAILED", message: fallback, retryable: true };
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

function aiResultFrom(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || !("data" in payload)) return null;
  const data = payload.data;
  if (!data || typeof data !== "object" || !("result" in data)) return null;
  return data.result;
}

export default function Home() {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("Analyze");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [compareIds, setCompareIds] = useState<{ baseFileId: string; targetFileId: string } | null>(null);
  const [operationResult, setOperationResult] = useState<unknown>(null);
  const [detail, setDetail] = useState<DetailInfo | null>(null);
  const [question, setQuestion] = useState("");
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

  const clearResults = useCallback(() => {
    setOperationResult(null);
    setComparison(null);
    setCompareIds(null);
    setDetail(null);
  }, []);

  // Every document lives in the worker owned by this tab; unloading the page
  // is the deletion mechanism, so nothing needs to be released server-side.
  useEffect(() => disposeWorkspace, []);

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
          ? await runInWorker({ kind: "check", fileIds: selected })
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

  /** The only network call left: the optional Local AI layer. */
  const runLocalAi = async (task: "analyze" | "ask" | "brief" | "semantic-check", askedQuestion: string | undefined, success: string) => {
    if (selected.length > 5) {
      setNotice({ tone: "error", message: "Local AI 작업은 최대 5개 파일만 선택할 수 있습니다." });
      return;
    }
    setBusy(true);
    setNotice(null);
    setDetail(null);
    try {
      const documents = await runInWorker({ kind: "documents", fileIds: selected });
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task, documents, ...(askedQuestion ? { question: askedQuestion } : {}) }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw apiError(payload, "Local AI 작업에 실패했습니다.");
      setOperationResult(aiResultFrom(payload));
      setNotice({ tone: "success", message: success });
    } catch (error) {
      setOperationResult(null);
      setNotice({ tone: "error", message: (error as ApiError).message ?? "Local AI 작업에 실패했습니다." });
    } finally {
      setBusy(false);
    }
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
    const task = activeTab === "Ask" ? "ask" : "brief";
    return runLocalAi(task, question.trim() || undefined, `${activeTab} 결과를 준비했습니다.`);
  };

  const runAiAssist = () => {
    if (activeTab === "Analyze") return runLocalAi("analyze", undefined, "Local AI 분석 결과를 준비했습니다.");
    const statement = activeTab === "Compare"
      ? "선택한 문서 사이의 중요한 의미 변화를 근거와 함께 점검하세요."
      : "선택한 문서의 한글 맞춤법, 띄어쓰기, 조사, 어색한 표현과 용어 일관성을 보수적으로 점검하세요. 확신이 낮은 항목은 제안으로만 표시하세요.";
    return runLocalAi("semantic-check", statement, "Local AI 보조 점검 결과를 준비했습니다.");
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
    setFiles([]);
    setSelected([]);
    clearResults();
    setNotice({ tone: "info", message: "브라우저 메모리에서 파일과 결과를 모두 지웠습니다." });
  };

  const actionDisabled = busy || selected.length === 0 || (activeTab === "Compare" && selected.length !== 2) || (activeTab === "Ask" && !question.trim());
  const fileNames = new Map(files.map((file) => [file.id, file.name]));

  return (
    <main className="workspace-shell">
      <a className="skip-link" href="#workspace-content">본문으로 건너뛰기</a>
      <header className="topbar">
        <div className="brand">
          <WorkLensLogo size={26} />
        </div>
        <p>Analyze. Compare. Verify.</p>
        <div className="session-meta">
          <span className="session-state">
            <span className="state-dot" aria-hidden="true" />
            In-browser session · 서버 저장 없음
          </span>
          <button type="button" className="delete-all" onClick={deleteAll} disabled={busy}>모두 삭제</button>
        </div>
      </header>
      <nav className="tabs" aria-label="Workspace views">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            className={activeTab === tab ? "active" : ""}
            aria-current={activeTab === tab ? "page" : undefined}
            aria-label={tab}
            onClick={() => {
              setActiveTab(tab);
              setOperationResult(null);
              setComparison(null);
              setCompareIds(null);
              setDetail(null);
            }}
          >
            <span>{tabMeta[tab].label}</span>
            <small aria-hidden="true">{tabMeta[tab].description}</small>
          </button>
        ))}
      </nav>
      <section className="workspace" id="workspace-content" aria-busy={busy || uploading}>
        <div className="context-strip">
          <p className="privacy-note">
            <strong>In-browser workspace</strong>
            파일과 분석 결과는 이 탭의 메모리에만 있습니다. 새로고침하거나 탭을 닫으면 즉시 사라집니다.
          </p>
          <span className="selection-count">{selected.length} selected</span>
        </div>
        {notice ? (
          <div className={`notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"} aria-live={notice.tone === "error" ? "assertive" : "polite"}>
            <span className="notice-marker" aria-hidden="true" />
            <div>
              <strong>{notice.tone === "error" ? "작업을 완료하지 못했습니다" : notice.tone === "success" ? "작업 완료" : "처리 상태"}</strong>
              <p>{notice.message}</p>
              {notice.tone === "error" ? <small>{notice.message.includes("Local AI") ? "Analyze, Compare, Check, Extract는 Local AI 없이 계속 사용할 수 있습니다." : "파일 형식과 선택 상태를 확인한 뒤 다시 시도하세요."}</small> : null}
            </div>
          </div>
        ) : null}
        <>
            <section className="panel file-panel" aria-labelledby="files-heading">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">File context</p>
                  <h1 id="files-heading">분석 파일</h1>
                </div>
                <span><strong>{files.length}</strong> files</span>
              </div>
              <div className={`dropzone${uploading ? " busy" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
                <input ref={inputRef} type="file" multiple accept=".xlsx,.csv,.pdf,.docx,.pptx" aria-label="분석 파일 선택" onChange={(event: ChangeEvent<HTMLInputElement>) => { enqueueUploads(event.target.files); event.target.value = ""; }} />
                <div>
                  <strong>{uploading ? "파일을 읽고 구조를 분석하는 중" : "업무 파일 추가"}</strong>
                  <span>XLSX, CSV, PDF, DOCX, PPTX · 파일당 최대 50 MB · 임시 처리</span>
                </div>
                <span className="drop-hint">여기로 끌어놓기</span>
                <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading}>
                  {uploading ? "분석 중…" : "파일 선택"}
                </button>
              </div>
              {files.length === 0 ? (
                <div className="empty-state">
                  <span className="state-code">NO FILES</span>
                  <strong>아직 파일이 없습니다.</strong>
                  <p>파일을 추가하면 구조를 확인하고 분석·비교·검수할 수 있습니다.</p>
                </div>
              ) : (
                <div className="file-list">
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
                        <div className="structure-counts">{counts.length ? counts.map((count) => <span key={count.label}>{count.label}: <b>{count.value}</b></span>) : <span>순서 기반 구조 준비됨</span>}</div>
                        {file.warnings.length ? <span className="warning" title={file.warnings.join("\n")}>주의 {file.warnings.length}</span> : <span className="muted">없음</span>}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
            <section className="operation-bar" aria-label={`${activeTab} action`}>
              <div className="operation-context">
                <p className="eyebrow">Current task</p>
                <strong>{activeTab}</strong>
                <span>{activeTab === "Compare" ? "기준과 현재 파일을 순서대로 두 개 선택하세요." : activeTab === "Check" ? "Writing, Consistency, Data, Privacy 영역을 한 번에 검수합니다." : (activeTab === "Ask" || activeTab === "Brief") ? "Local AI는 최대 5개 파일에서 근거를 확인합니다." : "최대 10개 파일을 함께 처리할 수 있습니다."}</span>
              </div>
              {(activeTab === "Ask" || activeTab === "Brief") ? (
                <label className="question-field">
                  <span>{activeTab === "Ask" ? "Ask this file" : "Brief focus · 선택 사항"}</span>
                  <input value={question} maxLength={2000} onChange={(event) => setQuestion(event.target.value)} placeholder={activeTab === "Ask" ? "선택한 문서에서 확인할 내용을 입력하세요" : "브리프의 초점을 입력하세요"} />
                  <small>{question.length.toLocaleString("ko-KR")} / 2,000</small>
                </label>
              ) : null}
              <div className="operation-actions">
                {(activeTab === "Analyze" || activeTab === "Compare" || activeTab === "Check") ? <button type="button" className="secondary-action" onClick={runAiAssist} disabled={busy || selected.length === 0}>{activeTab === "Check" ? "Local AI 문장 검수" : "Local AI 보조"}</button> : null}
                <button type="button" onClick={runActive} disabled={actionDisabled}>{busy ? "처리 중…" : `${activeTab} 실행`}</button>
              </div>
            </section>
            {busy ? <div className="processing-bar" role="status"><span aria-hidden="true" /><strong>{activeTab} 처리 중</strong><small>선택한 파일의 구조와 근거를 확인하고 있습니다.</small></div> : null}
            {activeTab === "Extract" && operationResult ? (
              <div className="export-actions">
                <span>전체 추출 결과를 파일로 저장합니다.</span>
                <button type="button" className="secondary-action" onClick={() => exportFiles("csv")} disabled={busy}>CSV 다운로드</button>
                <button type="button" onClick={() => exportFiles("xlsx")} disabled={busy}>XLSX 다운로드</button>
              </div>
            ) : null}
            {activeTab === "Compare"
              ? <ComparisonView comparison={comparison} compareIds={compareIds} fileNames={fileNames} detail={detail} onSource={openSource} onCloseSource={closeSource} />
              : <ResultView tab={activeTab} result={operationResult} fileNames={fileNames} detail={detail} onSource={openSource} onCloseSource={closeSource} />}
        </>
      </section>
    </main>
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

function ResultView({ tab, result, fileNames, detail, onSource, onCloseSource }: { tab: Tab; result: unknown; fileNames: Map<string, string>; detail: DetailInfo | null; onSource: SourceHandler; onCloseSource: () => void }) {
  if (!result) {
    const copy: Record<Exclude<Tab, "Compare">, { code: string; title: string; body: string }> = {
      Analyze: { code: "READY TO ANALYZE", title: "분석 준비됨", body: "문서 구조, 수치 범위, 명시된 합계를 근거와 함께 확인합니다." },
      Ask: { code: "ASK THIS FILE", title: "질문 준비됨", body: "선택한 파일 안에서 답을 찾고 원문 또는 계산 근거를 연결합니다." },
      Check: { code: "READY TO CHECK", title: "최종 검수 준비됨", body: "오타, 표현, 용어, 수치, 날짜, 단위, 개인정보와 문서 구조를 근거와 함께 점검합니다." },
      Extract: { code: "READY TO EXTRACT", title: "추출 준비됨", body: "표와 문단을 구조화해 확인하고 CSV 또는 XLSX로 내보냅니다." },
      Brief: { code: "READY TO BRIEF", title: "브리프 준비됨", body: "파일의 핵심 내용을 업무 문서 형식으로 요약하고 근거를 표시합니다." },
    };
    const state = copy[tab as Exclude<Tab, "Compare">];
    return <section className="state-card result-placeholder"><span className="state-code">{state.code}</span><h2>{state.title}</h2><p>{state.body}</p><small>위에서 파일을 선택한 뒤 {tab} 실행을 누르세요.</small></section>;
  }

  let content: React.ReactNode;
  if (tab === "Analyze" && Array.isArray(result)) content = <AnalyzeResults entries={result as AnalyzeEntry[]} fileNames={fileNames} onSource={onSource} />;
  else if (tab === "Check" && Array.isArray(result)) content = <CheckResults entries={result as CheckEntry[]} fileNames={fileNames} onSource={onSource} />;
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

function CheckResults({ entries, fileNames, onSource }: { entries: CheckEntry[]; fileNames: Map<string, string>; onSource: SourceHandler }) {
  const [severityFilter, setSeverityFilter] = useState<"all" | CheckSeverity>("all");
  const [groupFilter, setGroupFilter] = useState<"all" | CheckCategoryGroup>("all");
  const [expandedFindingId, setExpandedFindingId] = useState<string | null>(null);
  const indexed = entries.flatMap((entry) => entry.check.findings.map((finding) => ({ finding, file: entry.file })));
  const findings = indexed.map(({ finding }) => finding);
  const counts: Record<CheckSeverity, number> = {
    critical: findings.filter((finding) => finding.severity === "critical").length,
    warning: findings.filter((finding) => finding.severity === "warning").length,
    suggestion: findings.filter((finding) => finding.severity === "suggestion").length,
  };
  const groupCounts: Record<CheckCategoryGroup, number> = {
    writing: findings.filter((finding) => checkCategoryGroup(finding.category) === "writing").length,
    consistency: findings.filter((finding) => checkCategoryGroup(finding.category) === "consistency").length,
    data: findings.filter((finding) => checkCategoryGroup(finding.category) === "data").length,
    privacy: findings.filter((finding) => checkCategoryGroup(finding.category) === "privacy").length,
  };
  const filtered = indexed.filter(({ finding }) =>
    (severityFilter === "all" || finding.severity === severityFilter)
    && (groupFilter === "all" || checkCategoryGroup(finding.category) === groupFilter));
  const byId = new Map(findings.map((finding) => [finding.id, finding]));

  return (
    <div className="result-sections check-results">
      <section className="qa-overview" aria-label="Check summary">
        <div className="qa-intro">
          <span className="result-type">PRE-SHARE REVIEW</span>
          <h3>문서 제출 전 최종 검수</h3>
          <p>확실한 문제는 Warning 또는 Critical로, 문맥 판단이 필요한 항목은 Suggestion으로 구분했습니다.</p>
          <small>문장과 맞춤법의 고급 검수는 Local AI 문장 검수에서 별도로 실행할 수 있습니다.</small>
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

      {findings.length === 0 ? (
        <div className="empty-state success-state"><span className="state-code">REVIEW CLEAR</span><strong>확인된 문제가 없습니다.</strong><p>현재 규칙 범위에서 작성, 일관성, 데이터와 개인정보 문제를 찾지 못했습니다.</p></div>
      ) : (
        <>
          <section className="check-filters" aria-label="Check result filters">
            <fieldset>
              <legend>Severity</legend>
              <div>
                <button type="button" aria-pressed={severityFilter === "all"} onClick={() => setSeverityFilter("all")}>All <b>{findings.length}</b></button>
                {(["critical", "warning", "suggestion"] as const).map((severity) => (
                  <button type="button" key={severity} aria-pressed={severityFilter === severity} onClick={() => setSeverityFilter(severity)}>
                    {severityLabels[severity]} <b>{counts[severity]}</b>
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Category</legend>
              <div>
                <button type="button" aria-pressed={groupFilter === "all"} onClick={() => setGroupFilter("all")}>All <b>{findings.length}</b></button>
                {(Object.keys(checkGroupLabels) as CheckCategoryGroup[]).map((group) => (
                  <button type="button" key={group} aria-pressed={groupFilter === group} onClick={() => setGroupFilter(group)}>
                    {checkGroupLabels[group]} <b>{groupCounts[group]}</b>
                  </button>
                ))}
              </div>
            </fieldset>
          </section>

          {filtered.length ? (
            <section className="check-table" role="table" aria-label="문서 검수 결과">
              <div className="check-table-head" role="row">
                <span role="columnheader">Severity</span>
                <span role="columnheader">Category</span>
                <span role="columnheader">Issue</span>
                <span role="columnheader">Source</span>
                <span role="columnheader">Recommendation</span>
              </div>
              <div className="check-table-body">
                {filtered.map(({ finding, file }) => {
                  const expanded = expandedFindingId === finding.id;
                  return (
                    <article className={`check-issue severity-${finding.severity}${expanded ? " expanded" : ""}`} key={finding.id}>
                      <div className="check-issue-row" role="row">
                        <span role="cell" className="check-severity"><i className={`severity-mark ${finding.severity}`} aria-hidden="true" />{severityLabels[finding.severity]}</span>
                        <span role="cell" className="check-category">{checkCategoryLabels[finding.category]}</span>
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
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </section>
          ) : <div className="filter-empty"><strong>필터 조건에 맞는 Finding이 없습니다.</strong><button type="button" onClick={() => { setSeverityFilter("all"); setGroupFilter("all"); }}>필터 초기화</button></div>}
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
  if (!comparison) return <section className="state-card result-placeholder"><span className="state-code">READY TO COMPARE</span><h2>비교 준비됨</h2><p>기준 파일과 현재 파일을 순서대로 선택하면 내용, 수치, 구조의 차이를 구분해 표시합니다.</p><small>두 파일을 선택한 뒤 Compare 실행을 누르세요.</small></section>;
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
        <div className="empty-state success-state"><span className="state-code">NO DIFFERENCE</span><strong>비교된 변경 사항이 없습니다.</strong><p>지원되는 내용, 수치 및 구조 범위에서 두 파일이 같습니다.</p></div>
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
