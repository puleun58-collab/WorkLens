"use client";

import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from "react";
import type { ComparisonItem, ComparisonResult } from "@/domain/compare";
import type { DocumentMetadata, SourceRef } from "@/domain/document";

type FileSummary = {
  id: string;
  name: string;
  kind: string;
  size: number;
  status: string;
  metadata: DocumentMetadata;
  warnings: string[];
};
type ApiError = { code: string; message: string; retryable?: boolean };
type Notice = { tone: "error" | "success" | "info"; message: string };
const tabs = ["Analyze", "Ask", "Compare", "Check", "Extract", "Brief"] as const;
type Tab = (typeof tabs)[number];

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}
function apiError(payload: unknown, fallback: string): ApiError {
  return (payload as { error?: ApiError })?.error ?? { code: "REQUEST_FAILED", message: fallback, retryable: true };
}
function displayValue(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined || value === "") return "—";
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

export default function Home() {
  const [files, setFiles] = useState<FileSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("Analyze");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [expired, setExpired] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [compareIds, setCompareIds] = useState<{ baseFileId: string; targetFileId: string } | null>(null);
  const [operationResult, setOperationResult] = useState<unknown>(null);
  const [detail, setDetail] = useState<DetailInfo | null>(null);
  const [question, setQuestion] = useState("");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadQueue = useRef<Promise<void>>(Promise.resolve());
  const sessionReady = useRef<Promise<void> | null>(null);
  const csrfToken = useRef<string | null>(null);
  const tabLease = useRef<{ tabId: string; releaseToken: string; releaseNonce: string } | null>(null);
  const sessionTtlMs = useRef<number | null>(null);
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

  const expireNow = useCallback(() => {
    sessionReady.current = null;
    csrfToken.current = null;
    setExpired(true);
    setFiles([]);
    setSelected([]);
    setOperationResult(null);
    setComparison(null);
    setCompareIds(null);
    setDetail(null);
  }, []);

  const noteRenewal = useCallback(() => {
    if (sessionTtlMs.current === null) return;
    setExpiresAt(Date.now() + sessionTtlMs.current);
  }, []);

  const mutationHeaders = useCallback((headers?: HeadersInit) => {
    const token = csrfToken.current;
    if (!token) throw { code: "CSRF_MISSING", message: "세션 검증 토큰이 없습니다. 다시 시도하세요." } satisfies ApiError;
    const result = new Headers(headers);
    result.set("x-worklens-csrf", token);
    return result;
  }, []);

  const ensureSession = useCallback(() => {
    if (!sessionReady.current) {
      sessionReady.current = (async () => {
        const response = await fetch("/api/session", { method: "POST", credentials: "same-origin" });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          sessionReady.current = null;
          throw apiError(payload, "작업 공간을 시작하지 못했습니다.");
        }
        const remoteExpiresAt = Date.parse((payload as { data?: { expiresAt?: string } })?.data?.expiresAt ?? "");
        const token = (payload as { data?: { csrfToken?: unknown } })?.data?.csrfToken;
        if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
          sessionReady.current = null;
          throw { code: "CSRF_MISSING", message: "세션 검증 토큰을 받지 못했습니다." } satisfies ApiError;
        }
        csrfToken.current = token;
        if (Number.isFinite(remoteExpiresAt)) {
          sessionTtlMs.current = remoteExpiresAt - Date.now();
          setExpiresAt(remoteExpiresAt);
        }
      })();
    }
    return sessionReady.current;
  }, []);

  const request = useCallback(async (input: RequestInfo, init?: RequestInit): Promise<unknown> => {
    const send = async (retry: boolean): Promise<unknown> => {
      await ensureSession();
      const method = init?.method?.toUpperCase() ?? "GET";
      const response = await fetch(input, {
        ...init,
        credentials: "same-origin",
        ...(method === "GET" || method === "HEAD" ? {} : { headers: mutationHeaders(init?.headers) }),
      });
      if (response.status === 401 && retry) {
        sessionReady.current = null;
        csrfToken.current = null;
        return send(false);
      }
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const error = apiError(payload, "요청을 처리하지 못했습니다.");
        if (response.status === 410) expireNow();
        throw error;
      }
      noteRenewal();
      return payload;
    };
    return send(true);
  }, [ensureSession, expireNow, mutationHeaders, noteRenewal]);

  const loadFiles = useCallback(async () => {
    const payload = await request("/api/files");
    setFiles((payload as { data?: { files?: FileSummary[] } }).data?.files ?? []);
  }, [request]);

  useEffect(() => {
    let mounted = true;
    const registerLease = async () => {
      const tabResponse = await fetch("/api/session/tabs", {
        method: "POST",
        credentials: "same-origin",
        headers: mutationHeaders(),
      });
      if (!tabResponse.ok) throw apiError(await tabResponse.json().catch(() => null), "탭 세션을 시작하지 못했습니다.");
      const tabData = (await tabResponse.json() as { data: { tabId: string; releaseToken: string; releaseNonce: string } }).data;
      const lease = { tabId: tabData.tabId, releaseToken: tabData.releaseToken, releaseNonce: tabData.releaseNonce };
      tabLease.current = lease;
      noteRenewal();
    };
    const renewLease = async () => {
      const lease = tabLease.current;
      if (!lease) return registerLease();
      const response = await fetch("/api/session/tabs", {
        method: "PUT",
        credentials: "same-origin",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ tabId: lease.tabId, releaseToken: lease.releaseToken }),
      });
      if (response.status === 409) return registerLease();
      if (!response.ok) throw apiError(await response.json().catch(() => null), "탭 세션을 갱신하지 못했습니다.");
      noteRenewal();
    };
    void (async () => {
      try {
        await ensureSession();
        await registerLease();
        await loadFiles();
      } catch (error) {
        if (mounted) setNotice({ tone: "error", message: (error as ApiError).message ?? "작업 공간을 시작하지 못했습니다." });
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    const release = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      const lease = tabLease.current;
      if (!lease) return;
      navigator.sendBeacon(
        "/api/session/release",
        new Blob([JSON.stringify({ tabId: lease.tabId, releaseNonce: lease.releaseNonce })], { type: "text/plain" }),
      );
    };
    const heartbeat = window.setInterval(() => {
      if (document.visibilityState === "visible" && tabLease.current) {
        void renewLease().catch(() => undefined);
      }
    }, 30_000);
    (window as typeof window & { __worklensHeartbeat?: number }).__worklensHeartbeat = heartbeat;
    const revalidate = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setLoading(true);
      setComparison(null);
      setOperationResult(null);
      setDetail(null);
      void renewLease()
        .then(loadFiles)
        .catch((error: ApiError) => {
          setFiles([]);
          setNotice({ tone: "error", message: error.message ?? "세션을 다시 확인하지 못했습니다." });
        })
        .finally(() => setLoading(false));
    };
    const resumeVisible = () => {
      if (document.visibilityState === "visible") void renewLease().catch(() => undefined);
    };
    window.addEventListener("pagehide", release);
    window.addEventListener("pageshow", revalidate);
    document.addEventListener("visibilitychange", resumeVisible);
    return () => {
      mounted = false;
      window.clearInterval(heartbeat);
      delete (window as typeof window & { __worklensHeartbeat?: number }).__worklensHeartbeat;
      window.removeEventListener("pagehide", release);
      window.removeEventListener("pageshow", revalidate);
      document.removeEventListener("visibilitychange", resumeVisible);
    };
  }, [ensureSession, loadFiles, mutationHeaders, noteRenewal]);

  useEffect(() => {
    if (expiresAt === null || expired) return;
    const remaining = Math.max(0, expiresAt - Date.now());
    const timer = window.setTimeout(expireNow, remaining);
    return () => window.clearTimeout(timer);
  }, [expiresAt, expired, expireNow]);

  const upload = async (file: File) => {
    const extension = file.name.toLowerCase().split(".").pop();
    if (!extension || !["xlsx", "csv", "pdf", "docx", "pptx"].includes(extension)) {
      setNotice({ tone: "error", message: "XLSX, CSV, PDF, DOCX 또는 PPTX 파일만 업로드할 수 있습니다." });
      return;
    }
    setUploading(true);
    setNotice({ tone: "info", message: `${file.name}을(를) 분석 중입니다.` });
    try {
      const payload = await request("/api/files", {
        method: "POST",
        headers: {
          "x-file-name": encodeURIComponent(file.name),
          "content-type": file.type || "application/octet-stream",
          "content-length": String(file.size),
        },
        body: file,
      });
      const saved = (payload as { data?: { file?: FileSummary } }).data?.file;
      if (saved) setFiles((current) => [...current, saved]);
      else await loadFiles();
      setNotice({ tone: "success", message: `${file.name} 분석이 완료되었습니다.` });
    } catch (error) {
      setNotice({ tone: "error", message: (error as ApiError).message ?? "업로드에 실패했습니다." });
    } finally {
      setUploading(false);
    }
  };

  const enqueueUploads = (list: FileList | null) => {
    if (expired) return;
    for (const file of Array.from(list ?? [])) uploadQueue.current = uploadQueue.current.then(() => upload(file));
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    enqueueUploads(event.dataTransfer.files);
  };
  const toggleFile = (id: string) => {
    setSelected((current) => current.includes(id) ? current.filter((fileId) => fileId !== id) : current.length < 10 ? [...current, id] : current);
    setOperationResult(null);
    setComparison(null);
    setCompareIds(null);
    setDetail(null);
  };

  const runJsonOperation = async (route: string, body: object, success: string) => {
    setBusy(true);
    setNotice(null);
    setDetail(null);
    try {
      const payload = await request(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      setOperationResult((payload as { data?: { result?: unknown } }).data?.result ?? null);
      setNotice({ tone: "success", message: success });
    } catch (error) {
      setOperationResult(null);
      setNotice({ tone: "error", message: (error as ApiError).message ?? "작업에 실패했습니다." });
    } finally {
      setBusy(false);
    }
  };

  const runActive = async () => {
    if (!selected.length || expired) return;
    if (activeTab === "Compare") {
      if (selected.length !== 2) return;
      setBusy(true);
      setNotice(null);
      try {
        const baseFileId = selected[0];
        const targetFileId = selected[1];
        const payload = await request("/api/compare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseFileId, targetFileId }) });
        setComparison((payload as { data?: { comparison?: ComparisonResult } }).data?.comparison ?? null);
        setCompareIds({ baseFileId, targetFileId });
        setNotice({ tone: "success", message: "비교 결과를 준비했습니다." });
      } catch (error) {
        setNotice({ tone: "error", message: (error as ApiError).message ?? "비교에 실패했습니다." });
      } finally {
        setBusy(false);
      }
      return;
    }
    if (activeTab === "Analyze") return runJsonOperation("/api/analyze", { fileIds: selected }, "구조 및 수치 분석을 완료했습니다.");
    if (activeTab === "Check") return runJsonOperation("/api/check", { fileIds: selected }, "콘텐츠 및 개인정보 점검을 완료했습니다.");
    if (activeTab === "Extract") return runJsonOperation("/api/extract", { fileIds: selected }, "구조화 추출을 완료했습니다.");
    if (selected.length > 5) {
      setNotice({ tone: "error", message: "Local AI 작업은 최대 5개 파일만 선택할 수 있습니다." });
      return;
    }
    const task = activeTab === "Ask" ? "ask" : "brief";
    return runJsonOperation("/api/ai", { task, fileIds: selected, ...(question.trim() ? { question: question.trim() } : {}) }, `${activeTab} 결과를 준비했습니다.`);
  };

  const runAiAssist = () => {
    if (selected.length > 5) {
      setNotice({ tone: "error", message: "Local AI 작업은 최대 5개 파일만 선택할 수 있습니다." });
      return;
    }
    if (activeTab === "Analyze") {
      return runJsonOperation("/api/ai", { task: "analyze", fileIds: selected }, "Local AI 분석 결과를 준비했습니다.");
    }
    const question = activeTab === "Compare"
      ? "선택한 문서 사이의 중요한 의미 변화를 근거와 함께 점검하세요."
      : "선택한 문서의 표현, 일관성, 의미상 위험을 근거와 함께 점검하세요.";
    return runJsonOperation("/api/ai", { task: "semantic-check", fileIds: selected, question }, "Local AI 보조 점검 결과를 준비했습니다.");
  };

  const exportFiles = async (format: "csv" | "xlsx") => {
    if (!selected.length) return;
    setBusy(true);
    try {
      await ensureSession();
      const response = await fetch("/api/export", {
        method: "POST",
        credentials: "same-origin",
        headers: mutationHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ fileIds: selected, format }),
      });
      if (!response.ok) throw apiError(await response.json().catch(() => null), "내보내기에 실패했습니다.");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `worklens-export.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice({ tone: "success", message: `${format.toUpperCase()} 파일을 다운로드했습니다. 다운로드된 복사본은 사용자 기기에서 직접 관리하세요.` });
    } catch (error) {
      setNotice({ tone: "error", message: (error as ApiError).message ?? "내보내기에 실패했습니다." });
    } finally {
      setBusy(false);
    }
  };

  const deleteAll = async () => {
    if (!window.confirm("현재 세션의 원본과 결과를 모두 삭제하시겠습니까?")) return;
    setBusy(true);
    try {
      await ensureSession();
      const response = await fetch("/api/session", {
        method: "DELETE",
        credentials: "same-origin",
        headers: mutationHeaders(),
      });
      if (!response.ok) throw apiError(await response.json().catch(() => null), "삭제에 실패했습니다.");
      sessionReady.current = null;
      csrfToken.current = null;
      setFiles([]);
      setSelected([]);
      setComparison(null);
      setCompareIds(null);
      setOperationResult(null);
      setDetail(null);
      setExpired(true);
      setNotice(null);
    } catch (error) {
      setNotice({ tone: "error", message: (error as ApiError).message ?? "삭제에 실패했습니다." });
    } finally {
      setBusy(false);
    }
  };

  const actionDisabled = busy || expired || selected.length === 0 || (activeTab === "Compare" && selected.length !== 2) || (activeTab === "Ask" && !question.trim());
  const fileNames = new Map(files.map((file) => [file.id, file.name]));

  return <main className="workspace-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">W</span><span>WorkLens</span></div>
      <p>Analyze. Compare. Verify.</p>
      <span className={`session-state${expired ? " is-expired" : ""}`}>{expired ? "Session expired" : "Private session · 2시간 임시 보관"}</span>
      {!expired ? <button type="button" className="delete-all" onClick={deleteAll} disabled={busy}>모두 삭제</button> : null}
    </header>
    <nav className="tabs" aria-label="Workspace views">{tabs.map((tab) => <button key={tab} type="button" className={activeTab === tab ? "active" : ""} aria-current={activeTab === tab ? "page" : undefined} onClick={() => { setActiveTab(tab); setOperationResult(null); setComparison(null); setCompareIds(null); setDetail(null); }}>{tab}</button>)}</nav>
    <section className="workspace">
      <p className="privacy-note">서버의 원본과 결과는 마지막 활동 후 2시간 뒤 삭제됩니다. 다운로드한 복사본은 사용자 기기에서 직접 관리해야 합니다.</p>
      {expired ? <div className="state-card error-state"><h1>세션이 만료되었습니다</h1><p>보안을 위해 임시 데이터가 삭제되었습니다.</p><button type="button" onClick={() => window.location.reload()}>새 세션 시작</button></div> : null}
      {notice ? <div className={`notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"} aria-live={notice.tone === "error" ? "assertive" : "polite"}>{notice.message}</div> : null}
      {!expired ? <>
        <section className="panel file-panel" aria-labelledby="files-heading">
          <div className="panel-heading"><div><p className="eyebrow">File workspace</p><h1 id="files-heading">분석 파일</h1></div><span>{files.length} files</span></div>
          <div className={`dropzone${uploading ? " busy" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
            <input ref={inputRef} type="file" multiple accept=".xlsx,.csv,.pdf,.docx,.pptx" aria-label="분석 파일 선택" onChange={(event: ChangeEvent<HTMLInputElement>) => { enqueueUploads(event.target.files); event.target.value = ""; }} />
            <strong>{uploading ? "업로드 및 분석 중…" : "XLSX · CSV · PDF · DOCX · PPTX 드롭"}</strong><span>또는</span>
            <button type="button" onClick={() => inputRef.current?.click()}>파일 선택</button>
          </div>
          {loading ? <div className="empty-state">파일 작업 공간을 불러오는 중…</div> : files.length === 0 ? <div className="empty-state">아직 파일이 없습니다. 문서를 추가하여 구조를 확인하세요.</div> : <div className="file-list">{files.map((file) => {
            const checked = selected.includes(file.id);
            const counts = structureCounts(file.metadata);
            return <article className={`file-row${checked ? " selected" : ""}`} key={file.id}>
              <label className="select-file"><input type="checkbox" checked={checked} disabled={!checked && selected.length === 10} onChange={() => toggleFile(file.id)} aria-label={`${file.name} 선택`} /><span /></label>
              <div className="file-info"><strong title={file.name}>{file.name}</strong><span>{file.kind} · {formatBytes(file.size)}</span></div>
              <span className={`status status-${file.status.toLowerCase()}`}>{file.status}</span>
              <div className="structure-counts">{counts.length ? counts.map((count) => <span key={count.label}>{count.label}: {count.value}</span>) : <span>순서 기반 구조 준비됨</span>}</div>
              {file.warnings.length ? <span className="warning" title={file.warnings.join("\n")}>주의 {file.warnings.length}</span> : null}
            </article>;
          })}</div>}
        </section>
        <section className="operation-bar" aria-label={`${activeTab} action`}>
          <div><strong>{activeTab} · {selected.length}개 선택</strong><span>{activeTab === "Compare" ? "정확히 두 파일을 선택하세요." : (activeTab === "Ask" || activeTab === "Brief") ? "Local AI는 최대 5개 파일을 선택할 수 있습니다." : "최대 10개 파일을 선택할 수 있습니다."}</span></div>
          {(activeTab === "Ask" || activeTab === "Brief") ? <label className="question-field"><span>{activeTab === "Ask" ? "질문" : "요청(선택)"}</span><input value={question} maxLength={2000} onChange={(event) => setQuestion(event.target.value)} placeholder={activeTab === "Ask" ? "선택한 문서에서 확인할 내용을 입력하세요" : "브리프의 초점을 입력하세요"} /></label> : null}
          {(activeTab === "Analyze" || activeTab === "Compare" || activeTab === "Check") ? <button type="button" className="secondary-action" onClick={runAiAssist} disabled={busy || expired || selected.length === 0}>Local AI 보조</button> : null}
          <button type="button" onClick={runActive} disabled={actionDisabled}>{busy ? "처리 중…" : `${activeTab} 실행`}</button>
        </section>
        {activeTab === "Extract" && operationResult ? <div className="export-actions"><span>다운로드된 파일은 사용자 기기에서 직접 관리하세요.</span><button type="button" onClick={() => exportFiles("csv")} disabled={busy}>CSV 다운로드</button><button type="button" onClick={() => exportFiles("xlsx")} disabled={busy}>XLSX 다운로드</button></div> : null}
        {activeTab === "Compare"
          ? <ComparisonView comparison={comparison} compareIds={compareIds} fileNames={fileNames} detail={detail} onSource={openSource} onCloseSource={closeSource} />
          : <ResultView tab={activeTab} result={operationResult} fileNames={fileNames} detail={detail} onSource={openSource} onCloseSource={closeSource} />}
      </> : null}
    </section>
  </main>;
}

function sourceLabel(source: SourceRef, fileNames: Map<string, string>, role?: SourceRole): string {
  const fileName = fileNames.get(source.fileId);
  const roleLabel = role === "base" ? "기준" : role === "current" ? "현재" : undefined;
  const revision = source.documentVersion
    ? `버전 ${source.documentVersion.slice(0, 8)}`
    : `파일 ${source.fileId.slice(0, 8)}`;
  const parts = [fileName, revision, roleLabel].filter((part): part is string => Boolean(part));
  return parts.length ? `${source.label} (${parts.join(" · ")})` : source.label;
}

function ResultView({ tab, result, fileNames, detail, onSource, onCloseSource }: { tab: Tab; result: unknown; fileNames: Map<string, string>; detail: DetailInfo | null; onSource: (source: SourceRef, role: SourceRole | undefined, trigger: HTMLElement | null) => void; onCloseSource: () => void }) {
  if (!result) return <section className="state-card result-placeholder"><h2>{tab} 준비됨</h2><p>파일을 선택하고 실행하면 근거가 포함된 결과를 표시합니다.</p></section>;
  return <section className="panel results-panel"><div className="panel-heading"><div><p className="eyebrow">{tab}</p><h2>결과</h2></div></div><JsonValue value={result} fileNames={fileNames} onSource={onSource} />{detail ? <SourceDetail source={detail.source} label={sourceLabel(detail.source, fileNames, detail.role)} onClose={onCloseSource} /> : null}</section>;
}

function JsonValue({ value, fileNames, onSource, depth = 0 }: { value: unknown; fileNames: Map<string, string>; onSource: (source: SourceRef, role: SourceRole | undefined, trigger: HTMLElement | null) => void; depth?: number }): React.ReactNode {
  if (isSourceRef(value)) return <button type="button" className="source-link" onClick={(event) => onSource(value, undefined, event.currentTarget)}>{sourceLabel(value, fileNames)}</button>;
  if (Array.isArray(value)) return value.length ? <div className={`result-list depth-${Math.min(depth, 2)}`}>{value.map((item, index) => <div className="result-entry" key={index}><JsonValue value={item} fileNames={fileNames} onSource={onSource} depth={depth + 1} /></div>)}</div> : <span className="muted">항목 없음</span>;
  if (typeof value === "object" && value !== null) return <dl className="result-object">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{key}</dt><dd><JsonValue value={item} fileNames={fileNames} onSource={onSource} depth={depth + 1} /></dd></div>)}</dl>;
  return <span>{displayValue(value as string | number | boolean | null | undefined)}</span>;
}

function ComparisonView({ comparison, compareIds, fileNames, detail, onSource, onCloseSource }: { comparison: ComparisonResult | null; compareIds: { baseFileId: string; targetFileId: string } | null; fileNames: Map<string, string>; detail: DetailInfo | null; onSource: (source: SourceRef, role: SourceRole | undefined, trigger: HTMLElement | null) => void; onCloseSource: () => void }) {
  if (!comparison) return <section className="state-card result-placeholder"><h2>Compare 준비됨</h2><p>두 파일을 선택하고 실행하면 변경 사항을 표시합니다.</p></section>;
  const roleOf = (source: SourceRef): SourceRole | undefined => {
    if (!compareIds) return undefined;
    if (source.fileId === compareIds.baseFileId) return "base";
    if (source.fileId === compareIds.targetFileId) return "current";
    return undefined;
  };
  return <section className="panel results-panel">
    <div className="panel-heading"><div><p className="eyebrow">Comparison</p><h2>변경 사항</h2></div><span>{comparison.items.length} items</span></div>
    <dl className="summary">{Object.entries(comparison.summary).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
    {comparison.items.length === 0 ? <div className="empty-state">비교된 변경 사항이 없습니다.</div> : <div className="change-table" role="table">
      <div className="change-head" role="row"><span role="columnheader">Category</span><span role="columnheader">Item</span><span role="columnheader">Previous</span><span role="columnheader">Current</span><span role="columnheader">Difference</span><span role="columnheader">Change</span><span role="columnheader">Source</span></div>
      {comparison.items.map((item: ComparisonItem) => <div className="change-row" role="row" key={item.id} data-testid="change-row" data-category={item.category}>
        <strong role="cell">{item.category}</strong><span role="cell" className="change-label">{item.label}</span><span role="cell">{displayValue(item.previous)}</span><span role="cell">{displayValue(item.current)}</span><span role="cell">{displayValue(item.difference)}</span><span role="cell">{item.changePercent === null ? "—" : `${item.changePercent.toFixed(2)}%`}</span>
        <div role="cell" className="source-actions">{item.sources.length ? item.sources.map((source, index) => <button type="button" key={`${source.nodeId}-${index}`} onClick={(event) => onSource(source, roleOf(source), event.currentTarget)}>{sourceLabel(source, fileNames, roleOf(source))}</button>) : "—"}</div>
      </div>)}</div>}
    {detail ? <SourceDetail source={detail.source} label={sourceLabel(detail.source, fileNames, detail.role)} onClose={onCloseSource} /> : null}
  </section>;
}

function SourceDetail({ source, label, onClose }: { source: SourceRef; label: string; onClose: () => void }) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);
  return <aside ref={panelRef} className="source-detail" aria-label="Source detail" tabIndex={-1}><div><p className="eyebrow">Source detail</p><h2>{label}</h2></div><button type="button" onClick={onClose} aria-label="닫기">×</button><p>{source.quote ?? "인용문이 제공되지 않았습니다."}</p><dl>{source.page !== undefined ? <div><dt>Page/Slide</dt><dd>{source.page}</dd></div> : null}{source.sheet ? <div><dt>Sheet</dt><dd>{source.sheet}</dd></div> : null}{source.cellRange ? <div><dt>Range</dt><dd>{source.cellRange}</dd></div> : null}</dl></aside>;
}
