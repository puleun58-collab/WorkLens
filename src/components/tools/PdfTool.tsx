"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import {
  exportPdfPages,
  movePdfPage,
  normalizeRotation,
  pagesForExport,
  pdfError,
  type PdfCompression,
  type PdfCompressionLevel,
  type PdfExportResult,
  type PdfInputSource,
  type PdfOutputFormat,
  type PdfPageItem,
  type PdfPageRenderer,
} from "@/lib/tools/pdf";
import { loadBrowserPdf, recompressBrowserJpeg, renderBrowserPdfPage } from "@/lib/tools/pdf-render";
import "./pdf-tool.css";

interface WorkspaceSource extends PdfInputSource {
  id: string;
  pageCount: number;
  task: PDFDocumentLoadingTask;
}

const COMPRESSION_LEVELS: ReadonlyArray<{ level: PdfCompressionLevel; label: string; detail: string }> = [
  { level: "quality", label: "품질 우선", detail: "텍스트와 이미지를 그대로 두고 파일 구조만 정리합니다. 용량 감소는 작을 수 있습니다." },
  { level: "balanced", label: "균형 압축", detail: "문서 속 JPG 이미지를 적당히 다시 압축합니다. 텍스트와 링크는 유지됩니다." },
  { level: "size", label: "용량 우선", detail: "문서 속 JPG 이미지를 더 작게 줄입니다. 이미지 화질이 낮아질 수 있습니다." },
];

function prettyBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function PdfThumbnail({ source, page, queue }: {
  source: WorkspaceSource;
  page: PdfPageItem;
  queue: PdfPageRenderer;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [preview, setPreview] = useState<{ key: string; image?: string; dimensions?: string; error?: string } | null>(null);
  const { id, sourceId, pageNumber, rotation } = page;
  const key = `${source.id}:${pageNumber}:${rotation}`;

  useEffect(() => {
    const target = host.current;
    if (!target) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "120px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let url = "";
    const renderingPage: PdfPageItem = { id, sourceId, pageNumber, rotation, selected: false };
    void queue(source, renderingPage, "jpg", 200, 0.68, controller.signal).then(({ bytes, width, height }) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
      setPreview({ key, image: url, dimensions: `${Math.round(width)} × ${Math.round(height)} pt` });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setPreview({ key, error: pdfError(cause) });
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [visible, source, id, sourceId, pageNumber, rotation, queue, key]);

  const image = preview?.key === key ? preview.image : undefined;
  const error = preview?.key === key ? preview.error : undefined;
  return <div className="pdf-tool-thumb" ref={host} aria-label={`${source.name} ${pageNumber}페이지 미리보기`}>
    {image ? <>
      {/* eslint-disable-next-line @next/next/no-img-element -- Local blob thumbnails cannot use a server image optimizer. */}
      <img src={image} alt="" />
      <span className="pdf-tool-thumb-dimensions">{preview?.dimensions}</span>
    </> : error ? <span role="alert">{error}</span> : <span className="pdf-tool-thumb-loading">{visible ? "미리보기 생성 중" : "스크롤하면 미리보기 표시"}</span>}
  </div>;
}

export function PdfTool() {
  const [sources, setSources] = useState<WorkspaceSource[]>([]);
  const [pages, setPages] = useState<PdfPageItem[]>([]);
  const [hadPages, setHadPages] = useState(false);
  const [format, setFormat] = useState<PdfOutputFormat>("pdf");
  const [compression, setCompression] = useState<PdfCompression>({ level: "quality", rasterize: false });
  const [scope, setScope] = useState<"all" | "selected">("all");
  const [uploading, setUploading] = useState("");
  const [exporting, setExporting] = useState("");
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<Omit<PdfExportResult, "bytes"> & { size: number } | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sourcesRef = useRef(new Map<string, WorkspaceSource>());
  const importAbort = useRef<AbortController | null>(null);
  const exportAbort = useRef<AbortController | null>(null);
  const draggedPage = useRef<string | null>(null);
  const downloadUrls = useRef(new Set<string>());
  const downloadTimers = useRef(new Set<number>());
  const renderTail = useRef<Promise<unknown>>(Promise.resolve());
  const busy = Boolean(uploading || exporting);
  const selectedCount = pages.filter((page) => page.selected).length;
  const exportCount = scope === "selected" ? selectedCount : pages.length;
  const sourceById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);

  useEffect(() => () => {
    importAbort.current?.abort();
    exportAbort.current?.abort();
    for (const source of sourcesRef.current.values()) void source.task.destroy();
    sourcesRef.current.clear();
    for (const timer of downloadTimers.current) clearTimeout(timer);
    for (const url of downloadUrls.current) URL.revokeObjectURL(url);
  }, []);

  const queueRender = useCallback<PdfPageRenderer>((source, page, targetFormat, maxEdge, quality, signal) => {
    const work = renderTail.current.catch(() => undefined).then(() => renderBrowserPdfPage(source, page, targetFormat, maxEdge, quality, signal));
    renderTail.current = work.catch(() => undefined);
    return work;
  }, []);

  async function addFiles(files: File[]) {
    if (!files.length || busy || importAbort.current || exportAbort.current) return;
    const controller = new AbortController();
    importAbort.current = controller;
    setError("");
    setOutcome(null);
    try {
      for (const [index, file] of files.entries()) {
        if (controller.signal.aborted) break;
        setUploading(`파일 ${index + 1}/${files.length} 읽는 중 · ${file.name}`);
        if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
          setError(`${file.name}: PDF 파일을 선택하세요.`);
          continue;
        }
        try {
          const { document, task } = await loadBrowserPdf(file, controller.signal, (loadingTask) => {
            controller.signal.addEventListener("abort", () => void loadingTask.destroy(), { once: true });
          });
          if (controller.signal.aborted) { await task.destroy(); break; }
          const id = crypto.randomUUID();
          const source: WorkspaceSource = { id, name: file.name, file, document, task, pageCount: document.numPages };
          sourcesRef.current.set(id, source);
          setSources((current) => [...current, source]);
          setHadPages(true);
          setPages((current) => [...current, ...Array.from({ length: document.numPages }, (_, pageIndex) => ({
            id: `${id}:${pageIndex + 1}`, sourceId: id, pageNumber: pageIndex + 1, rotation: 0, selected: false,
          }))]);
        } catch (cause) {
          if (!controller.signal.aborted) setError(`${file.name}: ${pdfError(cause)}`);
        }
      }
    } finally {
      if (importAbort.current === controller) importAbort.current = null;
      setUploading("");
    }
  }

  function handleInput(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void addFiles(files);
  }

  function removeSource(id: string) {
    const source = sourcesRef.current.get(id);
    if (source) void source.task.destroy();
    sourcesRef.current.delete(id);
    setSources((current) => current.filter((item) => item.id !== id));
    setPages((current) => current.filter((item) => item.sourceId !== id));
    setOutcome(null);
  }

  function removeSelected() {
    const remaining = pages.filter((page) => !page.selected);
    const retainedIds = new Set(remaining.map((page) => page.sourceId));
    for (const source of sources) {
      if (!retainedIds.has(source.id)) {
        void source.task.destroy();
        sourcesRef.current.delete(source.id);
      }
    }
    setSources((current) => current.filter((item) => retainedIds.has(item.id)));
    setPages(remaining);
    setOutcome(null);
  }

  async function download() {
    const chosen = pagesForExport(pages, scope);
    if (!chosen.length || busy || importAbort.current || exportAbort.current) return;
    const controller = new AbortController();
    exportAbort.current = controller;
    setError("");
    setOutcome(null);
    setExporting(`0/${chosen.length} 페이지 처리 중`);
    try {
      const result = await exportPdfPages({
        pages: chosen,
        sources: sourcesRef.current,
        format,
        compression,
        render: queueRender,
        recompress: recompressBrowserJpeg,
        signal: controller.signal,
        onProgress: (done, total) => { if (!controller.signal.aborted) setExporting(`${done}/${total} 페이지 처리 중`); },
      });
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([result.bytes as Uint8Array<ArrayBuffer>], { type: result.mime }));
      downloadUrls.current.add(url);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      const timer = window.setTimeout(() => {
        URL.revokeObjectURL(url);
        downloadUrls.current.delete(url);
        downloadTimers.current.delete(timer);
      }, 60_000);
      downloadTimers.current.add(timer);
      setOutcome({ name: result.name, mime: result.mime, pageCount: result.pageCount, inputBytes: result.inputBytes, size: result.bytes.length });
    } catch (cause) {
      if (!controller.signal.aborted) setError(pdfError(cause));
    } finally {
      if (exportAbort.current === controller) exportAbort.current = null;
      setExporting("");
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDropActive(false);
    if (event.dataTransfer.files.length) void addFiles(Array.from(event.dataTransfer.files));
  }

  return <div className="pdf-tool">
    <div className="pdf-tool-intro">
      <div><span className="pdf-tool-eyebrow">PDF · 브라우저 작업공간</span><h2>페이지 편집</h2><p>여러 PDF의 페이지를 모아 순서를 바꾸고, 필요한 형식으로 저장합니다.</p></div>
    </div>

    <section className="pdf-tool-panel pdf-tool-upload" aria-label="PDF 파일 추가" onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer.types.includes("Files")) setDropActive(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false); }} onDrop={handleDrop} data-drag-active={dropActive}>
      <div className="pdf-tool-upload-mark" aria-hidden="true">＋</div>
      <div className="pdf-tool-upload-copy"><strong>PDF를 이곳에 놓으세요</strong><span>여러 파일을 함께 추가할 수 있습니다. 원본 파일은 수정되지 않습니다.</span></div>
      <button type="button" className="pdf-tool-button pdf-tool-button-primary pdf-tool-upload-button" onClick={() => inputRef.current?.click()} disabled={busy}>{sources.length ? "PDF 추가" : "PDF 파일 선택"}</button>
      <input ref={inputRef} className="pdf-tool-input-hidden" aria-label="PDF 파일 선택" type="file" accept=".pdf,application/pdf" multiple onChange={handleInput} />
    </section>

    {sources.length > 0 && <div className="pdf-tool-sources" aria-label="불러온 PDF">
      {sources.map((source) => <div className="pdf-tool-source" key={source.id}>
        <span className="pdf-tool-source-icon" aria-hidden="true">PDF</span>
        <span className="pdf-tool-source-name" title={source.name}>{source.name}<small>{source.pageCount}페이지 · {prettyBytes(source.file.size)}</small></span>
        <button type="button" className="pdf-tool-icon-button" aria-label={`${source.name} 제거`} title="이 파일의 모든 페이지 제거" disabled={busy} onClick={() => removeSource(source.id)}>×</button>
      </div>)}
    </div>}

    {uploading && <div className="pdf-tool-notice" role="status">{uploading} <button type="button" onClick={() => importAbort.current?.abort()}>추가 취소</button></div>}
    {error && <div className="pdf-tool-notice pdf-tool-notice-error" role="alert">{error}</div>}

    <section className="pdf-tool-editor" aria-label="페이지 편집">
      <div className="pdf-tool-section-head"><div><span className="pdf-tool-eyebrow">01 / PAGE COMPOSITION</span><h3>페이지 순서</h3><p>드래그하거나 페이지의 이동 버튼으로 순서를 바꾸세요.</p></div><div className="pdf-tool-counts" role="status" aria-label={`${pages.length}페이지 중 ${selectedCount}개 선택`}><span className="pdf-tool-badge">페이지 <b>{pages.length}</b></span><span className="pdf-tool-badge">선택 <b>{selectedCount}</b></span></div></div>
      {pages.length === 0 ? <div className="pdf-tool-empty"><div className="pdf-tool-empty-glyph" aria-hidden="true">▤</div><strong>{hadPages ? "내보낼 페이지가 없습니다." : "편집할 페이지가 없습니다"}</strong><span>{hadPages ? "PDF를 다시 추가하면 내보내기를 계속할 수 있습니다." : "PDF를 추가하면 페이지가 여기에 순서대로 표시됩니다."}</span></div> : <>
        <div className="pdf-tool-toolbar">
          <label className="pdf-tool-select-all"><input type="checkbox" checked={pages.every((page) => page.selected)} onChange={(event) => setPages((current) => current.map((page) => ({ ...page, selected: event.target.checked })))} disabled={busy} /> 전체 선택</label>
          <span className="pdf-tool-toolbar-divider" />
          <button type="button" disabled={!selectedCount || busy} onClick={() => { setPages((current) => current.map((page) => page.selected ? { ...page, rotation: normalizeRotation(page.rotation - 90) } : page)); setOutcome(null); }}>↶ 왼쪽 90°</button>
          <button type="button" disabled={!selectedCount || busy} onClick={() => { setPages((current) => current.map((page) => page.selected ? { ...page, rotation: normalizeRotation(page.rotation + 90) } : page)); setOutcome(null); }}>↷ 오른쪽 90°</button>
          <button type="button" className="pdf-tool-delete" disabled={!selectedCount || busy} onClick={removeSelected}>선택 삭제</button>
        </div>
        <div className="pdf-tool-pages">
          {pages.map((page, index) => {
            const source = sourceById.get(page.sourceId);
            if (!source) return null;
            return <article className="pdf-tool-page" data-selected={page.selected} key={page.id} draggable={!busy} onDragStart={(event) => { draggedPage.current = page.id; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", page.id); }} onDragEnd={() => { draggedPage.current = null; }} onDragOver={(event) => { if (draggedPage.current) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={(event) => {
              event.preventDefault(); event.stopPropagation();
              const from = pages.findIndex((item) => item.id === draggedPage.current);
              if (from !== -1) { setPages((current) => movePdfPage(current, current.findIndex((item) => item.id === draggedPage.current), index)); setOutcome(null); }
              draggedPage.current = null;
            }}>
              <div className="pdf-tool-page-top"><span className="pdf-tool-page-number">{String(index + 1).padStart(2, "0")}</span><label><input aria-label={`${index + 1}번 페이지 선택`} type="checkbox" checked={page.selected} disabled={busy} onChange={(event) => setPages((current) => current.map((item) => item.id === page.id ? { ...item, selected: event.target.checked } : item))} /> 선택</label></div>
              <PdfThumbnail source={source} page={page} queue={queueRender} />
              <div className="pdf-tool-page-meta"><strong title={source.name}>{source.name}</strong><span>원본 {page.pageNumber}페이지 {page.rotation ? `· +${page.rotation}°` : ""}</span></div>
              <div className="pdf-tool-page-actions"><button type="button" aria-label={`${index + 1}번 페이지 왼쪽으로 이동`} title="왼쪽으로 이동" disabled={index === 0 || busy} onClick={() => { setPages((current) => movePdfPage(current, index, index - 1)); setOutcome(null); }}>←</button><span>이동</span><button type="button" aria-label={`${index + 1}번 페이지 오른쪽으로 이동`} title="오른쪽으로 이동" disabled={index === pages.length - 1 || busy} onClick={() => { setPages((current) => movePdfPage(current, index, index + 1)); setOutcome(null); }}>→</button></div>
            </article>;
          })}
        </div>
      </>}
    </section>

    <section className="pdf-tool-export" aria-label="페이지 내보내기">
      <div className="pdf-tool-section-head"><div><span className="pdf-tool-eyebrow">02 / EXPORT</span><h3>완성본 저장</h3><p>현재 순서와 회전 상태가 모든 출력 형식에 동일하게 적용됩니다.</p></div></div>
      <div className="pdf-tool-export-grid"><label>저장 형식<select value={format} disabled={busy} onChange={(event) => setFormat(event.target.value as PdfOutputFormat)}><option value="pdf">PDF · 페이지 병합</option><option value="jpg">JPG (JPEG) · 이미지</option><option value="png">PNG · 이미지</option></select></label><label>내보낼 페이지<select value={scope} disabled={busy} onChange={(event) => setScope(event.target.value as "all" | "selected")}><option value="all">전체 페이지 ({pages.length})</option><option value="selected">선택한 페이지 ({selectedCount})</option></select></label></div>
      {format === "pdf" && <>
        <fieldset className="pdf-tool-compression" disabled={busy}>
          <legend>PDF 압축</legend>
          <p className="pdf-tool-compression-help">PDF 파일 크기를 줄이는 방식을 선택합니다. 압축 강도에 따라 화질과 용량이 달라질 수 있습니다.</p>
          {COMPRESSION_LEVELS.map(({ level, label, detail }) => <label key={level}><input type="radio" name="pdf-compression" value={level} checked={compression.level === level} onChange={() => { setCompression((current) => ({ ...current, level })); setOutcome(null); }} /><span><strong>{label}</strong><small>{detail}</small></span></label>)}
        </fieldset>
        <details className="pdf-tool-advanced" open={compression.rasterize || undefined}>
          <summary>고급 옵션</summary>
          <label><input type="checkbox" checked={compression.rasterize} disabled={busy} onChange={(event) => { const rasterize = event.target.checked; setCompression((current) => ({ ...current, rasterize })); setOutcome(null); }} /><span><strong>페이지를 이미지로 변환하여 저장</strong><small>페이지를 이미지로 변환해 저장합니다. 용량을 더 줄일 수 있지만 텍스트 선택·검색, 링크, 양식 정보가 사라집니다.</small></span></label>
        </details>
      </>}
      {format !== "pdf" && <p className="pdf-tool-export-hint">{exportCount > 1 ? "이미지는 번호가 붙은 파일을 ZIP 한 개로 저장합니다." : "한 페이지는 이미지 파일 하나로 저장합니다."} JPG는 흰 배경으로 저장됩니다.</p>}
      <div className="pdf-tool-export-footer"><div className="pdf-tool-export-summary"><strong>{exportCount} 페이지</strong><span>{format.toUpperCase()} {format === "pdf" ? "파일" : exportCount > 1 ? "ZIP 묶음" : "이미지"}으로 저장</span></div><div className="pdf-tool-export-actions">{exporting && <button type="button" className="pdf-tool-button pdf-tool-button-secondary" onClick={() => exportAbort.current?.abort()}>취소</button>}<button type="button" className="pdf-tool-button pdf-tool-button-primary" onClick={() => void download()} disabled={!exportCount || busy}>{exporting || "파일 다운로드"}<span aria-hidden="true">↗</span></button></div></div>
      {outcome && <div className="pdf-tool-outcome" role="status">{outcome.name} 저장 · {prettyBytes(outcome.size)}{outcome.mime === "application/pdf" ? ` · 원본 ${prettyBytes(outcome.inputBytes)} → 결과 ${prettyBytes(outcome.size)}${outcome.size < outcome.inputBytes ? ` · 약 ${Math.round((1 - outcome.size / outcome.inputBytes) * 100)}% 감소` : " · 원본보다 작아지지 않았습니다"}` : ""}</div>}
    </section>
  </div>;
}
