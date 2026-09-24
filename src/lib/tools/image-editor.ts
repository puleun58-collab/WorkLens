import { zipSync } from "fflate";
import { PDFDocument } from "pdf-lib";

export type ImageFormat = "jpg" | "png" | "webp" | "pdf";
export type MergeLayout = "horizontal" | "vertical" | "grid";
export type Rectangle = { x: number; y: number; width: number; height: number };
export type ImageEdits = {
  rotation: 0 | 1 | 2 | 3;
  crop: Rectangle | null;
  size: { width: number; height: number } | null;
  mosaic: Rectangle | null; // Relative to the final, resized image (0–1).
  blockSize: number;
};
export type ImageItem = {
  id: string;
  file: File;
  width: number;
  height: number;
  edits: ImageEdits;
  thumbnail: string;
};
export type MergeOptions = { layout: MergeLayout; gap: number; background: string };
export type ImageOutput = { name: string; blob: Blob };

export const initialImageEdits = (): ImageEdits => ({ rotation: 0, crop: null, size: null, mosaic: null, blockSize: 12 });
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

export function mosaicRegion(target: HTMLCanvasElement, region: Rectangle, blockSize: number): void {
  const x = Math.max(0, Math.floor(region.x * target.width));
  const y = Math.max(0, Math.floor(region.y * target.height));
  const right = Math.min(target.width, Math.ceil((region.x + region.width) * target.width));
  const bottom = Math.min(target.height, Math.ceil((region.y + region.height) * target.height));
  const width = right - x;
  const height = bottom - y;
  if (!Number.isSafeInteger(blockSize) || blockSize < 1) throw new Error("모자이크 블록 크기를 확인하세요.");
  if (width < 1 || height < 1) return;
  const tile = canvas(Math.ceil(width / blockSize), Math.ceil(height / blockSize));
  try {
    const tileContext = context(tile);
    tileContext.imageSmoothingEnabled = true;
    tileContext.drawImage(target, x, y, width, height, 0, 0, tile.width, tile.height);
    const ctx = context(target);
    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.clip();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tile, x, y, width, height);
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
    if (item.edits.mosaic) mosaicRegion(target, item.edits.mosaic, Math.max(1, Math.round(item.edits.blockSize * scale)));
    return target;
  } catch (error) {
    target.width = target.height = 0;
    throw error;
  } finally {
    bitmap?.close();
  }
}

export function mergeDimensions(sizes: readonly { width: number; height: number }[], options: MergeOptions) {
  if (sizes.length === 0) throw new Error("합칠 이미지를 선택하세요.");
  const gap = options.gap;
  if (!Number.isSafeInteger(gap) || gap < 0 || gap > 1000) throw new Error("간격은 0~1000px로 설정하세요.");
  if (options.layout === "horizontal") {
    return { width: sizes.reduce((sum, size) => sum + size.width, 0) + gap * (sizes.length - 1), height: Math.max(...sizes.map((size) => size.height)) };
  }
  if (options.layout === "vertical") {
    return { width: Math.max(...sizes.map((size) => size.width)), height: sizes.reduce((sum, size) => sum + size.height, 0) + gap * (sizes.length - 1) };
  }
  const columns = Math.ceil(Math.sqrt(sizes.length));
  const rows = Math.ceil(sizes.length / columns);
  const columnWidths = Array.from({ length: columns }, (_, column) => Math.max(...sizes.filter((_, index) => index % columns === column).map((size) => size.width)));
  const rowHeights = Array.from({ length: rows }, (_, row) => Math.max(...sizes.slice(row * columns, (row + 1) * columns).map((size) => size.height)));
  return { width: columnWidths.reduce((sum, value) => sum + value, 0) + gap * (columns - 1), height: rowHeights.reduce((sum, value) => sum + value, 0) + gap * (rows - 1) };
}

export async function renderMerged(items: readonly ImageItem[], options: MergeOptions, onProgress?: (done: number, total: number) => void, maxEdge = Infinity): Promise<HTMLCanvasElement> {
  const sizes = items.map(outputSize);
  const dimensions = mergeDimensions(sizes, options);
  const scale = Math.min(1, maxEdge / Math.max(dimensions.width, dimensions.height));
  const target = canvas(Math.max(1, Math.round(dimensions.width * scale)), Math.max(1, Math.round(dimensions.height * scale)));
  try {
    const ctx = context(target);
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, target.width, target.height);
    const columns = Math.ceil(Math.sqrt(items.length));
    const columnWidths = options.layout === "grid" ? Array.from({ length: columns }, (_, column) => Math.max(...sizes.filter((_, index) => index % columns === column).map((size) => size.width))) : [];
    const rowHeights = options.layout === "grid" ? Array.from({ length: Math.ceil(items.length / columns) }, (_, row) => Math.max(...sizes.slice(row * columns, (row + 1) * columns).map((size) => size.height))) : [];
    let x = 0;
    let y = 0;
    for (let index = 0; index < items.length; index++) {
      if (options.layout === "grid") {
        const col = index % columns;
        const row = Math.floor(index / columns);
        x = columnWidths.slice(0, col).reduce((sum, value) => sum + value + options.gap, 0);
        y = rowHeights.slice(0, row).reduce((sum, value) => sum + value + options.gap, 0);
      }
      const size = sizes[index];
      const image = await renderImage(items[index], Math.max(size.width, size.height) * scale);
      try { ctx.drawImage(image, x * scale, y * scale, size.width * scale, size.height * scale); }
      finally { image.width = image.height = 0; }
      onProgress?.(index + 1, items.length);
      if (options.layout === "horizontal") x += sizes[index].width + options.gap;
      if (options.layout === "vertical") y += sizes[index].height + options.gap;
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
