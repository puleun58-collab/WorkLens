import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import {
  cropWithinPreview, initialImageEdits, mergeDimensions, packageImages, resetCrop, rotateEdits,
  type ImageEdits,
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
