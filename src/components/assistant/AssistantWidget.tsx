"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Loader2, Maximize2, MessageCircle, Minimize2, RotateCcw, Send, TriangleAlert, X } from "lucide-react";
import { loadAxState } from "@/client/ax-store";
import { automationLevel, executionGate, GATE_LABELS } from "@/lib/ax/policy";
import { planSummary } from "@/lib/ax/guide";
import "./assistant.css";

interface AssistantSource { screen: string; title: string }
interface AssistantMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  sources?: AssistantSource[];
  error?: string;
  pending?: boolean;
}

const EXAMPLE_QUESTIONS = [
  "자동화 Level은 어떻게 결정되나요?",
  "진행 보류와 확인 후 진행의 차이는?",
  "올인원 지시문은 어떻게 사용하나요?",
] as const;

const MAX_QUESTION_CHARS = 1000;
const ASSISTANT_TIMEOUT_MS = 45_000;

let messageId = 0;
const nextId = () => { messageId += 1; return messageId; };

interface ScreenContext {
  taskName: string;
  levelLabel: string;
  gateLabel: string;
  scopeNote: string;
}

async function readScreenContext(): Promise<ScreenContext | null> {
  try {
    const { state } = await loadAxState();
    const task = state.tasks.find((candidate) => candidate.id === state.selectedTaskId) ?? null;
    const diagnosis = task?.diagnosis;
    if (!task || !diagnosis) return null;
    const level = automationLevel(diagnosis);
    const gate = executionGate(diagnosis);
    const summary = planSummary(diagnosis);
    return {
      taskName: task.name,
      levelLabel: level.label,
      gateLabel: GATE_LABELS[gate],
      scopeNote: `이번 구현 ${summary.include.length}건 · 담당자 수행 유지 ${summary.humanKept.length}건 · 현재 자동화 제외 ${summary.excluded.length}건`,
    };
  } catch {
    return null;
  }
}

async function askAssistant(question: string, context: ScreenContext | null, signal: AbortSignal): Promise<{ answer: string; sources: AssistantSource[] }> {
  const response = await fetch("/api/assistant", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, ...(context ? { context } : {}) }),
    signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = (payload as { error?: { code?: string } } | null)?.error?.code;
    if (code === "AI_RATE_LIMITED") throw new Error("요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
    throw new Error("지금은 응답할 수 없습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.");
  }
  const data = (payload as { data?: { answer?: unknown; sources?: unknown } } | null)?.data;
  if (!data || typeof data.answer !== "string") throw new Error("응답 형식이 올바르지 않습니다. 다시 시도해 주세요.");
  const sources = Array.isArray(data.sources)
    ? data.sources.filter((source): source is AssistantSource =>
      !!source && typeof source === "object" && typeof (source as AssistantSource).screen === "string")
    : [];
  return { answer: data.answer, sources };
}

export function AssistantWidget() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<AssistantMessage[]>([
    { id: nextId(), role: "assistant", text: "안녕하세요! WorkLens AI 도우미입니다. WorkLens의 기능과 사용 방법에 대해 질문해 주세요." },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [useScreenContext, setUseScreenContext] = useState(false);
  const [contextNote, setContextNote] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); setOpen(false); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open ]);

  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (prevOpenRef.current && !open) {
      const frame = requestAnimationFrame(() => fabRef.current?.focus());
      prevOpenRef.current = open;
      return () => cancelAnimationFrame(frame);
    }
    prevOpenRef.current = open;
  }, [open ]);

  useEffect(() => {
    if (open) {
      const frame = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
  }, [open ]);

  const scrollToBottom = useCallback(() => {
    const list = listRef.current;
    if (list && stickToBottomRef.current) list.scrollTop = list.scrollHeight;
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  const send = useCallback(async (rawQuestion: string) => {
    const question = rawQuestion.trim();
    if (!question || loading || question.length > MAX_QUESTION_CHARS) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const timeout = setTimeout(() => controller.abort("timeout"), ASSISTANT_TIMEOUT_MS);
    setMessages((prev) => [...prev, { id: nextId(), role: "user", text: question }, { id: nextId(), role: "assistant", text: "", pending: true }]);
    setInput("");
    setLoading(true);
    try {
      const context = useScreenContext ? await readScreenContext() : null;
      if (useScreenContext) setContextNote(context ? `현재 화면 기준: ${context.taskName}` : "현재 화면 기준: 선택된 진단 업무가 없습니다.");
      const { answer, sources } = await askAssistant(question, context, controller.signal);
      setMessages((prev) => prev.map((message) =>
        message.pending ? { ...message, pending: false, text: answer, sources } : message));
    } catch (error) {
      const cancelled = controller.signal.aborted && (error as Error)?.name === "AbortError";
      const text = cancelled ? "요청이 취소되었습니다." : error instanceof Error ? error.message : "응답할 수 없습니다.";
      setMessages((prev) => prev.map((message) =>
        message.pending ? { ...message, pending: false, text, error: cancelled ? undefined : question } : message));
    } finally {
      clearTimeout(timeout);
      setLoading(false);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [loading, useScreenContext]);

  const retry = useCallback((question: string) => {
    setMessages((prev) => prev.filter((message) => !message.error));
    void send(question);
  }, [send]);

  const clearConversation = useCallback(() => {
    controllerRef.current?.abort();
    setMessages([{ id: nextId(), role: "assistant", text: "대화를 초기화했습니다. WorkLens의 기능과 사용 방법에 대해 질문해 주세요." }]);
    setContextNote(null);
  }, []);

  if (!mounted) return null;
  return createPortal(
    <div className="wl-assistant-root" data-open={open || undefined}>
      {!open ? (
        <button ref={fabRef} type="button" className="wl-assistant-fab" aria-label="AI 도우미 열기" onClick={() => setOpen(true)}>
          <MessageCircle aria-hidden="true" />
        </button>
      ) : (
        <section className="wl-assistant-panel" data-expanded={expanded || undefined} role="dialog" aria-modal="false" aria-label="WorkLens AI 도우미">
          <header className="wl-assistant-header">
            <span className="wl-assistant-logo" aria-hidden="true"><Bot /></span>
            <span className="wl-assistant-titles">
              <strong>WorkLens AI 도우미</strong>
              <small>WorkLens 기능과 사용 방법을 안내합니다.</small>
            </span>
            <span className="wl-assistant-controls">
              <button type="button" aria-label="대화 초기화" title="대화 초기화" onClick={clearConversation}><RotateCcw aria-hidden="true" /></button>
              <button type="button" aria-label={expanded ? "패널 복원" : "패널 확장"} onClick={() => setExpanded((value) => !value)}>
                {expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
              </button>
              <button type="button" aria-label="AI 도우미 최소화" onClick={() => setOpen(false)}><Minimize2 aria-hidden="true" /></button>
              <button type="button" aria-label="AI 도우미 닫기" onClick={() => setOpen(false)}><X aria-hidden="true" /></button>
            </span>
          </header>
          <div className="wl-assistant-context">
            <label className="wl-assistant-toggle">
              <input type="checkbox" checked={useScreenContext} onChange={(event) => { setUseScreenContext(event.target.checked); setContextNote(null); }} />
              <span>현재 화면 기준</span>
            </label>
            {contextNote ? <small className="wl-assistant-context-note">{contextNote}</small> : null}
          </div>
          <div
            ref={listRef}
            className="wl-assistant-messages"
            role="log"
            aria-live="polite"
            aria-label="도우미 대화"
            onScroll={(event) => {
              const target = event.currentTarget;
              stickToBottomRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 40;
            }}
          >
            {messages.map((message) => (
              <div key={message.id} className={`wl-assistant-row${message.role === "user" ? " is-user" : ""}`}>
                {message.role === "assistant" ? <span className="wl-assistant-avatar" aria-hidden="true"><Bot /></span> : null}
                <div className="wl-assistant-bubble">
                  {message.pending
                    ? <span className="wl-assistant-typing" aria-label="답변 작성 중"><Loader2 className="wl-spin" aria-hidden="true" /></span>
                    : <p>{message.text}</p>}
                  {message.sources && message.sources.length ? (
                    <div className="wl-assistant-sources">
                      <strong>참고 근거</strong>
                      <ul>{message.sources.map((source) => <li key={`${source.screen}${source.title}`}>{source.screen} &gt; {source.title}</li>)}</ul>
                    </div>
                  ) : null}
                  {message.error ? (
                    <button type="button" className="wl-assistant-retry" onClick={() => retry(message.error as string)}>
                      <TriangleAlert aria-hidden="true" /> 다시 시도
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          {messages.length <= 2 && !loading ? (
            <div className="wl-assistant-examples" aria-label="예시 질문">
              <strong>예시 질문</strong>
              <div>
                {EXAMPLE_QUESTIONS.map((question) => (
                  <button key={question} type="button" onClick={() => void send(question)}>{question}</button>
                ))}
              </div>
            </div>
          ) : null}
          <form
            className="wl-assistant-input"
            onSubmit={(event) => { event.preventDefault(); void send(input); }}
          >
            <label className="wl-assistant-input-label" htmlFor="wl-assistant-question">질문 입력</label>
            <textarea
              ref={inputRef}
              id="wl-assistant-question"
              rows={1}
              value={input}
              maxLength={MAX_QUESTION_CHARS}
              placeholder="질문을 입력하세요."
              aria-label="질문 입력"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send(input);
                }
              }}
            />
            <button type="submit" aria-label="질문 전송" disabled={loading || !input.trim()}>
              {loading ? <Loader2 className="wl-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
            </button>
          </form>
          <p className="wl-assistant-footnote">WorkLens 기능과 정책에 대한 안내만 제공합니다.</p>
        </section>
      )}
    </div>,
    document.body,
  );
}
