/** Moves the item at `from` to `to` (both final indices); out-of-range or no-op moves return a copy. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return [...items];
  const next = [...items];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

/**
 * Final index for an item dragged from `from` and dropped before/after the item
 * at `target`. Removing the dragged item first shifts later targets down by one.
 */
export function dropIndex(from: number, target: number, placement: "before" | "after"): number {
  const insert = placement === "after" ? target + 1 : target;
  return from < insert ? insert - 1 : insert;
}

export type DropPlacement = "before" | "after";

/** Which side of a target the pointer is on; grids compare x (rows wrap), lists compare y. */
export function placementAt(rect: { left: number; top: number; width: number; height: number }, x: number, y: number, axis: "x" | "y"): DropPlacement {
  const after = axis === "x" ? x > rect.left + rect.width / 2 : y > rect.top + rect.height / 2;
  return after ? "after" : "before";
}

/** Final index for dropping `draggedId` beside `targetId`, or null when nothing would change. */
export function resolveDrop(ids: readonly string[], draggedId: string, targetId: string, placement: DropPlacement): number | null {
  const from = ids.indexOf(draggedId);
  const target = ids.indexOf(targetId);
  if (from === -1 || target === -1) return null;
  const to = dropIndex(from, target, placement);
  return to === from ? null : to;
}

/** One-step keyboard move on a focused grip: earlier for Up/Left, later for Down/Right. */
export function keyStep(key: string): -1 | 0 | 1 {
  if (key === "ArrowUp" || key === "ArrowLeft") return -1;
  if (key === "ArrowDown" || key === "ArrowRight") return 1;
  return 0;
}
