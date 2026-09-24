"use client";

import { ChangeEvent, DragEvent, PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import {
  cropWithinPreview, effectiveCrop, encodeCanvas, encodePdf, fileBase, initialImageEdits,
  MAX_PIXELS, MAX_SIDE, mergeDimensions, outputSize, packageImages, renderImage,
  renderMerged, resetCrop, rotateEdits,
  type ImageEdits, type ImageFormat, type ImageItem, type MergeLayout, type MergeOptions,
  type Rectangle,
} from "@/lib/tools/image-editor";
import { moveItem } from "@/lib/tools/reorder";
import { useReorder } from "./useReorder";
import "./tool-layout.css";
import "./image-tool.css";
import "./reorder.css";

type SelectionMode = "crop" | "mosaic" | null;
type CropRatio = "free" | "1:1" | "4:3" | "16:9";
const RATIOS: Record<Exclude<CropRatio, "free">, number> = { "1:1": 1, "4:3": 4 / 3, "16:9": 16 / 9 };
const QUALITY = { high: 0.92, balanced: 0.72, small: 0.42 } as const;
const QUALITY_LABELS: Record<keyof typeof QUALITY, string> = { high: "고화질", balanced: "균형 (권장)", small: "강력 압축" };
const ACCEPT = /\.(jpe?g|png|webp)$/i;

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "이미지를 처리하지 못했습니다. 다른 파일을 사용해 보세요.";
}

export function ImageTool() {
  const [items, setItems] = useState<ImageItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [mode, setMode] = useState<SelectionMode>(null);
  const [ratio, setRatio] = useState<CropRatio>("free");
  const [drag, setDrag] = useState<Rectangle | null>(null);
  const [aspectLocked, setAspectLocked] = useState(true);
  const [sizeDraft, setSizeDraft] = useState<{ edits: ImageEdits; width: string; height: string } | null>(null);
  const [merge, setMerge] = useState(false);
  const [mergeOptions, setMergeOptions] = useState<MergeOptions>({ layout: "horizontal", gap: 0, background: "#ffffff" });
  const [format, setFormat] = useState<ImageFormat>("jpg");
  const [quality, setQuality] = useState<keyof typeof QUALITY>("balanced");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState("");
  const [notice, setNotice] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);
  const [previewFailure, setPreviewFailure] = useState<{ current: ImageItem; selected: ImageItem[]; merge: boolean; options: MergeOptions; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const busyRef = useRef(false);
  const importingRef = useRef(false);
  const alive = useRef(true);
  const urls = useRef(new Set<string>());
  const timers = useRef(new Set<number | NodeJS.Timeout>());
  const idCounter = useRef(0);
  const fileList = useRef<HTMLDivElement>(null);

  const current = items.find((item) => item.id === currentId) ?? null;
  const selectedItems = useMemo(() => items.filter((item) => selected.includes(item.id)), [items, selected]);
  const mergeActive = merge && selectedItems.length >= 2;
  const dimensions = current ? outputSize(current) : null;
  const mergedDimensions = mergeActive ? mergeDimensions(selectedItems.map(outputSize), mergeOptions) : null;
  const reorder = useReorder({
    ids: items.map((item) => item.id),
    axis: "y",
    disabled: busy,
    scrollContainer: fileList,
    onMove: (from, to) => setItems((list) => moveItem(list, from, to)),
  });
  const widthDraft = sizeDraft && current && sizeDraft.edits === current.edits ? sizeDraft.width : String(dimensions?.width ?? "");
  const heightDraft = sizeDraft && current && sizeDraft.edits === current.edits ? sizeDraft.height : String(dimensions?.height ?? "");
  const previewSize = mergeActive ? mergedDimensions : dimensions;
  const previewError = previewFailure?.current === current && previewFailure.selected === selectedItems &&
    previewFailure.merge === mergeActive && previewFailure.options === mergeOptions ? previewFailure.text : "";

  function setWidthDraft(width: string) {
    if (current) setSizeDraft({ edits: current.edits, width, height: heightDraft });
  }

  function setHeightDraft(height: string) {
    if (current) setSizeDraft({ edits: current.edits, width: widthDraft, height });
  }

  useEffect(() => {
    alive.current = true;
    const activeUrls = urls.current;
    const activeTimers = timers.current;
    return () => {
      importingRef.current = false;
      alive.current = false;
      for (const timeout of activeTimers) clearTimeout(timeout);
      activeTimers.clear();
      for (const url of activeUrls) URL.revokeObjectURL(url);
      activeUrls.clear();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const target = canvasRef.current;
    if (!target || !current) return;
    const draw = async () => {
      const rendered = mergeActive
        ? await renderMerged(selectedItems, mergeOptions, undefined, 1440)
        : await renderImage(current, 1440);
      try {
        if (cancelled) return;
        target.width = rendered.width;
        target.height = rendered.height;
        const context = target.getContext("2d");
        if (!context) throw new Error("미리보기 캔버스를 표시할 수 없습니다.");
        context.drawImage(rendered, 0, 0);
      } finally {
        rendered.width = rendered.height = 0;
      }
    };
    void draw().catch((error: unknown) => {
      if (!cancelled) setPreviewFailure({ current, selected: selectedItems, merge: mergeActive, options: mergeOptions, text: errorMessage(error) });
    });
    return () => { cancelled = true; target.width = target.height = 0; };
  }, [current, mergeActive, selectedItems, mergeOptions]);

  function editCurrent(change: (item: ImageItem) => ImageEdits): void {
    if (!current || busyRef.current) return;
    setItems((list) => list.map((item) => item.id === current.id ? { ...item, edits: change(item) } : item));
    setNotice(null);
  }

  async function addFiles(incoming: FileList | File[]): Promise<void> {
    if (busyRef.current || importingRef.current) return;
    const files = Array.from(incoming);
    if (!files.length) return;
    importingRef.current = true;
    setImporting(true);
    setNotice(null);
    const added: ImageItem[] = [];
    const errors: string[] = [];
    for (const file of files) {
      if (!ACCEPT.test(file.name) || (file.type && !["image/jpeg", "image/png", "image/webp"].includes(file.type))) {
        errors.push(`${file.name}: JPG, PNG, WebP 파일만 사용할 수 있습니다.`);
        continue;
      }
      let bitmap: ImageBitmap | undefined;
      try {
        bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        if (bitmap.width < 1 || bitmap.height < 1) throw new Error("이미지 크기를 읽을 수 없습니다.");
        if (!alive.current) return;
        const thumbnail = URL.createObjectURL(file);
        urls.current.add(thumbnail);
        added.push({
          id: `image-${++idCounter.current}`, file, width: bitmap.width, height: bitmap.height,
          edits: initialImageEdits(), thumbnail,
        });
      } catch (error) { errors.push(`${file.name}: ${errorMessage(error)}`); }
      finally { bitmap?.close(); }
    }
    if (alive.current) {
      if (added.length) {
        setItems((list) => [...list, ...added]);
        setSelected((ids) => [...ids, ...added.map((item) => item.id)]);
        setCurrentId((id) => id ?? added[0].id);
      }
      if (errors.length) setNotice({ tone: "error", text: errors.join(" ") });
      else if (added.length) setNotice({ tone: "info", text: `${added.length}개 이미지를 브라우저 메모리에 불러왔습니다.` });
      setImporting(false);
      importingRef.current = false;
    }
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>): void {
    if (event.target.files) void addFiles(event.target.files);
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files);
  }

  function removeItem(id: string): void {
    if (busyRef.current) return;
    const removed = items.find((item) => item.id === id);
    if (!removed) return;
    urls.current.delete(removed.thumbnail);
    URL.revokeObjectURL(removed.thumbnail);
    const remaining = items.filter((item) => item.id !== id);
    setItems(remaining);
    setSelected((ids) => ids.filter((value) => value !== id));
    if (currentId === id) setCurrentId(remaining[0]?.id ?? null);
    if (selected.filter((value) => value !== id).length < 2) setMerge(false);
  }

  function toggleSelected(id: string): void {
    const next = selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
    setSelected(next);
    if (next.length < 2) setMerge(false);
  }

  function commitDimension(axis: "width" | "height"): void {
    if (!current) return;
    const value = Number(axis === "width" ? widthDraft : heightDraft);
    const size = outputSize(current);
    const crop = effectiveCrop(current);
    const counterpart = aspectLocked ? Math.max(1, Math.round(value * (axis === "width" ? crop.height / crop.width : crop.width / crop.height))) : size[axis === "width" ? "height" : "width"];
    const next = axis === "width" ? { width: value, height: counterpart } : { width: counterpart, height: value };
    if (!Number.isSafeInteger(value) || value < 1 || next.width > MAX_SIDE || next.height > MAX_SIDE || next.width * next.height > MAX_PIXELS) {
      setNotice({ tone: "error", text: `각 변은 1~${MAX_SIDE.toLocaleString()}px, 전체는 80MP 이하로 입력하세요.` });
      setSizeDraft(null);
      return;
    }
    editCurrent((item) => ({ ...item.edits, size: next }));
  }

  function point(event: PointerEvent<HTMLDivElement>): { x: number; y: number } {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  }

  function selectionRectangle(origin: { x: number; y: number }, end: { x: number; y: number }): Rectangle {
    let dx = end.x - origin.x;
    let dy = end.y - origin.y;
    if (mode === "crop" && ratio !== "free" && previewSize) {
      const desired = RATIOS[ratio];
      const roomX = (dx >= 0 ? 1 - origin.x : origin.x) * previewSize.width;
      const roomY = (dy >= 0 ? 1 - origin.y : origin.y) * previewSize.height;
      const width = Math.min(Math.max(Math.abs(dx) * previewSize.width, Math.abs(dy) * previewSize.height * desired), roomX, roomY * desired);
      dx = (Math.sign(dx) || 1) * width / previewSize.width;
      dy = (Math.sign(dy) || 1) * width / desired / previewSize.height;
    }
    return { x: Math.min(origin.x, origin.x + dx), y: Math.min(origin.y, origin.y + dy), width: Math.abs(dx), height: Math.abs(dy) };
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || !mode || !current || mergeActive || busyRef.current || !previewSize) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragOrigin.current = point(event);
    setDrag({ ...dragOrigin.current, width: 0, height: 0 });
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (dragOrigin.current) setDrag(selectionRectangle(dragOrigin.current, point(event)));
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>): void {
    const origin = dragOrigin.current;
    dragOrigin.current = null;
    if (!origin || !current || !previewSize) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const rect = selectionRectangle(origin, point(event));
    setDrag(null);
    if (rect.width * previewSize.width < 3 || rect.height * previewSize.height < 3) return;
    if (mode === "crop") {
      editCurrent((item) => {
        const crop = cropWithinPreview(item, rect);
        const previous = outputSize(item);
        const size = item.edits.size ? {
          width: Math.max(1, Math.round(previous.width * rect.width)),
          height: Math.max(1, Math.round(previous.height * rect.height)),
        } : null;
        const marked = item.edits.mosaic;
        const left = marked ? Math.max(marked.x, rect.x) : 0;
        const top = marked ? Math.max(marked.y, rect.y) : 0;
        const right = marked ? Math.min(marked.x + marked.width, rect.x + rect.width) : 0;
        const bottom = marked ? Math.min(marked.y + marked.height, rect.y + rect.height) : 0;
        const mosaic = marked && right > left && bottom > top ? {
          x: (left - rect.x) / rect.width,
          y: (top - rect.y) / rect.height,
          width: (right - left) / rect.width,
          height: (bottom - top) / rect.height,
        } : null;
        return { ...item.edits, crop, size, mosaic };
      });
    } else if (mode === "mosaic") editCurrent((item) => ({ ...item.edits, mosaic: rect }));
    setMode(null);
  }

  function saveBlob(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    urls.current.add(url);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      urls.current.delete(url);
      timers.current.delete(timer);
    }, 30_000);
    timers.current.add(timer);
  }

  async function exportFiles(): Promise<void> {
    if (busyRef.current || importingRef.current || !selectedItems.length) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const ensureOpen = () => {
        if (!alive.current) throw new DOMException("편집 화면이 닫혔습니다.", "AbortError");
      };
      const sources = selectedItems;
      const total = mergeActive ? 1 : sources.length;
      let result: Blob;
      let name: string;
      if (format === "pdf") {
        const pages = async function* () {
          if (mergeActive) {
            setProgress(`이미지 결합 중 · ${selectedItems.length}개`);
            const image = await renderMerged(selectedItems, mergeOptions, () => ensureOpen());
            if (!alive.current) { image.width = image.height = 0; ensureOpen(); }
            yield image;
          } else {
            for (let index = 0; index < sources.length; index++) {
              ensureOpen();
              setProgress(`PDF 페이지 ${index + 1} / ${total}`);
              const image = await renderImage(sources[index]);
              if (!alive.current) { image.width = image.height = 0; ensureOpen(); }
              yield image;
            }
          }
        };
        result = await encodePdf(pages());
        name = mergeActive ? "merged-images.pdf" : sources.length === 1 ? `${fileBase(sources[0].file.name)}.pdf` : "images.pdf";
      } else {
        const outputs: { name: string; blob: Blob }[] = [];
        if (mergeActive) {
          setProgress(`이미지 결합 중 · ${selectedItems.length}개`);
          const image = await renderMerged(selectedItems, mergeOptions, (done, count) => {
            ensureOpen();
            setProgress(`결합 ${done} / ${count}`);
          });
          try {
            ensureOpen();
            outputs.push({ name: `merged-images.${format}`, blob: await encodeCanvas(image, format, QUALITY[quality]) });
          }
          finally { image.width = image.height = 0; }
        } else {
          for (let index = 0; index < sources.length; index++) {
            ensureOpen();
            setProgress(`변환 ${index + 1} / ${total} · ${sources[index].file.name}`);
            const image = await renderImage(sources[index]);
            try {
              ensureOpen();
              outputs.push({ name: `${fileBase(sources[index].file.name)}.${format}`, blob: await encodeCanvas(image, format, QUALITY[quality]) });
            }
            finally { image.width = image.height = 0; }
          }
        }
        if (outputs.length === 1) {
          result = outputs[0].blob;
          name = outputs[0].name;
        } else {
          setProgress(`${outputs.length}개 파일을 ZIP으로 묶는 중`);
          result = await packageImages(outputs);
          name = `images-${format}.zip`;
        }
      }
      if (alive.current) {
        saveBlob(result, name);
        setNotice({ tone: "success", text: `${name} 다운로드를 시작했습니다. ${formatSize(result.size)} · 브라우저에서만 처리됨` });
      }
    } catch (error) {
      if (alive.current) setNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      busyRef.current = false;
      if (alive.current) { setBusy(false); setProgress(""); }
    }
  }

  return (
    <div className="image-tool" aria-label="이미지 편집 도구">
      <header className="tool-intro image-tool-intro">
        <div><p className="tool-eyebrow">이미지 작업공간</p><h2>이미지 편집</h2><p>크기와 영역을 다듬고, 여러 장을 원하는 순서대로 결합하세요.</p></div>
      </header>
      <div className="image-tool-layout">
        <aside className="image-tool-library" aria-label="이미지 목록">
          <div className="image-tool-section-heading"><div><span>01 / FILES</span><h3>작업 이미지 <small>{items.length}</small></h3></div>{items.length > 0 && <button type="button" onClick={() => fileInput.current?.click()} disabled={busy || importing}>+ 파일 추가</button>}</div>
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" multiple hidden onChange={handleFileInput} aria-label="이미지 파일 선택" />
          {importing && <p className="image-tool-hint" role="status">이미지를 읽는 중…</p>}
          {items.length === 0 ? <p className="image-tool-files-empty">추가된 이미지가 없습니다.</p> : <div ref={fileList} className="image-tool-file-list" onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={handleDrop}>
            <p className="tool-reorder-live" aria-live="polite">{reorder.announcement}</p>
            {items.map((item) => <div key={item.id} className={`image-tool-file tool-reorder-y${item.id === currentId ? " is-current" : ""}`} {...reorder.itemProps(item.id)}>
              <button {...reorder.handleProps(item.id, item.file.name)}><GripVertical aria-hidden="true" /></button>
              <label className="image-tool-file-check" title="내보내기·결합에 포함">
                <input type="checkbox" checked={selected.includes(item.id)} disabled={busy} onChange={() => toggleSelected(item.id)} aria-label={`${item.file.name} 선택`} />
              </label>
              <button className="image-tool-file-open" type="button" onClick={() => { setCurrentId(item.id); setDrag(null); dragOrigin.current = null; }} aria-current={item.id === currentId ? "true" : undefined}>
                {/* eslint-disable-next-line @next/next/no-img-element -- Object URLs are browser-local and unavailable to an image optimizer. */}
                <img src={item.thumbnail} alt="" />
                <span><strong title={item.file.name}>{item.file.name}</strong><small>{item.width} × {item.height} · {formatSize(item.file.size)}</small></span>
              </button>
              <div className="image-tool-order"><button type="button" aria-label={`${item.file.name} 제거`} disabled={busy} onClick={() => removeItem(item.id)}>×</button></div>
            </div>)}
          </div>}
        </aside>
        <main className="image-tool-stage">
          <div className="image-tool-section-heading"><div><span>02 / PREVIEW</span><h3>{mergeActive ? "결합 결과 미리보기" : current ? fileBase(current.file.name) : "미리보기"}</h3></div><span className="image-tool-dimensions">{mergeActive ? `${mergedDimensions?.width} × ${mergedDimensions?.height}px` : dimensions ? `${dimensions.width} × ${dimensions.height}px` : "—"}</span></div>
          <div className="image-tool-preview" onDragOver={(event) => { if (!current && event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={(event) => { if (!current) handleDrop(event); }}>
            {current ? (
              <>
                {previewError && <p role="alert" className="image-tool-preview-error">{previewError}</p>}
                <div className="image-tool-preview-inner">
                  <canvas
                    ref={canvasRef}
                    aria-label={mergeActive ? "결합 이미지 미리보기" : "편집 이미지 미리보기"}
                    style={{ backgroundColor: format === "jpg" ? "#ffffff" : undefined }}
                  />
                  <div
                    className={`image-tool-pointer${mode && !mergeActive ? " is-active" : ""}`}
                    onPointerDown={pointerDown}
                    onPointerMove={pointerMove}
                    onPointerUp={pointerUp}
                    onPointerCancel={() => { dragOrigin.current = null; setDrag(null); }}
                    role={mode && !mergeActive ? "img" : undefined}
                    aria-label={mode === "crop" ? "드래그하여 자를 영역 지정" : mode === "mosaic" ? "드래그하여 모자이크 영역 지정" : undefined}
                  >
                    {drag && <div className="image-tool-selection" style={{ left: `${drag.x * 100}%`, top: `${drag.y * 100}%`, width: `${drag.width * 100}%`, height: `${drag.height * 100}%` }} />}
                    {!drag && !mergeActive && current.edits.mosaic && (
                      <div className="image-tool-selection is-mosaic" style={{ left: `${current.edits.mosaic.x * 100}%`, top: `${current.edits.mosaic.y * 100}%`, width: `${current.edits.mosaic.width * 100}%`, height: `${current.edits.mosaic.height * 100}%` }} />
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="image-tool-empty">
                <strong>이미지를 추가해 편집을 시작하세요</strong>
                <span>한 장씩 편집하거나 여러 이미지를 결합할 수 있습니다.</span>
                <button type="button" onClick={() => fileInput.current?.click()} disabled={importing}>이미지 선택</button>
                <small>또는 이미지를 여기로 끌어오세요</small>
              </div>
            )}
          </div>
          <p className="image-tool-stage-caption">{mode && !mergeActive ? `${mode === "crop" ? "자르기" : "모자이크"} 영역을 이미지 위에서 드래그하세요 · 터치 가능` : mergeActive ? "선택된 이미지의 편집 상태가 순서대로 적용된 결과입니다." : "원본은 유지됩니다. 내보낼 때 편집한 복사본만 생성합니다."}</p>
        </main>
        <aside className="image-tool-controls" aria-label="이미지 편집 설정">
          <div className="image-tool-section-heading"><div><span>03 / ADJUST</span><h3>편집 설정</h3></div></div>
          <fieldset disabled={!current || busy || mergeActive} className="image-tool-fieldset">
            <section className="image-tool-control-section"><h4>크기 · 회전</h4><div className="image-tool-size-grid"><label>너비 px<input type="number" min="1" max={MAX_SIDE} value={widthDraft} onChange={(event) => setWidthDraft(event.target.value)} onBlur={() => commitDimension("width")} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label><label>높이 px<input type="number" min="1" max={MAX_SIDE} value={heightDraft} onChange={(event) => setHeightDraft(event.target.value)} onBlur={() => commitDimension("height")} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label></div><label className="image-tool-check"><input type="checkbox" checked={aspectLocked} onChange={(event) => setAspectLocked(event.target.checked)} /> 비율 유지</label><div className="image-tool-button-row"><button type="button" className="is-edit" onClick={() => editCurrent((item) => rotateEdits(item.edits, item.width, item.height, -1))}>↶ 왼쪽 90°</button><button type="button" className="is-edit" onClick={() => editCurrent((item) => rotateEdits(item.edits, item.width, item.height, 1))}>오른쪽 90° ↷</button></div></section>
            <section className="image-tool-control-section">
              <h4>영역 자르기</h4>
              <label>선택 비율
                <select value={ratio} onChange={(event) => setRatio(event.target.value as CropRatio)}>
                  <option value="free">자유</option>
                  <option value="1:1">1 : 1</option>
                  <option value="4:3">4 : 3</option>
                  <option value="16:9">16 : 9</option>
                </select>
              </label>
              <div className="image-tool-button-row">
                <button type="button" className={mode === "crop" ? "is-edit is-chosen" : "is-edit"} aria-pressed={mode === "crop"} onClick={() => setMode(mode === "crop" ? null : "crop")}>{mode === "crop" ? "영역 선택 중" : "영역 지정"}</button>
                <button type="button" className="is-reset" disabled={!current?.edits.crop} onClick={() => editCurrent(resetCrop)}>자르기 해제</button>
              </div>
            </section>
            <section className="image-tool-control-section"><h4>부분 모자이크</h4><label>블록 크기 <span>{current?.edits.blockSize ?? 12}px</span><input type="range" min="4" max="48" step="2" value={current?.edits.blockSize ?? 12} onChange={(event) => editCurrent((item) => ({ ...item.edits, blockSize: Number(event.target.value) }))} /></label><div className="image-tool-button-row"><button type="button" className={mode === "mosaic" ? "is-edit is-chosen" : "is-edit"} aria-pressed={mode === "mosaic"} onClick={() => setMode(mode === "mosaic" ? null : "mosaic")}>{mode === "mosaic" ? "영역 선택 중" : "영역 지정"}</button><button type="button" className="is-reset" disabled={!current?.edits.mosaic} onClick={() => editCurrent((item) => ({ ...item.edits, mosaic: null }))}>모자이크 해제</button></div></section>
          </fieldset>
          <section className="image-tool-control-section image-tool-merge"><h4>이미지 결합 <small>선택 {selectedItems.length}장</small></h4><label className="image-tool-check"><input type="checkbox" checked={merge} disabled={selectedItems.length < 2 || busy} onChange={(event) => { setMerge(event.target.checked); setMode(null); }} /> 선택 이미지 한 장으로 결합</label>{merge && <div className="image-tool-merge-options"><label>배치<select value={mergeOptions.layout} disabled={busy} onChange={(event) => setMergeOptions((option) => ({ ...option, layout: event.target.value as MergeLayout }))}><option value="horizontal">가로</option><option value="vertical">세로</option><option value="grid">격자</option></select></label><label>간격 px<input type="number" min="0" max="1000" value={mergeOptions.gap} disabled={busy} onChange={(event) => { const gap = Number(event.target.value); if (Number.isSafeInteger(gap) && gap >= 0 && gap <= 1000) setMergeOptions((option) => ({ ...option, gap })); }} /></label><label>배경<input type="color" value={mergeOptions.background} disabled={busy} onChange={(event) => setMergeOptions((option) => ({ ...option, background: event.target.value }))} /></label></div>}</section>
        </aside>
      </div>
      <div className="tool-export image-tool-export">
        <div className="tool-export-title">
          <span>04 / EXPORT</span>
          <strong>결과 내보내기</strong>
          <small>{mergeActive ? "결합 이미지 1개" : `${selectedItems.length}개 선택됨`}</small>
        </div>
        <div className="tool-export-settings">
          <label>형식
            <select value={format} disabled={busy} onChange={(event) => setFormat(event.target.value as ImageFormat)}>
              <option value="jpg">JPG</option><option value="png">PNG</option>
              <option value="webp">WebP</option><option value="pdf">PDF</option>
            </select>
          </label>
          {(format === "jpg" || format === "webp") && (
            <label>품질
              <select value={quality} disabled={busy} onChange={(event) => setQuality(event.target.value as keyof typeof QUALITY)}>
                {(Object.keys(QUALITY) as (keyof typeof QUALITY)[]).map((level) => <option key={level} value={level}>{QUALITY_LABELS[level]}</option>)}
              </select>
            </label>
          )}
          <button className="tool-export-button" type="button" disabled={!selectedItems.length || busy || importing} onClick={() => void exportFiles()}>
            {busy ? "처리 중…" : selectedItems.length > 1 && !mergeActive && format !== "pdf" ? "ZIP 다운로드 ↗" : "파일 다운로드 ↗"}
          </button>
        </div>
        {busy && <p className="image-tool-progress" role="status">{progress || "준비 중…"}</p>}
        {notice && <p className={`image-tool-notice is-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
      </div>
    </div>
  );
}
