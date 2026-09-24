"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { keyStep, placementAt, resolveDrop, type DropPlacement } from "@/lib/tools/reorder";

/** Pointer travel before a press on the grip counts as a drag rather than a click. */
const DRAG_THRESHOLD = 4;
const EDGE = 48;
const SCROLL_STEP = 14;

interface Drop { id: string; placement: DropPlacement }

/**
 * Shared drag-to-reorder for TOOLS lists. Only the grip starts a drag, so checkboxes,
 * rotate/delete and item clicks keep their own behaviour. Pointer events cover mouse,
 * pen and touch; arrow keys on the focused grip move one step. Identity is the item id,
 * never the index, so selection and edits follow the item.
 */
export function useReorder(options: {
  ids: readonly string[];
  /** "x" compares against the horizontal centre (wrapping grids), "y" the vertical one. */
  axis: "x" | "y";
  disabled?: boolean;
  onMove: (from: number, to: number) => void;
  scrollContainer?: React.RefObject<HTMLElement | null>;
}) {
  const { ids, axis, disabled, onMove, scrollContainer } = options;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const gesture = useRef<{ id: string; x: number; y: number; pointerId: number; active: boolean; clientX: number; clientY: number } | null>(null);
  const latest = useRef({ ids, onMove });
  const dropRef = useRef<Drop | null>(null);
  const scrollFrame = useRef<number | null>(null);
  useEffect(() => { latest.current = { ids, onMove }; });
  useEffect(() => () => { if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current); }, []);

  function announce(index: number) {
    setAnnouncement(`${index + 1}번째 위치로 이동했습니다.`);
  }

  function commit(id: string, to: number) {
    const from = latest.current.ids.indexOf(id);
    if (from === -1 || to === from || to < 0 || to >= latest.current.ids.length) return;
    latest.current.onMove(from, to);
    announce(to);
  }

  function autoScroll(clientX: number, clientY: number): boolean {
    let nearEdge = false;
    const box = scrollContainer?.current;
    if (box && box.scrollHeight > box.clientHeight) {
      const rect = box.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        if (clientY < rect.top + EDGE) { box.scrollBy(0, -SCROLL_STEP); nearEdge = true; }
        else if (clientY > rect.bottom - EDGE) { box.scrollBy(0, SCROLL_STEP); nearEdge = true; }
      }
    }
    if (clientY < EDGE) { window.scrollBy(0, -SCROLL_STEP); nearEdge = true; }
    else if (clientY > window.innerHeight - EDGE) { window.scrollBy(0, SCROLL_STEP); nearEdge = true; }
    return nearEdge;
  }

  function updateDrop(clientX: number, clientY: number) {
    let hit = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-reorder-id]");
    const box = scrollContainer?.current;
    if (!hit && box) {
      const rect = box.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        const rows = box.querySelectorAll<HTMLElement>("[data-reorder-id]");
        let distance = Infinity;
        for (const row of rows) {
          const bounds = row.getBoundingClientRect();
          const gap = Math.max(bounds.top - clientY, clientY - bounds.bottom, 0);
          if (gap < distance) { distance = gap; hit = row; }
        }
      }
    }
    const targetId = hit?.dataset.reorderId;
    const next: Drop | null = hit && targetId && latest.current.ids.includes(targetId)
      ? { id: targetId, placement: placementAt(hit.getBoundingClientRect(), clientX, clientY, axis) }
      : null;
    if (dropRef.current?.id === next?.id && dropRef.current?.placement === next?.placement) return;
    dropRef.current = next;
    setDrop(next);
  }

  function scrollWhileDragging() {
    scrollFrame.current = null;
    const state = gesture.current;
    if (!state?.active) return;
    if (autoScroll(state.clientX, state.clientY)) {
      updateDrop(state.clientX, state.clientY);
      scrollFrame.current = requestAnimationFrame(scrollWhileDragging);
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const state = gesture.current;
    if (!state || event.pointerId !== state.pointerId) return;
    state.clientX = event.clientX;
    state.clientY = event.clientY;
    if (!state.active) {
      if (Math.hypot(event.clientX - state.x, event.clientY - state.y) < DRAG_THRESHOLD) return;
      state.active = true;
      setDraggingId(state.id);
    }
    event.preventDefault();
    updateDrop(event.clientX, event.clientY);
    if (scrollFrame.current === null && autoScroll(event.clientX, event.clientY)) {
      scrollFrame.current = requestAnimationFrame(scrollWhileDragging);
    }
  }

  function finish(event: ReactPointerEvent<HTMLElement>, apply: boolean) {
    const state = gesture.current;
    if (!state || event.pointerId !== state.pointerId) return;
    gesture.current = null;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (state.active) updateDrop(event.clientX, event.clientY);
    const target = dropRef.current;
    dropRef.current = null;
    if (apply && state.active && target) {
      const to = resolveDrop(latest.current.ids, state.id, target.id, target.placement);
      if (to !== null) commit(state.id, to);
    }
    setDraggingId(null);
    setDrop(null);
  }

  function handleProps(id: string, label: string) {
    return {
      type: "button" as const,
      className: "tool-reorder-handle",
      "aria-label": `${label} 순서 변경`,
      title: "끌어서 순서 변경 · 방향키로 이동",
      disabled,
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (disabled || (event.pointerType === "mouse" && event.button !== 0)) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        gesture.current = { id, x: event.clientX, y: event.clientY, clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId, active: false };
      },
      onPointerMove,
      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => finish(event, true),
      onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => finish(event, false),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        const step = keyStep(event.key);
        if (!step || disabled) return;
        event.preventDefault();
        const handle = event.currentTarget;
        commit(id, latest.current.ids.indexOf(id) + step);
        // The same grip keeps focus after React re-orders the list.
        requestAnimationFrame(() => handle.focus());
      },
    };
  }

  function itemProps(id: string) {
    return {
      "data-reorder-id": id,
      "data-dragging": draggingId === id || undefined,
      "data-drop": drop?.id === id && draggingId !== id ? drop.placement : undefined,
    };
  }

  return { handleProps, itemProps, announcement, dragging: draggingId !== null };
}
