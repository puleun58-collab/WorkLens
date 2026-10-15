"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Loader2, Maximize2, Minimize2, RotateCcw, Send, TriangleAlert, X } from "lucide-react";
import { loadAxState } from "@/client/ax-store";
import { automationLevel, executionGate, GATE_LABELS } from "@/lib/ax/policy";
import { planSummary } from "@/lib/ax/guide";
import "./assistant.css";

const MASCOT_SRC = "/brand/wl-assistant-mascot.png";

interface AssistantSource { screen: string; title: string; kind?: "evidence" | "screen" }
interface AssistantMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  sources?: AssistantSource[];
  relatedScreens?: AssistantSource[];
  error?: string;
  pending?: boolean;
  greeting?: boolean;
  /** Set on assistant messages that ask the user to pick a clarification option. */
  clarify?: { clarifyId: string; originalQuestion: string; options: string[] };
  /** Set on assistant messages that ask for task-data consent. */
  consent?: { question: string };
}

/** Remove duplicated trailing path segments: "A > B > B" → "A > B". */
export function dedupeScreenPath(screen: string, title: string): string {
  const full = `${screen} > ${title}`;
  const parts = full.split(" > ").map((part) => part.trim()).filter(Boolean);
  const deduped: string[] = [];
  for (const part of parts) {
    const last = deduped[deduped.length - 1];
    // Drop only exact duplicates; a title like "B 위치" after "B" is informative, not redundant.
    if (last && part === last) continue;
    deduped.push(part);
  }
  return deduped.join(" > ");
}

/** Mascot image with accessible icon fallback when the image fails to load. */
function Mascot({ size, label }: { size: number; label: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="wl-assistant-mascot-fallback" style={{ width: size, height: size }} aria-hidden="true">
        <Bot />
      </span>
    );
  }
  return (
    <img
      src={MASCOT_SRC}
      alt=""
      width={size}
      height={size}
      className="wl-assistant-mascot"
      aria-label={label}
      onError={() => setFailed(true)}
      draggable={false}
    />
  );
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
  taskId: string;
  taskName: string;
  levelLabel: string;
  gateLabel: string;
  scopeNote: string;
  /** 진단 이유 질문 시에만 포함되는 Factor 상세 (데이터 최소화) */
  factorNote?: string;
}

/** 진단 이유를 묻는 질문인지 판단 (Factor 상세 정보 필요 여부) */
function needsFactorDetail(question: string): boolean {
  return /왜|이유|근거|어떻게.*판정|판정.*근거|factor|팩터/ui.test(question);
}

async function readScreenContext(question?: string): Promise<ScreenContext | null> {
  try {
    const { state } = await loadAxState();
    const task = state.tasks.find((candidate) => candidate.id === state.selectedTaskId) ?? null;
    const diagnosis = task?.diagnosis;
    if (!task || !diagnosis) return null;
    const level = automationLevel(diagnosis);
    const gate = executionGate(diagnosis);
    const summary = planSummary(diagnosis);
    const context: ScreenContext = {
      taskId: task.id,
      taskName: task.name,
      levelLabel: level.label,
      gateLabel: GATE_LABELS[gate],
      scopeNote: `이번 구현 ${summary.include.length}건 · 담당자 수행 유지 ${summary.humanKept.length}건 · 현재 자동화 제외 ${summary.excluded.length}건`,
    };
    // 진단 이유 질문 시 Factor 6종 평가값과 근거를 최소 범위로 포함
    if (question && needsFactorDetail(question)) {
      const { FACTOR_LABELS } = await import("@/lib/ax/schema");
      const factorDetails = diagnosis.factors.map((f) => {
        const label = FACTOR_LABELS[f.key as keyof typeof FACTOR_LABELS] ?? f.key;
        const value = f.finalValue ?? f.aiValue;
        const rationale = f.rationale ? ` (${f.rationale.slice(0, 80)})` : "";
        return `${label} ${value}점${rationale}`;
      }).join(" · ");
      context.factorNote = factorDetails;
    }
    return context;
  } catch {
    return null;
  }
}

interface AssistantApiResult {
  answer: string;
  sources: AssistantSource[];
  relatedScreens: AssistantSource[];
  kind: string;
  clarify?: { clarifyId: string; originalQuestion: string; options: string[] };
}

async function askAssistant(
  question: string,
  context: ScreenContext | null,
  clarify: { clarifyId: string; originalQuestion: string; options: string[] } | null,
  followUpOf: string | null,
  signal: AbortSignal,
): Promise<AssistantApiResult> {
  const response = await fetch("/api/assistant", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      ...(context ? { context } : {}),
      ...(clarify ? { clarify } : {}),
      ...(followUpOf ? { followUpOf } : {}),
    }),
    signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = (payload as { error?: { code?: string } } | null)?.error?.code;
    if (code === "AI_RATE_LIMITED") throw new Error("요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
    throw new Error("지금은 응답할 수 없습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.");
  }
  const data = (payload as { data?: { answer?: unknown; sources?: unknown; relatedScreens?: unknown; kind?: unknown; clarify?: unknown } } | null)?.data;
  if (!data || typeof data.answer !== "string") throw new Error("응답 형식이 올바르지 않습니다. 다시 시도해 주세요.");
  const toSources = (value: unknown): AssistantSource[] => Array.isArray(value)
    ? value.filter((source): source is AssistantSource =>
      !!source && typeof source === "object" && typeof (source as AssistantSource).screen === "string")
    : [];
  const toClarify = (value: unknown): AssistantApiResult["clarify"] => {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.clarifyId !== "string" || typeof record.originalQuestion !== "string" || !Array.isArray(record.options)) return undefined;
    return { clarifyId: record.clarifyId, originalQuestion: record.originalQuestion, options: record.options.filter((o): o is string => typeof o === "string") };
  };
  return {
    answer: data.answer,
    sources: toSources(data.sources),
    relatedScreens: toSources(data.relatedScreens),
    kind: typeof data.kind === "string" ? data.kind : "answer",
    clarify: toClarify(data.clarify),
  };
}

export function AssistantWidget() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<AssistantMessage[]>([
    { id: nextId(), role: "assistant", text: "안녕하세요! 렌즈봇입니다.\n업무 분석, 자동화 진단, 기능 사용 방법 등\n무엇이든 질문해 주세요.", greeting: true },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  /** Monotonic request id: each send() owns its pending message; stale responses are ignored. */
  const requestSeqRef = useRef(0);
  /** Pending clarification the next user message may resolve ("첫 번째요"). */
  const clarifyRef = useRef<{ clarifyId: string; originalQuestion: string; options: string[] } | null>(null);
  /** Last user question for follow-up understanding. Cleared on conversation reset. */
  const lastQuestionRef = useRef<string | null>(null);
  /** Task-data consent pending for a specific question. Stores the task id at request time. */
  const consentRef = useRef<{ question: string; taskId: string | null } | null>(null);
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

  const send = useCallback(async (rawQuestion: string, withContext: boolean = false) => {
    const question = rawQuestion.trim();
    if (!question || loading || question.length > MAX_QUESTION_CHARS) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = (requestSeqRef.current += 1);
    const timeout = setTimeout(() => controller.abort("timeout"), ASSISTANT_TIMEOUT_MS);
    const pendingId = nextId();
    setMessages((prev) => [...prev, { id: nextId(), role: "user", text: question }, { id: pendingId, role: "assistant", text: "", pending: true }]);
    setInput("");
    setLoading(true);
    // Capture the pending clarification for this request; a new question clears it afterwards.
    const pendingClarify = clarifyRef.current;
    clarifyRef.current = null;
    // Follow-up context: pass the previous question so short follow-ups can be understood.
    // Skip when resolving a clarification (the clarify payload already carries context).
    const followUpOf = pendingClarify ? null : lastQuestionRef.current;
    try {
      const context = withContext ? await readScreenContext(question) : null;
      // If the panel was closed/reset while reading context, drop the stale request.
      if (requestId !== requestSeqRef.current) return;
      const { answer, sources, relatedScreens, kind, clarify } = await askAssistant(question, context, pendingClarify, followUpOf, controller.signal);
      if (requestId !== requestSeqRef.current) return;
      // Remember this question for the next follow-up.
      lastQuestionRef.current = question;
      if (kind === "clarify" && clarify) clarifyRef.current = clarify;
      // Consent: capture the selected task id at request time so acceptConsent can re-validate.
      if (kind === "consent") {
        const consentTaskId = await readScreenContext().then((ctx) => ctx?.taskId ?? null).catch(() => null);
        consentRef.current = { question, taskId: consentTaskId };
      } else consentRef.current = null;
      setMessages((prev) => prev.map((message) =>
        message.id === pendingId
          ? {
              ...message,
              pending: false,
              text: answer,
              sources,
              relatedScreens,
              ...(kind === "clarify" && clarify ? { clarify } : {}),
              ...(kind === "consent" ? { consent: { question } } : {}),
            }
          : message));
    } catch (error) {
      if (requestId !== requestSeqRef.current) return;
      const isAbort = (error as Error)?.name === "AbortError" || controller.signal.aborted;
      const isTimeout = controller.signal.reason === "timeout";
      const text = isTimeout
        ? "응답 시간이 초과되었습니다. 다시 시도해 주세요."
        : isAbort
          ? "요청이 취소되었습니다."
          : error instanceof Error ? error.message : "응답할 수 없습니다.";
      // 타임아웃은 재시도 가능하므로 error를 유지, 사용자 취소는 재시도 불필요
      setMessages((prev) => prev.map((message) =>
        message.id === pendingId ? { ...message, pending: false, text, error: isAbort && !isTimeout ? undefined : question } : message));
    } finally {
      clearTimeout(timeout);
      if (requestId === requestSeqRef.current) {
        setLoading(false);
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    }
  }, [loading]);

  const retry = useCallback((messageId: number, question: string) => {
    // Remove only the specific failed message, not other error messages.
    setMessages((prev) => prev.filter((message) => message.id !== messageId));
    void send(question);
  }, [send]);

  const clearConversation = useCallback(() => {
    controllerRef.current?.abort();
    // Invalidate any in-flight request so its late response cannot touch the new conversation.
    requestSeqRef.current += 1;
    clarifyRef.current = null;
    consentRef.current = null;
    lastQuestionRef.current = null;
    setMessages([{ id: nextId(), role: "assistant", text: "안녕하세요! 렌즈봇입니다.\n업무 분석, 자동화 진단, 기능 사용 방법 등\n무엇이든 질문해 주세요.", greeting: true }]);
    setLoading(false);
  }, []);

  const acceptConsent = useCallback(async () => {
    const pending = consentRef.current;
    consentRef.current = null;
    if (!pending) return;
    // Re-validate: the selected task must still be the one the consent was requested for.
    // If the task changed or was deleted, ask again instead of reusing the old consent.
    try {
      const current = await readScreenContext();
      if (!current || current.taskId !== pending.taskId) {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", text: "선택된 업무가 변경되어 진단 정보 사용을 다시 확인합니다. 이 업무의 진단 정보를 사용해 설명할까요?", consent: { question: pending.question } },
        ]);
        // Re-arm consent for the current task.
        consentRef.current = { question: pending.question, taskId: current?.taskId ?? null };
        return;
      }
    } catch {
      // If validation fails, fall through and let send() handle the missing context.
    }
    // Re-send the original question with the selected task's diagnosis data.
    void send(pending.question, true);
  }, [send]);

  const declineConsent = useCallback(() => {
    consentRef.current = null;
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "assistant", text: "진단 정보를 사용하지 않고 일반 정책으로 안내해 드리겠습니다. Level·Gate의 일반적인 의미가 궁금하시면 질문해 주세요." },
    ]);
  }, []);

  if (!mounted) return null;
  return createPortal(
    <div className="wl-assistant-root" data-open={open || undefined}>
      {!open ? (
        <button ref={fabRef} type="button" className="wl-assistant-fab" aria-label="AI 도우미 열기" onClick={() => setOpen(true)}>
          <Mascot size={40} label="AI 도우미 열기" />
        </button>
      ) : (
        <section className="wl-assistant-panel" data-expanded={expanded || undefined} role="dialog" aria-modal="false" aria-label="렌즈봇">
          <header className="wl-assistant-header">
            <Mascot size={48} label="렌즈봇" />
            <span className="wl-assistant-titles">
              <strong>렌즈봇</strong>
            </span>
            <span className="wl-assistant-controls">
              <button type="button" aria-label="대화 초기화" title="대화 초기화" onClick={clearConversation}><RotateCcw aria-hidden="true" /></button>
              <button type="button" aria-label={expanded ? "패널 복원" : "패널 확장"} title={expanded ? "패널 복원" : "패널 확장"} onClick={() => setExpanded((value) => !value)}>
                {expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
              </button>
              <button type="button" aria-label="AI 도우미 닫기" title="AI 도우미 닫기" onClick={() => setOpen(false)}><X aria-hidden="true" /></button>
            </span>
          </header>
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
                {message.role === "assistant" ? (
                  <span className="wl-assistant-avatar" aria-hidden="true">
                    <Mascot size={26} label="" />
                  </span>
                ) : null}
                <div className={`wl-assistant-bubble${message.greeting ? " is-greeting" : ""}`}>
                  {message.pending
                    ? <span className="wl-assistant-typing" aria-label="답변 작성 중"><Loader2 className="wl-spin" aria-hidden="true" /></span>
                    : message.greeting
                      ? <p>{message.text.split("\n").map((line, index) => (
                          <span key={index} className={index === 0 ? "wl-greeting-first" : undefined}>
                            {line}
                            {index < message.text.split("\n").length - 1 ? <br /> : null}
                          </span>
                        ))}</p>
                      : <p>{message.text}</p>}
                  {message.relatedScreens && message.relatedScreens.length ? (
                    <div className="wl-assistant-related">
                      <strong>관련 화면</strong>
                      <ul>{message.relatedScreens.map((source) => <li key={`${source.screen}${source.title}`}>{dedupeScreenPath(source.screen, source.title)}</li>)}</ul>
                    </div>
                  ) : null}
                  {message.sources && message.sources.length ? (
                    <div className="wl-assistant-sources">
                      <strong>참고 근거</strong>
                      <ul>{message.sources.map((source) => <li key={`${source.screen}${source.title}`}>{dedupeScreenPath(source.screen, source.title)}</li>)}</ul>
                    </div>
                  ) : null}
                  {message.consent ? (
                    <div className="wl-assistant-consent" role="group" aria-label="진단 정보 사용 확인">
                      <button type="button" className="wl-assistant-consent-allow" onClick={acceptConsent}>진단 정보 사용</button>
                      <button type="button" className="wl-assistant-consent-deny" onClick={declineConsent}>사용하지 않음</button>
                    </div>
                  ) : null}
                  {message.error ? (
                    <button type="button" className="wl-assistant-retry" onClick={() => retry(message.id, message.error as string)}>
                      <TriangleAlert aria-hidden="true" /> 다시 시도
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          {messages.length <= 2 && !loading ? (
            <div className="wl-assistant-examples" aria-label="예시 질문">
              {EXAMPLE_QUESTIONS.map((question) => (
                <button key={question} type="button" onClick={() => void send(question)}>{question}</button>
              ))}
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
        </section>
      )}
    </div>,
    document.body,
  );
}
