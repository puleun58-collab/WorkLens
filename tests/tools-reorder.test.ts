import { describe, expect, it } from "vitest";
import { dropIndex, keyStep, moveItem, placementAt, resolveDrop } from "@/lib/tools/reorder";

const ABCD = ["A", "B", "C", "D"];

function dropOn(items: readonly string[], dragged: string, target: string, placement: "before" | "after") {
  const from = items.indexOf(dragged);
  return moveItem(items, from, dropIndex(from, items.indexOf(target), placement));
}

describe("drag reorder", () => {
  it("moves a later item to the front and an early item to the end", () => {
    expect(dropOn(ABCD, "C", "A", "before")).toEqual(["C", "A", "B", "D"]);
    expect(dropOn(ABCD, "A", "D", "after")).toEqual(["B", "C", "D", "A"]);
  });

  it("accounts for the removed item when dropping forward between neighbours", () => {
    // FIRST SECOND THIRD FOURTH → FOURTH dropped after FIRST.
    expect(dropOn(["1", "2", "3", "4"], "4", "1", "after")).toEqual(["1", "4", "2", "3"]);
    expect(dropOn(ABCD, "A", "C", "before")).toEqual(["B", "A", "C", "D"]);
  });

  it("leaves the order unchanged for drops on the item itself or its own gap", () => {
    expect(dropOn(ABCD, "B", "B", "before")).toEqual(ABCD);
    expect(dropOn(ABCD, "B", "B", "after")).toEqual(ABCD);
    expect(dropOn(ABCD, "B", "C", "before")).toEqual(ABCD);
    expect(dropOn(ABCD, "B", "A", "after")).toEqual(ABCD);
  });

  it("returns a fresh unchanged copy for out-of-range moves and never mutates the input", () => {
    for (const [from, to] of [[-1, 1], [4, 1], [1, -1], [1, 4]]) {
      const result = moveItem(ABCD, from, to);
      expect(result).toEqual(ABCD);
      expect(result).not.toBe(ABCD);
    }
    expect(ABCD).toEqual(["A", "B", "C", "D"]);
  });
});

describe("drag gesture helpers", () => {
  const rect = { left: 100, top: 200, width: 100, height: 40 };

  it("splits a wrapping grid by x and a list by y", () => {
    expect(placementAt(rect, 120, 239, "x")).toBe("before");
    expect(placementAt(rect, 180, 201, "x")).toBe("after");
    expect(placementAt(rect, 199, 210, "y")).toBe("before");
    expect(placementAt(rect, 101, 230, "y")).toBe("after");
  });

  it("resolves a drop to a final index and reports no-ops and unknown ids as null", () => {
    expect(resolveDrop(ABCD, "D", "A", "after")).toBe(1);
    expect(resolveDrop(ABCD, "A", "D", "after")).toBe(3);
    expect(resolveDrop(ABCD, "B", "C", "before")).toBeNull();
    expect(resolveDrop(ABCD, "X", "A", "before")).toBeNull();
    expect(resolveDrop(ABCD, "A", "X", "before")).toBeNull();
  });

  it("maps arrow keys to one step and ignores everything else", () => {
    expect([keyStep("ArrowUp"), keyStep("ArrowLeft"), keyStep("ArrowDown"), keyStep("ArrowRight"), keyStep("Enter")]).toEqual([-1, -1, 1, 1, 0]);
  });
});
