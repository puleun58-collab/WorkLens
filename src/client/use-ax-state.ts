"use client";
import { useEffect, useRef, useState } from "react";
import { clearAxState, loadAxState, saveAxState } from "./ax-store";
import { emptyAxState, type AxState } from "@/lib/ax/types";
export function useAxState() {
  const [state, setState] = useState<AxState>(emptyAxState);
  const [ready, setReady] = useState(false);
  const [saveStatus, setSaveStatus] = useState("불러오는 중");
  const [loadNotice, setLoadNotice] = useState("");
  const [externalChange, setExternalChange] = useState(false);
  const tabId = useRef<string | null>(null);
  const broadcast = useRef<BroadcastChannel | null>(null);
  const current = useRef(state), pending = useRef(false), mounted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  function persist(snapshot: AxState, clear = false): Promise<boolean> {
    const channel = broadcast.current;
    const saved = queue.current.then(async () => {
      try {
        if (clear) await clearAxState(); else await saveAxState(snapshot);
        if (mounted.current && current.current === snapshot && !pending.current) setSaveStatus("이 브라우저에 저장됨");
        try { channel?.postMessage({ type: "ax-saved", tabId: tabId.current }); }
        catch { /* Notification failures must not change a successful save. */ }
        return true;
      } catch {
        if (mounted.current && current.current === snapshot && !pending.current) setSaveStatus("저장 실패");
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
          if (data?.type === "ax-saved" && typeof data.tabId === "string" && data.tabId !== tabId.current) setExternalChange(true);
        };
        broadcast.current = channel;
      } catch { /* Keep existing storage behavior if the channel is unavailable. */ }
    }
    mounted.current = true;
    let active = true;
    void loadAxState().then(result => {
      if (!active) return;
      current.current = result.state; setState(result.state); setLoadNotice(result.notice ?? ""); setReady(true); setSaveStatus("이 브라우저에 저장됨");
      if (result.notice) void saveAxState(result.state).catch(() => { if (active) setSaveStatus("저장 실패"); });
    }).catch(() => { if (active) { setReady(true); setSaveStatus("저장 실패"); setLoadNotice("브라우저 저장소를 사용할 수 없습니다. 화면에서 계속 작업하고 내보내기로 보관할 수 있습니다."); } });
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
  function update(change: AxState | ((value: AxState) => AxState)) {
    const next = typeof change === "function" ? change(current.current) : change;
    current.current = next; setState(next); setSaveStatus("저장 중"); pending.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { pending.current = false; void persist(next); }, 300);
  }
  async function replace(next: AxState, clear = false) {
    clearTimeout(timer.current); pending.current = false;
    current.current = next; setState(next); setSaveStatus("저장 중");
    return persist(next, clear);
  }
  return { state, update, replace, ready, saveStatus: ready ? saveStatus : "불러오는 중", loadNotice, externalChange };
}
