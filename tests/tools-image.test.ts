import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import {
  cropWithinPreview, effectiveCrop, fileBase, initialImageEdits, mergeDimensions, outputSize, packageImages,
  resetCrop, rotateEdits, rotatedSize, type ImageEdits,
} from "../src/lib/tools/image-editor";

describe("image editing geometry", () => {
  it("crops within an existing rotated image without drifting to the origin", () => {
    const edits: ImageEdits = { ...initialImageEdits(), crop: { x: 20, y: 10, width: 60, height: 30 } };
    const result = cropWithinPreview({ width: 200, height: 100, edits }, { x: 0.25, y: 0.2, width: 0.5, height: 0.4 });
    expect(result).toEqual({ x: 35, y: 16, width: 30, height: 12 });
    expect(cropWithinPreview({ width: 200, height: 100, edits: { ...edits, crop: result } }, { x: 0, y: 0, width: 1, height: 1 })).toEqual(result);
  });

  it("rotates a cropped, resized, mosaicked image while keeping the same content region", () => {
    const edits: ImageEdits = {
      rotation: 0, crop: { x: 20, y: 10, width: 60, height: 30 }, size: { width: 120, height: 60 },
      mosaic: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, blockSize: 12,
    };
    const clockwise = rotateEdits(edits, 200, 100, 1);
    expect(clockwise.crop).toEqual({ x: 60, y: 20, width: 30, height: 60 });
    expect(clockwise.size).toEqual({ width: 60, height: 120 });
    expect(clockwise.mosaic).toEqual({ x: 0.4, y: 0.1, width: 0.4, height: 0.3 });
    const restored = rotateEdits(clockwise, 200, 100, -1);
    expect(restored.crop).toEqual(edits.crop);
    expect(restored.size).toEqual(edits.size);
    expect(restored.mosaic?.x).toBeCloseTo(edits.mosaic!.x);
    expect(restored.mosaic?.y).toBeCloseTo(edits.mosaic!.y);
  });

  it("removes a crop without discarding resize scale or a retained mosaic", () => {
    const edits: ImageEdits = {
      rotation: 0, crop: { x: 20, y: 10, width: 60, height: 30 }, size: { width: 120, height: 60 },
      mosaic: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, blockSize: 12,
    };
    const restored = resetCrop({ width: 200, height: 100, edits });
    expect(restored.crop).toBeNull();
    expect(restored.size).toEqual({ width: 400, height: 200 });
    expect(restored.mosaic?.x).toBeCloseTo(0.13);
    expect(restored.mosaic?.y).toBeCloseTo(0.16);
    expect(restored.mosaic?.width).toBeCloseTo(0.09);
    expect(restored.mosaic?.height).toBeCloseTo(0.12);
  });

  it("preserves each selected image's dimensions in horizontal, vertical and grid layouts", () => {
    const sizes = [{ width: 40, height: 30 }, { width: 10, height: 80 }, { width: 25, height: 50 }];
    expect(mergeDimensions(sizes, { layout: "horizontal", gap: 0, background: "#fff" })).toEqual({ width: 75, height: 80 });
    expect(mergeDimensions(sizes, { layout: "vertical", gap: 8, background: "#fff" })).toEqual({ width: 40, height: 176 });
    expect(mergeDimensions(sizes, { layout: "grid", gap: 8, background: "#fff" })).toEqual({ width: 58, height: 138 });
  });
});

describe("multi-image ZIP output", () => {
  it("reopens with real file bytes and distinct duplicate filenames", async () => {
    const output = await packageImages([
      { name: "picture.png", blob: new Blob([Uint8Array.of(137, 80, 78, 71, 1)]) },
      { name: "picture.png", blob: new Blob([Uint8Array.of(137, 80, 78, 71, 2)]) },
    ]);
    const reopened = unzipSync(new Uint8Array(await output.arrayBuffer()));
    expect(Object.keys(reopened).sort()).toEqual(["picture (2).png", "picture.png"]);
    expect(Array.from(reopened["picture.png"])).toEqual([137, 80, 78, 71, 1]);
    expect(Array.from(reopened["picture (2).png"])).toEqual([137, 80, 78, 71, 2]);
  });
});

describe("image edit boundaries", () => {
  it("uses rotated source dimensions until an explicit crop or output size overrides them", () => {
    const edits = { ...initialImageEdits(), rotation: 1 as const };
    const item = { width: 120, height: 80, edits };
    expect(rotatedSize(120, 80, 0)).toEqual({ width: 120, height: 80 });
    expect(rotatedSize(120, 80, 1)).toEqual({ width: 80, height: 120 });
    expect(rotatedSize(120, 80, 2)).toEqual({ width: 120, height: 80 });
    expect(rotatedSize(120, 80, 3)).toEqual({ width: 80, height: 120 });
    expect(effectiveCrop(item)).toEqual({ x: 0, y: 0, width: 80, height: 120 });
    expect(outputSize(item)).toEqual({ width: 80, height: 120 });
    const cropped = { ...item, edits: { ...edits, crop: { x: 10, y: 20, width: 30, height: 40 } } };
    expect(effectiveCrop(cropped)).toEqual({ x: 10, y: 20, width: 30, height: 40 });
    expect(outputSize(cropped)).toEqual({ width: 30, height: 40 });
    expect(outputSize({ ...cropped, edits: { ...cropped.edits, size: { width: 300, height: 240 } } }))
      .toEqual({ width: 300, height: 240 });
  });

  it("rotates crop, output size and mosaic counter-clockwise using the source bounds", () => {
    const edits: ImageEdits = {
      rotation: 0, crop: { x: 20, y: 10, width: 60, height: 30 },
      size: { width: 120, height: 60 }, mosaic: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, blockSize: 12,
    };
    const result = rotateEdits(edits, 200, 100, -1);
    expect(result.rotation).toBe(3);
    expect(result.crop).toEqual({ x: 10, y: 120, width: 30, height: 60 });
    expect(result.size).toEqual({ width: 60, height: 120 });
    expect(result.mosaic?.x).toBeCloseTo(0.2);
    expect(result.mosaic?.y).toBeCloseTo(0.6);
    expect(result.mosaic?.width).toBeCloseTo(0.4);
    expect(result.mosaic?.height).toBeCloseTo(0.3);
    expect(rotateEdits(result, 200, 100, 1).crop).toEqual(edits.crop);
  });

  it("rotates uncropped edits without inventing a crop, size or mosaic", () => {
    const edits = initialImageEdits();
    const counterClockwise = rotateEdits(edits, 200, 100, -1);
    expect(counterClockwise).toEqual({ ...edits, rotation: 3 });
    expect(rotateEdits(counterClockwise, 200, 100, 1)).toEqual(edits);
  });

  it("clamps preview crop to rotated bounds while retaining a nonzero pixel", () => {
    const item = { width: 100, height: 60, edits: { ...initialImageEdits(), rotation: 1 as const } };
    expect(cropWithinPreview(item, { x: 0.5, y: 0.2, width: 0.75, height: 0.9 }))
      .toEqual({ x: 30, y: 20, width: 30, height: 80 });
    expect(cropWithinPreview(item, { x: -0.2, y: -0.1, width: 0, height: 0 }))
      .toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(cropWithinPreview(item, { x: 2, y: 2, width: 0, height: 0 }))
      .toEqual({ x: 59, y: 99, width: 1, height: 1 });
  });

  it("leaves uncropped edit state untouched when resetting crop", () => {
    const edits: ImageEdits = { ...initialImageEdits(), size: { width: 70, height: 50 } };
    expect(resetCrop({ width: 100, height: 60, edits })).toBe(edits);
  });
  it("clears an unresized crop without creating a resize or a mosaic", () => {
    const edits: ImageEdits = { ...initialImageEdits(), crop: { x: 10, y: 5, width: 40, height: 30 } };
    expect(resetCrop({ width: 100, height: 80, edits }))
      .toEqual({ ...edits, crop: null, size: null, mosaic: null });
  });

  it("rejects missing images and gaps outside the integer 0–1000 pixel range", () => {
    const options = { layout: "grid" as const, gap: 0, background: "#fff" };
    expect(() => mergeDimensions([], options)).toThrow("합칠 이미지를 선택하세요.");
    for (const gap of [-1, 1001, 0.5]) {
      expect(() => mergeDimensions([{ width: 20, height: 10 }], { ...options, gap }))
        .toThrow("간격은 0~1000px로 설정하세요.");
    }
    expect(mergeDimensions([{ width: 20, height: 10 }], { ...options, gap: 1000 }))
      .toEqual({ width: 20, height: 10 });
  });

  it("makes safe file basenames from extensions and illegal characters", () => {
    expect(fileBase("report.v2.png")).toBe("report.v2");
    expect(fileBase("a/b\\c.png")).toBe("a_b_c");
    expect(fileBase("a:b?c.png")).toBe("a_b_c");
    expect(fileBase(".png")).toBe("image");
    expect(fileBase("")).toBe("image");
    expect(fileBase("notes")).toBe("notes");
  });
});

describe("ZIP packaging boundaries", () => {
  it("wraps a single output as a readable ZIP entry", async () => {
    const archive = await packageImages([{ name: "only.webp", blob: new Blob([Uint8Array.of(10, 20, 30)]) }]);
    expect(archive.type).toBe("application/zip");
    const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    expect(Object.keys(entries)).toEqual(["only.webp"]);
    expect([...entries["only.webp"]]).toEqual([10, 20, 30]);
  });

  it("keeps three identically named outputs individually readable", async () => {
    const archive = await packageImages([1, 2, 3].map((value) => ({
      name: "same.png", blob: new Blob([Uint8Array.of(value)]),
    })));
    const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual(["same (2).png", "same (3).png", "same.png"]);
    expect([...entries["same.png"]]).toEqual([1]);
    expect([...entries["same (2).png"]]).toEqual([2]);
    expect([...entries["same (3).png"]]).toEqual([3]);
  });
});
