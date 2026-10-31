"use client";
import { useEffect, useRef, useState } from "react";
import { AxStorageConflictError, clearAxState, loadAxState, saveAxState, type AxStorageProtection } from "./ax-store";
import { emptyAxState, type AxStateV2 } from "@/lib/ax/types";
export function useAxState() {
  const [state, setState] = useState<AxStateV2>(emptyAxState);
  const [ready, setReady] = useState(false);
  const [saveStatus, setSaveStatus] = useState("불러오는 중");
  const [loadNotice, setLoadNotice] = useState("");
  const [externalChange, setExternalChange] = useState(false);
  const [storageProtection, setStorageProtection] = useState<AxStorageProtection>("loading");
  const protection = useRef<AxStorageProtection>("loading");
  const revision = useRef<string | undefined>(undefined);
  const tabId = useRef<string | null>(null);
  const broadcast = useRef<BroadcastChannel | null>(null);
  const current = useRef(state), pending = useRef(false), mounted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  function persist(snapshot: AxStateV2, clear = false, explicit = false, retryUnavailable = false): Promise<boolean> {
    const channel = broadcast.current;
    const saved = queue.current.then(async () => {
      const retrying = retryUnavailable && protection.current === "unavailable";
      if (!explicit && protection.current !== "writable" && !retrying) return false;
      try {
        revision.current = clear ? await clearAxState(revision.current, explicit) : await saveAxState(snapshot, revision.current, explicit);
        // A notification received during this write still requires a reload or explicit replacement.
        if (explicit) {
          protection.current = "writable";
          if (mounted.current) { setStorageProtection("writable"); setLoadNotice(""); setExternalChange(false); }
        }
        // A user retry still uses the original revision check. Never unlock a conflict
        // received during the write, or permit automatic retries of unavailable storage.
        if (retrying && protection.current === "unavailable") {
          protection.current = "writable";
          if (mounted.current) { setStorageProtection("writable"); setLoadNotice(""); }
        }
        if (mounted.current && protection.current === "writable" && current.current === snapshot && !pending.current) setSaveStatus("이 브라우저에 저장됨");
        try { channel?.postMessage({ type: "ax-saved", tabId: tabId.current }); }
        catch { /* Notification failures must not change a successful save. */ }
        return protection.current === "writable";
      } catch (error) {
        protection.current = error instanceof AxStorageConflictError ? "conflict" : "unavailable";
        if (mounted.current) {
          setStorageProtection(protection.current);
          if (error instanceof AxStorageConflictError) { setExternalChange(true); setLoadNotice(error.message); }
          else setLoadNotice("브라우저 저장소를 사용할 수 없습니다. 자동 저장을 중단했습니다. 화면에서 계속 작업하고 내보내기로 보관할 수 있습니다.");
          setSaveStatus(error instanceof AxStorageConflictError ? "자동 저장 중단" : "저장 실패");
        }
        return false;
      }
    });
    queue.current = saved.then(() => undefined);
    return saved;
  }
  useEffect(() => {
    if (tabId.current === null) tabId.current = crypto.randomUUID();
    if (typeof BroadcastChannel !== "undefined") {
      try {
        const channel = new BroadcastChannel("worklens-ax-state");
        channel.onmessage = ({ data }) => {
          if (data?.type === "ax-saved" && typeof data.tabId === "string" && data.tabId !== tabId.current) {
            protection.current = "conflict"; setStorageProtection("conflict"); setExternalChange(true); setSaveStatus("자동 저장 중단");
          }
        };
        broadcast.current = channel;
      } catch { /* Keep existing storage behavior if the channel is unavailable. */ }
    }
    mounted.current = true;
    let active = true;
    void loadAxState().then(result => {
      if (!active) return;
      revision.current = result.revision;
      // Do not erase an external-change block received while loading.
      if (protection.current === "loading") protection.current = result.protection;
      setStorageProtection(protection.current);
      current.current = result.state; setState(result.state); setLoadNotice(result.notice ?? ""); setReady(true);
      setSaveStatus(protection.current === "writable" ? "이 브라우저에 저장됨" : "자동 저장 중단");
    }).catch(() => { if (active) {
      protection.current = "unavailable"; setStorageProtection("unavailable");
      setReady(true); setSaveStatus("저장 실패"); setLoadNotice("브라우저 저장소를 사용할 수 없습니다. 자동 저장을 중단했습니다. 화면에서 계속 작업하고 내보내기로 보관할 수 있습니다.");
    } });
    return () => {
      active = false; mounted.current = false; clearTimeout(timer.current);
      if (pending.current) { pending.current = false; void persist(current.current); }
      const channel = broadcast.current;
      broadcast.current = null;
      if (channel) {
        channel.onmessage = null;
        // Flush queued save notifications before closing on unmount.
        void queue.current.then(() => channel.close());
      }
    };
    // The queue and current snapshot are refs; setup runs only once per mount.
  }, []);
  function update(change: AxStateV2 | ((value: AxStateV2) => AxStateV2)) {
    const next = typeof change === "function" ? change(current.current) : change;
    current.current = next; setState(next);
    if (protection.current === "writable") setSaveStatus("저장 중");
    pending.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { pending.current = false; void persist(next); }, 300);
  }
  /** User save: await the same queued, revision-checked persistence used by autosave.
   * Retain local edits on failure; only unavailable storage can be retried without replacement. */
  function updateAndSave(change: AxStateV2 | ((value: AxStateV2) => AxStateV2)): Promise<boolean> {
    update(change);
    clearTimeout(timer.current); pending.current = false;
    if (protection.current === "unavailable") setSaveStatus("저장 중");
    return persist(current.current, false, false, true);
  }
  /** 최신 상태 읽기 (오래된 React 클로저 상태 방지용) */
  function getState(): AxStateV2 {
    return current.current;
  }
  async function replace(next: AxStateV2, clear = false) {
    clearTimeout(timer.current); pending.current = false;
    current.current = next; setState(next); setSaveStatus("저장 중");
    return persist(next, clear, true);
  }
  return { state, update, updateAndSave, getState, replace, ready, saveStatus: ready ? saveStatus : "불러오는 중", loadNotice, externalChange, storageProtection };
}
