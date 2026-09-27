import { zipSync } from "fflate";
import { PDFDocument } from "pdf-lib";

export type ImageFormat = "jpg" | "png" | "webp" | "pdf";
/** Cells per image count: 2 → horizontal | vertical, 3 → top-two | top-one, 4+ → grid. */
export type MergeLayout = "horizontal" | "vertical" | "top-two" | "top-one" | "grid";
export type MergeRatio = "1:1" | "4:3" | "16:9";
export type Rectangle = { x: number; y: number; width: number; height: number };
export type ImageEdits = {
  rotation: 0 | 1 | 2 | 3;
  crop: Rectangle | null;
  size: { width: number; height: number } | null;
  mosaic: Rectangle | null; // Relative to the final, resized image (0–1).
  blurRadius: number;
};
export type ImageItem = {
  id: string;
  file: File;
  width: number;
  height: number;
  edits: ImageEdits;
  thumbnail: string;
};
export type MergeOptions = { layout: MergeLayout; ratio: MergeRatio };
export const MERGE_RATIOS: readonly MergeRatio[] = ["1:1", "4:3", "16:9"];
export const MERGE_LAYOUT_LABELS: Record<MergeLayout, string> = {
  horizontal: "좌우", vertical: "상하", "top-two": "위 2 · 아래 1", "top-one": "위 1 · 아래 2", grid: "2×2",
};
export type ImageOutput = { name: string; blob: Blob };

export const initialImageEdits = (): ImageEdits => ({ rotation: 0, crop: null, size: null, mosaic: null, blurRadius: 12 });
export const MAX_SIDE = 16384;
export const MAX_PIXELS = 80_000_000;
const MIME: Record<Exclude<ImageFormat, "pdf">, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

export function rotatedSize(width: number, height: number, rotation: number) {
  return rotation % 2 ? { width: height, height: width } : { width, height };
}

export function effectiveCrop(item: Pick<ImageItem, "width" | "height" | "edits">): Rectangle {
  const dimensions = rotatedSize(item.width, item.height, item.edits.rotation);
  return item.edits.crop ?? { x: 0, y: 0, ...dimensions };
}

export function outputSize(item: Pick<ImageItem, "width" | "height" | "edits">) {
  const crop = effectiveCrop(item);
  return item.edits.size ?? { width: crop.width, height: crop.height };
}

export function rotateEdits(edits: ImageEdits, sourceWidth: number, sourceHeight: number, direction: -1 | 1): ImageEdits {
  const previous = rotatedSize(sourceWidth, sourceHeight, edits.rotation);
  const crop = edits.crop;
  const nextCrop = crop ? direction === 1
    ? { x: previous.height - crop.y - crop.height, y: crop.x, width: crop.height, height: crop.width }
    : { x: crop.y, y: previous.width - crop.x - crop.width, width: crop.height, height: crop.width }
    : null;
  return {
    ...edits,
    rotation: ((edits.rotation + direction + 4) % 4) as ImageEdits["rotation"],
    crop: nextCrop,
    size: edits.size ? { width: edits.size.height, height: edits.size.width } : null,
    mosaic: edits.mosaic ? {
      x: direction === 1 ? 1 - edits.mosaic.y - edits.mosaic.height : edits.mosaic.y,
      y: direction === 1 ? edits.mosaic.x : 1 - edits.mosaic.x - edits.mosaic.width,
      width: edits.mosaic.height,
      height: edits.mosaic.width,
    } : null,
  };
}

export function cropWithinPreview(item: Pick<ImageItem, "width" | "height" | "edits">, region: Rectangle): Rectangle {
  const base = effectiveCrop(item);
  const left = Math.max(0, Math.min(base.width - 1, Math.round(region.x * base.width)));
  const top = Math.max(0, Math.min(base.height - 1, Math.round(region.y * base.height)));
  const right = Math.min(base.width, Math.max(left + 1, Math.round((region.x + region.width) * base.width)));
  const bottom = Math.min(base.height, Math.max(top + 1, Math.round((region.y + region.height) * base.height)));
  return { x: base.x + left, y: base.y + top, width: right - left, height: bottom - top };
}

export function resetCrop(item: Pick<ImageItem, "width" | "height" | "edits">): ImageEdits {
  const crop = item.edits.crop;
  if (!crop) return item.edits;
  const full = rotatedSize(item.width, item.height, item.edits.rotation);
  const size = item.edits.size ? {
    width: Math.max(1, Math.round(item.edits.size.width * full.width / crop.width)),
    height: Math.max(1, Math.round(item.edits.size.height * full.height / crop.height)),
  } : null;
  const marked = item.edits.mosaic;
  const mosaic = marked ? {
    x: (crop.x + marked.x * crop.width) / full.width,
    y: (crop.y + marked.y * crop.height) / full.height,
    width: marked.width * crop.width / full.width,
    height: marked.height * crop.height / full.height,
  } : null;
  return { ...item.edits, crop: null, size, mosaic };
}

function assertCanvasDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new Error(`출력 크기는 각 변 ${MAX_SIDE.toLocaleString()}px, 총 ${(MAX_PIXELS / 1_000_000).toFixed(0)}MP 이하로 설정하세요.`);
  }
}

function canvas(width: number, height: number): HTMLCanvasElement {
  assertCanvasDimensions(width, height);
  const result = document.createElement("canvas");
  result.width = width;
  result.height = height;
  return result;
}

function context(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = target.getContext("2d", { willReadFrequently: false });
  if (!ctx) throw new Error("이 브라우저에서는 이미지 캔버스를 만들 수 없습니다.");
  return ctx;
}

function blurRegion(target: HTMLCanvasElement, region: Rectangle, radius: number): void {
  const x = Math.max(0, Math.floor(region.x * target.width));
  const y = Math.max(0, Math.floor(region.y * target.height));
  const right = Math.min(target.width, Math.ceil((region.x + region.width) * target.width));
  const bottom = Math.min(target.height, Math.ceil((region.y + region.height) * target.height));
  if (!Number.isFinite(radius) || radius <= 0) throw new Error("모자이크 강도를 확인하세요.");
  if (right <= x || bottom <= y) return;
  // Read a padded source so the blur sees pixels outside the selection, while
  // clipping writes strictly to the selected rectangle.
  const padding = Math.ceil(radius * 3);
  const left = Math.max(0, x - padding);
  const top = Math.max(0, y - padding);
  const sourceRight = Math.min(target.width, right + padding);
  const sourceBottom = Math.min(target.height, bottom + padding);
  const tile = canvas(sourceRight - left, sourceBottom - top);
  try {
    context(tile).drawImage(target, left, top, tile.width, tile.height, 0, 0, tile.width, tile.height);
    const ctx = context(target);
    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(x, y, right - x, bottom - y);
      ctx.clip();
      ctx.filter = `blur(${radius}px)`;
      ctx.drawImage(tile, left, top);
    } finally {
      ctx.restore();
    }
  } finally {
    tile.width = tile.height = 0;
  }
}

// Rendering is intentionally stateless: each invocation decodes the original, draws the
// complete edit chain once, then closes the bitmap. Preview and export use this same path.
export async function renderImage(item: ImageItem, maxEdge = Infinity): Promise<HTMLCanvasElement> {
  const { width, height } = outputSize(item);
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const target = canvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(item.file, { imageOrientation: "from-image" });
    const crop = effectiveCrop(item);
    const sx = target.width / crop.width;
    const sy = target.height / crop.height;
    const ctx = context(target);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    switch (item.edits.rotation) {
      case 0: ctx.setTransform(sx, 0, 0, sy, -crop.x * sx, -crop.y * sy); break;
      case 1: ctx.setTransform(0, sy, -sx, 0, (item.height - crop.x) * sx, -crop.y * sy); break;
      case 2: ctx.setTransform(-sx, 0, 0, -sy, (item.width - crop.x) * sx, (item.height - crop.y) * sy); break;
      case 3: ctx.setTransform(0, -sy, sx, 0, -crop.x * sx, (item.width - crop.y) * sy); break;
    }
    ctx.drawImage(bitmap, 0, 0);
    ctx.resetTransform();
    if (item.edits.mosaic) blurRegion(target, item.edits.mosaic, Math.max(0.1, item.edits.blurRadius * scale));
    return target;
  } catch (error) {
    target.width = target.height = 0;
    throw error;
  } finally {
    bitmap?.close();
  }
}

/** The layouts offered for a given number of selected images; the first is the default. */
export function mergeLayoutsFor(count: number): MergeLayout[] {
  if (count === 2) return ["horizontal", "vertical"];
  if (count === 3) return ["top-two", "top-one"];
  return ["grid"];
}

type Cell = { x: number; y: number; width: number; height: number };

/** Cells as fractions of the canvas, in list order. Gap is always 0 and every cell is filled. */
export function mergeCells(count: number, layout: MergeLayout): Cell[] {
  const valid = mergeLayoutsFor(count).includes(layout) ? layout : mergeLayoutsFor(count)[0];
  if (valid === "horizontal") return [{ x: 0, y: 0, width: 0.5, height: 1 }, { x: 0.5, y: 0, width: 0.5, height: 1 }];
  if (valid === "vertical") return [{ x: 0, y: 0, width: 1, height: 0.5 }, { x: 0, y: 0.5, width: 1, height: 0.5 }];
  if (valid === "top-two") return [{ x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0, width: 0.5, height: 0.5 }, { x: 0, y: 0.5, width: 1, height: 0.5 }];
  if (valid === "top-one") return [{ x: 0, y: 0, width: 1, height: 0.5 }, { x: 0, y: 0.5, width: 0.5, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }];
  // Grid (4 → 2×2; more images keep the square-ish grid, a short last row spans the full width).
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns);
    const inRow = row === rows - 1 ? count - row * columns : columns;
    const col = index - row * columns;
    return { x: col / inRow, y: row / rows, width: 1 / inRow, height: 1 / rows };
  });
}

/** Canvas size at the chosen ratio, scaled from source dimensions and bounded by browser canvas limits. */
export function mergeDimensions(sizes: readonly { width: number; height: number }[], options: MergeOptions) {
  if (sizes.length < 2) throw new Error("합칠 이미지를 두 장 이상 선택하세요.");
  const [rw, rh] = options.ratio.split(":").map(Number);
  const cells = mergeCells(sizes.length, options.layout);
  let width = 1;
  for (const [index, cell] of cells.entries()) {
    width = Math.max(width, sizes[index].width / cell.width, (sizes[index].height / cell.height) * (rw / rh));
  }
  const limit = Math.min(1, MAX_SIDE / Math.max(width, (width * rh) / rw), Math.sqrt(MAX_PIXELS / ((width * width * rh) / rw)));
  width = Math.max(1, Math.floor(width * limit));
  let height = Math.max(1, Math.round((width * rh) / rw));
  while (height > MAX_SIDE || width * height > MAX_PIXELS) {
    width--;
    height = Math.max(1, Math.round((width * rh) / rw));
  }
  return { width, height };
}

export async function renderMerged(items: readonly ImageItem[], options: MergeOptions, onProgress?: (done: number, total: number) => void, maxEdge = Infinity): Promise<HTMLCanvasElement> {
  const dimensions = mergeDimensions(items.map(outputSize), options);
  const scale = Math.min(1, maxEdge / Math.max(dimensions.width, dimensions.height));
  const target = canvas(Math.max(1, Math.round(dimensions.width * scale)), Math.max(1, Math.round(dimensions.height * scale)));
  try {
    const ctx = context(target);
    const cells = mergeCells(items.length, options.layout);
    for (let index = 0; index < items.length; index++) {
      // Integer cell edges from shared fractions: neighbours meet exactly, no seams or overlap.
      const cell = cells[index];
      const x0 = Math.round(cell.x * target.width);
      const y0 = Math.round(cell.y * target.height);
      const w = Math.round((cell.x + cell.width) * target.width) - x0;
      const h = Math.round((cell.y + cell.height) * target.height) - y0;
      const size = outputSize(items[index]);
      const image = await renderImage(items[index], Math.max(size.width, size.height) * scale);
      try {
        // Cover: scale to fill the cell, centre-crop the overflow; never stretched.
        const fit = Math.max(w / image.width, h / image.height);
        const sw = w / fit;
        const sh = h / fit;
        ctx.drawImage(image, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, x0, y0, w, h);
      } finally { image.width = image.height = 0; }
      onProgress?.(index + 1, items.length);
    }
    return target;
  } catch (error) {
    target.width = target.height = 0;
    throw error;
  }
}

export function encodeCanvas(source: HTMLCanvasElement, format: Exclude<ImageFormat, "pdf">, quality: number): Promise<Blob> {
  if (format === "jpg") {
    const ctx = context(source);
    ctx.save();
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, source.width, source.height);
    ctx.restore();
  }
  const { promise, resolve, reject } = Promise.withResolvers<Blob>();
  source.toBlob((blob) => {
    if (!blob || blob.type !== MIME[format]) reject(new Error(`${format.toUpperCase()} 형식으로 저장할 수 없는 브라우저입니다.`));
    else resolve(blob);
  }, MIME[format], format === "png" ? undefined : quality);
  return promise;
}

export async function encodePdf(canvases: AsyncIterable<HTMLCanvasElement>): Promise<Blob> {
  const doc = await PDFDocument.create();
  for await (const source of canvases) {
    try {
      const blob = await encodeCanvas(source, "png", 1);
      const image = await doc.embedPng(await blob.arrayBuffer());
      // PDF points have a practical page limit; scale uniformly, never deform an image.
      const scale = Math.min(1, 1440 / Math.max(source.width, source.height));
      const width = source.width * scale;
      const height = source.height * scale;
      doc.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
    } finally {
      source.width = source.height = 0;
    }
  }
  const bytes = await doc.save();
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
}

export function fileBase(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_") || "image";
}


export async function packageImages(outputs: readonly ImageOutput[]): Promise<Blob> {
  const used = new Set<string>();
  const files: Record<string, Uint8Array> = {};
  for (const output of outputs) {
    const dot = output.name.lastIndexOf(".");
    let name = output.name;
    let suffix = 2;
    while (used.has(name)) {
      name = `${output.name.slice(0, dot)} (${suffix++})${output.name.slice(dot)}`;
    }
    used.add(name);
    files[name] = new Uint8Array(await output.blob.arrayBuffer());
  }
  return new Blob([zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}
